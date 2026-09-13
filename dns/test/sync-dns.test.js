import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  cf,
  resolveZoneId,
  loadZoneFiles,
  fetchExistingRecords,
  sameRecord,
  needsUpdate,
  syncRecords,
  toRedirectRule,
  fetchCurrentRedirectRules,
  rulesEqual,
  syncRedirects,
  main,
  API_BASE,
  DEFAULT_ZONES_DIR,
} from "../sync-dns.mjs";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("defaults to dry run, no prune, all zones", () => {
    expect(parseArgs([])).toEqual({ apply: false, prune: false, onlyZone: null });
  });

  it("parses --apply and --prune", () => {
    expect(parseArgs(["--apply", "--prune"])).toEqual({ apply: true, prune: true, onlyZone: null });
  });

  it("parses --zone with its value", () => {
    expect(parseArgs(["--zone", "example.com"])).toEqual({ apply: false, prune: false, onlyZone: "example.com" });
  });
});

describe("loadZoneFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "dns-zones-"));

  writeFileSync(
    join(dir, "example.com.yaml"),
    `
zone: example.com
records:
  - type: A
    name: example.com
    content: 192.0.2.1
    proxied: true
redirects:
  - description: "test"
    expression: 'http.host eq "example.com"'
    target_expression: 'concat("https://elsewhere.com", http.request.uri.path)'
`
  );
  writeFileSync(
    join(dir, "other.com.yaml"),
    `
zone: other.com
records: []
`
  );

  it("loads every zone file in the directory", () => {
    const zones = loadZoneFiles(dir, null);
    expect(zones.map((z) => z.zone).sort()).toEqual(["example.com", "other.com"]);
  });

  it("applies record defaults (ttl, proxied) and preserves declared values", () => {
    const [zone] = loadZoneFiles(dir, "example.com");
    expect(zone.records).toEqual([
      { type: "A", name: "example.com", content: "192.0.2.1", ttl: 1, proxied: true, priority: undefined },
    ]);
    expect(zone.redirects).toHaveLength(1);
  });

  it("defaults records/redirects to empty arrays when absent", () => {
    const [zone] = loadZoneFiles(dir, "other.com");
    expect(zone.records).toEqual([]);
    expect(zone.redirects).toEqual([]);
  });

  it("filters to a single zone with --zone", () => {
    const zones = loadZoneFiles(dir, "other.com");
    expect(zones).toHaveLength(1);
    expect(zones[0].zone).toBe("other.com");
  });

  it("throws for an unknown --zone", () => {
    expect(() => loadZoneFiles(dir, "nope.com")).toThrow(/No zone file found for "nope.com"/);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("loadZoneFiles — file-extension and empty-content edge cases", () => {
  const dir = mkdtempSync(join(tmpdir(), "dns-zones-edge-"));

  writeFileSync(join(dir, "yml-ext.yml"), "zone: yml-ext.example\nrecords: []\n");
  writeFileSync(join(dir, "not-a-zone.md"), "# not a zone file, must be ignored\n");
  writeFileSync(join(dir, "blank.yaml"), "   \n"); // parses to null, not an object
  writeFileSync(join(dir, "no-records.example.yaml"), "zone: no-records.example\n"); // no records: key at all

  it("picks up .yml as well as .yaml, and ignores non-YAML files", () => {
    const zones = loadZoneFiles(dir, null);
    const names = zones.map((z) => z.zone).sort();
    expect(names).toEqual(["no-records.example", "yml-ext.example", undefined].sort()); // blank.yaml has no `zone:` key
  });

  it("treats a blank YAML file as an empty zone rather than throwing", () => {
    const zones = loadZoneFiles(dir, null);
    const blank = zones.find((z) => z.zone === undefined);
    expect(blank.records).toEqual([]);
    expect(blank.redirects).toEqual([]);
  });

  it("defaults records to [] when the key is missing entirely, not just empty", () => {
    const [zone] = loadZoneFiles(dir, "no-records.example");
    expect(zone.records).toEqual([]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});

describe("loadZoneFiles against the real zones/ directory", () => {
  // Doubles as a regression check that the committed zone files stay parseable.
  it("parses both real zone files", () => {
    const zones = loadZoneFiles(DEFAULT_ZONES_DIR, null);
    const names = zones.map((z) => z.zone).sort();
    expect(names).toEqual(["vantagepointfacilityservices.com", "vantagepointfacilityservices.com.au"]);
  });
});

describe("sameRecord", () => {
  it("matches CNAME by type+name alone, ignoring content", () => {
    const desired = { type: "CNAME", name: "www.example.com", content: "a.example.com" };
    const existing = { type: "CNAME", name: "www.example.com", content: "b.example.com" };
    expect(sameRecord(desired, existing)).toBe(true);
  });

  it("requires matching content for A records (multi-value types)", () => {
    const desired = { type: "A", name: "example.com", content: "192.0.2.1" };
    expect(sameRecord(desired, { type: "A", name: "example.com", content: "192.0.2.1" })).toBe(true);
    expect(sameRecord(desired, { type: "A", name: "example.com", content: "192.0.2.2" })).toBe(false);
  });

  it("never matches across different types or names", () => {
    const desired = { type: "A", name: "example.com", content: "192.0.2.1" };
    expect(sameRecord(desired, { type: "AAAA", name: "example.com", content: "192.0.2.1" })).toBe(false);
    expect(sameRecord(desired, { type: "A", name: "other.com", content: "192.0.2.1" })).toBe(false);
  });
});

describe("needsUpdate", () => {
  const base = { content: "192.0.2.1", ttl: 1, proxied: false, priority: undefined };

  it("is false when nothing differs", () => {
    expect(needsUpdate(base, { ...base })).toBe(false);
  });

  it("is true on content, ttl, proxied, or priority differences", () => {
    expect(needsUpdate(base, { ...base, content: "192.0.2.2" })).toBe(true);
    expect(needsUpdate(base, { ...base, ttl: 300 })).toBe(true);
    expect(needsUpdate(base, { ...base, proxied: true })).toBe(true);
    expect(needsUpdate({ ...base, priority: 10 }, { ...base, priority: 20 })).toBe(true);
  });

  it("ignores existing priority when desired doesn't declare one", () => {
    expect(needsUpdate(base, { ...base, priority: 10 })).toBe(false);
  });
});

describe("toRedirectRule", () => {
  it("applies default status_code and preserve_query_string", () => {
    const rule = toRedirectRule({
      description: "redirect",
      expression: 'http.host eq "example.com"',
      target_expression: 'concat("https://elsewhere.com", http.request.uri.path)',
    });
    expect(rule).toEqual({
      expression: 'http.host eq "example.com"',
      description: "redirect",
      action: "redirect",
      action_parameters: {
        from_value: {
          target_url: { expression: 'concat("https://elsewhere.com", http.request.uri.path)' },
          status_code: 301,
          preserve_query_string: true,
        },
      },
    });
  });

  it("respects explicit status_code and preserve_query_string", () => {
    const rule = toRedirectRule({
      expression: "true",
      target_expression: '"https://elsewhere.com"',
      status_code: 302,
      preserve_query_string: false,
    });
    expect(rule.action_parameters.from_value.status_code).toBe(302);
    expect(rule.action_parameters.from_value.preserve_query_string).toBe(false);
  });
});

describe("rulesEqual", () => {
  it("is true for deep-equal arrays regardless of object identity", () => {
    expect(rulesEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
  });

  it("is false when contents differ", () => {
    expect(rulesEqual([{ a: 1 }], [{ a: 2 }])).toBe(false);
  });

  it("is true when nested object keys are in a different order", () => {
    // Reproduces what Cloudflare actually returns: action_parameters.from_value
    // comes back with keys reordered relative to what toRedirectRule builds.
    const built = [{ a: { x: 1, y: 2, z: 3 } }];
    const fromApi = [{ a: { z: 3, x: 1, y: 2 } }];
    expect(rulesEqual(built, fromApi)).toBe(true);
  });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("cf", () => {
  it("returns the parsed body on success", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [] }));
    const body = await cf("token", "/zones");
    expect(body).toEqual({ success: true, result: [] });
    expect(global.fetch).toHaveBeenCalledWith(
      `${API_BASE}/zones`,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) })
    );
  });

  it("throws on a non-ok response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: false, errors: ["bad"] }, 400));
    await expect(cf("token", "/zones")).rejects.toThrow(/Cloudflare API error/);
  });

  it("throws when success is false even with a 200 status", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: false, errors: ["nope"] }, 200));
    await expect(cf("token", "/zones")).rejects.toThrow(/Cloudflare API error/);
  });
});

describe("resolveZoneId", () => {
  it("returns the id of the first matching zone", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [{ id: "zone123" }] }));
    await expect(resolveZoneId("token", "example.com")).resolves.toBe("zone123");
  });

  it("throws when no zone matches", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [] }));
    await expect(resolveZoneId("token", "example.com")).rejects.toThrow(/No Cloudflare zone found/);
  });
});

describe("fetchExistingRecords", () => {
  it("concatenates every page", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "1" }], result_info: { total_pages: 2 } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "2" }], result_info: { total_pages: 2 } })
      );
    const records = await fetchExistingRecords("token", "zone123");
    expect(records).toEqual([{ id: "1" }, { id: "2" }]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchCurrentRedirectRules", () => {
  it("returns an empty array when no entrypoint ruleset exists (404)", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(fetchCurrentRedirectRules("token", "zone123")).resolves.toEqual([]);
  });

  it("returns the rules array on success", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: { rules: [{ id: "r1" }] } }));
    await expect(fetchCurrentRedirectRules("token", "zone123")).resolves.toEqual([{ id: "r1" }]);
  });

  it("throws on an error response", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: false, errors: ["bad"] }, 500));
    await expect(fetchCurrentRedirectRules("token", "zone123")).rejects.toThrow(/Cloudflare API error/);
  });

  it("defaults to an empty array when result.rules is missing", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: {} }));
    await expect(fetchCurrentRedirectRules("token", "zone123")).resolves.toEqual([]);
  });
});

describe("syncRecords", () => {
  const desired = [{ type: "A", name: "example.com", content: "192.0.2.1", ttl: 1, proxied: false }];

  it("plans a CREATE and does not call the API in dry-run mode", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }));
    const plan = await syncRecords("token", "zone123", desired, { apply: false });
    expect(plan.toCreate).toEqual(desired);
    // Only the one GET to fetch existing records — no POST/PUT/DELETE.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("creates missing records when apply is true", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "new" } }));
    await syncRecords("token", "zone123", desired, { apply: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [, postOptions] = global.fetch.mock.calls[1];
    expect(postOptions.method).toBe("POST");
  });

  it("creates a new A record rather than updating one with different content (multi-value type)", async () => {
    // A allows several values at the same name, so a content mismatch means
    // "this exact value is missing" (CREATE), not "update the existing one" —
    // there'd be no principled way to pick which of several existing A
    // records a content-differing desired one should overwrite.
    const existing = { id: "abc", type: "A", name: "example.com", content: "192.0.2.99", ttl: 1, proxied: false };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [existing], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "new" } }));
    const plan = await syncRecords("token", "zone123", desired, { apply: true });
    expect(plan.toCreate).toEqual(desired);
    expect(plan.toUpdate).toHaveLength(0);
  });

  it("updates an A record in place when only ttl/proxied differ (content matches)", async () => {
    const existing = { id: "abc", type: "A", name: "example.com", content: "192.0.2.1", ttl: 300, proxied: true };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [existing], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const plan = await syncRecords("token", "zone123", desired, { apply: true });
    expect(plan.toUpdate).toHaveLength(1);
    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe(`${API_BASE}/zones/zone123/dns_records/abc`);
    expect(options.method).toBe("PUT");
  });

  it("updates a CNAME in place when its content differs (single-value type)", async () => {
    const cnameDesired = [{ type: "CNAME", name: "www.example.com", content: "new-target.example.com", ttl: 1, proxied: false }];
    const existing = { id: "abc", type: "CNAME", name: "www.example.com", content: "old-target.example.com", ttl: 1, proxied: false };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [existing], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const plan = await syncRecords("token", "zone123", cnameDesired, { apply: true });
    expect(plan.toUpdate).toHaveLength(1);
    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe(`${API_BASE}/zones/zone123/dns_records/abc`);
    expect(options.method).toBe("PUT");
    expect(JSON.parse(options.body).content).toBe("new-target.example.com");
  });

  it("leaves an already-correct record alone", async () => {
    const existing = { id: "abc", type: "A", name: "example.com", content: "192.0.2.1", ttl: 1, proxied: false };
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: [existing], result_info: { total_pages: 1 } }));
    const plan = await syncRecords("token", "zone123", desired, { apply: true });
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toUpdate).toHaveLength(0);
    expect(global.fetch).toHaveBeenCalledTimes(1); // just the initial fetch, nothing written
  });

  it("only deletes unmatched records when both apply and prune are set", async () => {
    const stray = { id: "stray", type: "TXT", name: "example.com", content: "leftover" };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [stray], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "new" } })) // create the desired A record
      .mockResolvedValueOnce(jsonResponse({ success: true })); // delete the stray TXT

    const plan = await syncRecords("token", "zone123", desired, { apply: true, prune: true });
    expect(plan.toDelete).toEqual([stray]);
    const deleteCall = global.fetch.mock.calls.find(([, options]) => options?.method === "DELETE");
    expect(deleteCall[0]).toBe(`${API_BASE}/zones/zone123/dns_records/stray`);
  });

  it("does not delete unmatched records when prune is false, even with apply", async () => {
    const stray = { id: "stray", type: "TXT", name: "example.com", content: "leftover" };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [stray], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "new" } }));
    const plan = await syncRecords("token", "zone123", desired, { apply: true, prune: false });
    expect(plan.toDelete).toEqual([]);
    expect(global.fetch.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });

  it("logs an empty DELETE list when prune is true but nothing is unmatched", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "new" } }));
    const plan = await syncRecords("token", "zone123", desired, { apply: true, prune: true });
    expect(plan.toDelete).toEqual([]);
  });

  it("includes priority in the CREATE plan and log line for MX records", async () => {
    const mxDesired = [{ type: "MX", name: "example.com", content: "smtp.example.com", ttl: 1, proxied: false, priority: 10 }];
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: { id: "new" } }));
    const plan = await syncRecords("token", "zone123", mxDesired, { apply: true });
    expect(plan.toCreate[0].priority).toBe(10);
    const [, postOptions] = global.fetch.mock.calls[1];
    expect(JSON.parse(postOptions.body).priority).toBe(10);
  });
});

describe("syncRedirects", () => {
  const desired = [
    {
      description: "redirect",
      expression: 'http.host eq "example.com"',
      target_expression: 'concat("https://elsewhere.com", http.request.uri.path)',
    },
  ];

  it("reports no change and does not PUT when already correct", async () => {
    const existingRule = toRedirectRule(desired[0]);
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ success: true, result: { rules: [existingRule] } }));
    const result = await syncRedirects("token", "zone123", desired, { apply: true });
    expect(result).toEqual({ changed: false });
    expect(global.fetch).toHaveBeenCalledTimes(1); // just the GET, no PUT
  });

  it("reports a pending change but does not PUT in dry-run mode", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const result = await syncRedirects("token", "zone123", desired, { apply: false });
    expect(result).toEqual({ changed: true, applied: false });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("PUTs the full rule list when apply is true and rules differ", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await syncRedirects("token", "zone123", desired, { apply: true });
    expect(result).toEqual({ changed: true, applied: true });
    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe(`${API_BASE}/zones/zone123/rulesets/phases/http_request_dynamic_redirect/entrypoint`);
    expect(options.method).toBe("PUT");
    expect(JSON.parse(options.body).rules).toEqual(desired.map(toRedirectRule));
  });

  it("falls back to the expression in the change log when description is missing", async () => {
    const noDescription = [
      {
        expression: 'http.host eq "example.com"',
        target_expression: '"https://elsewhere.com"',
      },
    ];
    global.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const result = await syncRedirects("token", "zone123", noDescription, { apply: false });
    expect(result.changed).toBe(true);
  });
});

describe("main", () => {
  const dir = mkdtempSync(join(tmpdir(), "dns-main-"));
  writeFileSync(
    join(dir, "example.com.yaml"),
    `
zone: example.com
records:
  - type: A
    name: example.com
    content: 192.0.2.1
redirects: []
`
  );

  it("throws when CLOUDFLARE_API_TOKEN is missing", async () => {
    await expect(main([], {}, dir)).rejects.toThrow(/Missing CLOUDFLARE_API_TOKEN/);
  });

  it("runs a full dry run across a zone directory without making any writes", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/zones?name=")) return Promise.resolve(jsonResponse({ success: true, result: [{ id: "zone123" }] }));
      if (u.includes("/dns_records")) return Promise.resolve(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }));
      if (u.includes("/rulesets/phases/")) return Promise.resolve(new Response("not found", { status: 404 }));
      throw new Error(`Unexpected fetch: ${u}`);
    });

    await main([], { CLOUDFLARE_API_TOKEN: "token" }, dir);

    expect(global.fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    expect(global.fetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  });

  it("applies changes across a zone directory when --apply is passed", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/zones?name=")) return Promise.resolve(jsonResponse({ success: true, result: [{ id: "zone123" }] }));
      if (u.includes("/dns_records") && !String(url).match(/dns_records\/.+/)) {
        return Promise.resolve(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }));
      }
      if (u.includes("/rulesets/phases/")) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(jsonResponse({ success: true, result: { id: "new" } }));
    });

    await main(["--apply"], { CLOUDFLARE_API_TOKEN: "token" }, dir);

    expect(global.fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true);
  });

  it("passes --prune through to a full apply run", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/zones?name=")) return Promise.resolve(jsonResponse({ success: true, result: [{ id: "zone123" }] }));
      if (u.includes("/dns_records") && !String(url).match(/dns_records\/.+/)) {
        return Promise.resolve(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }));
      }
      if (u.includes("/rulesets/phases/")) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(jsonResponse({ success: true, result: { id: "new" } }));
    });

    await expect(main(["--apply", "--prune"], { CLOUDFLARE_API_TOKEN: "token" }, dir)).resolves.not.toThrow();
  });

  it("scopes to a single zone with --zone", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.includes("/zones?name=")) return Promise.resolve(jsonResponse({ success: true, result: [{ id: "zone123" }] }));
      if (u.includes("/dns_records")) return Promise.resolve(jsonResponse({ success: true, result: [], result_info: { total_pages: 1 } }));
      if (u.includes("/rulesets/phases/")) return Promise.resolve(new Response("not found", { status: 404 }));
      throw new Error(`Unexpected fetch: ${u}`);
    });

    await main(["--zone", "example.com"], { CLOUDFLARE_API_TOKEN: "token" }, dir);
    expect(global.fetch).toHaveBeenCalled();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
});
