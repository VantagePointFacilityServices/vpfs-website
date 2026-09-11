#!/usr/bin/env node
// Syncs dns/zones/*.yaml (desired state) to Cloudflare — DNS records via
// the standard DNS API, and whole-domain redirects via the Redirect Rules
// (Rulesets) API. See dns/README.md for setup.
//
// Usage:
//   node --env-file=dns/.env dns/sync-dns.mjs                     # dry run (default), all zones
//   node --env-file=dns/.env dns/sync-dns.mjs --zone <domain>      # only that zone's file
//   node --env-file=dns/.env dns/sync-dns.mjs --apply              # actually create/update
//   node --env-file=dns/.env dns/sync-dns.mjs --apply --prune      # also delete DNS records not in the file
//
// --prune only ever affects DNS records, never redirect rules (a zone's
// redirect-rules entrypoint is always replaced wholesale to exactly match
// the `redirects:` list — see syncRedirects below). --prune is dangerous
// on its own terms: it deletes ANY DNS record in the zone not listed in
// that zone's file, including ones set up by hand outside this repo (e.g.
// existing email records). It always prints what it would delete first,
// even in dry-run mode, so review that list carefully before adding --apply.
//
// Every function below takes its dependencies (apiToken, apply/prune flags,
// zones directory) as explicit arguments rather than reading module-level
// globals — that's what lets test/sync-dns.test.js import and exercise
// each one directly, with fetch mocked, instead of only being able to test
// this file by actually running it as a subprocess.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, basename } from "node:path";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ZONES_DIR = join(__dirname, "zones");

export const API_BASE = "https://api.cloudflare.com/client/v4";
const SINGLE_VALUE_TYPES = new Set(["CNAME"]); // only one record allowed per name; everything else can coexist
const REDIRECT_PHASE = "http_request_dynamic_redirect";

export function parseArgs(argv) {
  const zoneArgIndex = argv.indexOf("--zone");
  return {
    apply: argv.includes("--apply"),
    prune: argv.includes("--prune"),
    onlyZone: zoneArgIndex !== -1 ? argv[zoneArgIndex + 1] : null,
  };
}

export async function cf(apiToken, path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare API error on ${options.method || "GET"} ${path}: ${JSON.stringify(body.errors)}`);
  }
  return body;
}

export async function resolveZoneId(apiToken, zoneName) {
  const body = await cf(apiToken, `/zones?name=${encodeURIComponent(zoneName)}`);
  if (!body.result.length) {
    throw new Error(`No Cloudflare zone found for "${zoneName}".`);
  }
  return body.result[0].id;
}

export function loadZoneFiles(zonesDir, onlyZone) {
  const files = readdirSync(zonesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const selected = onlyZone ? files.filter((f) => basename(f, ".yaml").replace(/\.yml$/, "") === onlyZone) : files;
  if (onlyZone && !selected.length) {
    throw new Error(`No zone file found for "${onlyZone}" in ${zonesDir}.`);
  }
  return selected.map((f) => {
    const text = readFileSync(join(zonesDir, f), "utf8");
    const parsed = parseYaml(text) || {};
    return {
      file: f,
      zone: parsed.zone,
      records: (parsed.records || []).map((r) => ({
        type: r.type,
        name: r.name,
        content: String(r.content),
        ttl: r.ttl ?? 1,
        proxied: r.proxied ?? false,
        priority: r.priority,
      })),
      redirects: parsed.redirects || [],
    };
  });
}

// ---- DNS records ----------------------------------------------------

export async function fetchExistingRecords(apiToken, zoneId) {
  const records = [];
  let page = 1;
  for (;;) {
    const body = await cf(apiToken, `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    records.push(...body.result);
    if (page >= body.result_info.total_pages) break;
    page += 1;
  }
  return records;
}

export function sameRecord(desired, existing) {
  if (desired.type !== existing.type || desired.name !== existing.name) return false;
  if (SINGLE_VALUE_TYPES.has(desired.type)) return true; // matched by type+name alone
  return desired.content === existing.content;
}

export function needsUpdate(desired, existing) {
  if (desired.content !== existing.content) return true;
  if (desired.ttl !== existing.ttl) return true;
  if (Boolean(desired.proxied) !== Boolean(existing.proxied)) return true;
  if (desired.priority !== undefined && desired.priority !== existing.priority) return true;
  return false;
}

export async function syncRecords(apiToken, zoneId, desired, { apply = false, prune = false } = {}) {
  const existing = await fetchExistingRecords(apiToken, zoneId);

  const toCreate = [];
  const toUpdate = [];
  const unchanged = [];
  const matchedExistingIds = new Set();

  for (const d of desired) {
    const match = existing.find((e) => !matchedExistingIds.has(e.id) && sameRecord(d, e));
    if (!match) {
      toCreate.push(d);
      continue;
    }
    matchedExistingIds.add(match.id);
    if (needsUpdate(d, match)) {
      toUpdate.push({ id: match.id, desired: d, existing: match });
    } else {
      unchanged.push(d);
    }
  }

  const toDelete = prune ? existing.filter((e) => !matchedExistingIds.has(e.id)) : [];

  console.log(`  DNS records: ${unchanged.length} already correct.`);

  if (toCreate.length) {
    console.log(`  CREATE (${toCreate.length}):`);
    for (const r of toCreate) console.log(`    + ${r.type} ${r.name} -> ${r.content}${r.priority ? ` (priority ${r.priority})` : ""}`);
  }
  if (toUpdate.length) {
    console.log(`  UPDATE (${toUpdate.length}):`);
    for (const { desired: d, existing: e } of toUpdate) console.log(`    ~ ${d.type} ${d.name}: ${e.content} -> ${d.content}`);
  }
  if (prune) {
    console.log(`  DELETE (${toDelete.length})${toDelete.length ? " — review carefully:" : ""}`);
    for (const r of toDelete) console.log(`    - ${r.type} ${r.name} -> ${r.content}`);
  }

  if (!apply) return { toCreate, toUpdate, toDelete };

  for (const r of toCreate) {
    await cf(apiToken, `/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(r) });
    console.log(`  Created ${r.type} ${r.name} -> ${r.content}`);
  }
  for (const { id, desired: r } of toUpdate) {
    await cf(apiToken, `/zones/${zoneId}/dns_records/${id}`, { method: "PUT", body: JSON.stringify(r) });
    console.log(`  Updated ${r.type} ${r.name} -> ${r.content}`);
  }
  for (const r of toDelete) {
    await cf(apiToken, `/zones/${zoneId}/dns_records/${r.id}`, { method: "DELETE" });
    console.log(`  Deleted ${r.type} ${r.name} -> ${r.content}`);
  }

  return { toCreate, toUpdate, toDelete };
}

// ---- Redirect rules ---------------------------------------------------
// The phase entrypoint is a single ordered list — PUT always replaces the
// whole thing, so "sync" here just means "make it exactly match redirects:".
// https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/
// https://developers.cloudflare.com/ruleset-engine/rulesets-api/update/

export function toRedirectRule(r) {
  return {
    expression: r.expression,
    description: r.description || "",
    action: "redirect",
    action_parameters: {
      from_value: {
        target_url: { expression: r.target_expression },
        status_code: r.status_code ?? 301,
        preserve_query_string: r.preserve_query_string ?? true,
      },
    },
  };
}

export async function fetchCurrentRedirectRules(apiToken, zoneId) {
  const res = await fetch(`${API_BASE}/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (res.status === 404) return []; // no entrypoint ruleset exists yet for this phase
  const body = await res.json();
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare API error fetching redirect rules: ${JSON.stringify(body.errors)}`);
  }
  return body.result.rules || [];
}

export function rulesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function syncRedirects(apiToken, zoneId, desired, { apply = false } = {}) {
  const desiredRules = desired.map(toRedirectRule);
  const currentRules = await fetchCurrentRedirectRules(apiToken, zoneId);

  // Compare ignoring fields Cloudflare adds server-side (id, ref, version, last_updated).
  const currentComparable = currentRules.map(({ expression, description, action, action_parameters }) => ({
    expression,
    description,
    action,
    action_parameters,
  }));

  if (rulesEqual(desiredRules, currentComparable)) {
    console.log(`  Redirect rules: ${desiredRules.length} already correct.`);
    return { changed: false };
  }

  console.log(`  Redirect rules: replacing ${currentRules.length} existing rule(s) with ${desiredRules.length} desired rule(s):`);
  for (const r of desired) console.log(`    -> ${r.description || r.expression} (${r.status_code ?? 301})`);

  if (!apply) return { changed: true, applied: false };

  await cf(apiToken, `/zones/${zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, {
    method: "PUT",
    body: JSON.stringify({ rules: desiredRules }),
  });
  console.log("  Redirect rules updated.");
  return { changed: true, applied: true };
}

// ---- Main ---------------------------------------------------------------

export async function main(argv, env, zonesDir = DEFAULT_ZONES_DIR) {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "Missing CLOUDFLARE_API_TOKEN. Copy dns/.env.example to dns/.env, fill it in, and run with --env-file=dns/.env."
    );
  }

  const { apply, prune, onlyZone } = parseArgs(argv);
  const zones = loadZoneFiles(zonesDir, onlyZone);

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN (pass --apply to make changes)"}${prune ? " + PRUNE" : ""}\n`);

  for (const z of zones) {
    console.log(`=== ${z.zone} (${z.file}) ===`);
    const zoneId = await resolveZoneId(apiToken, z.zone);
    await syncRecords(apiToken, zoneId, z.records, { apply, prune });
    await syncRedirects(apiToken, zoneId, z.redirects, { apply });
    console.log("");
  }

  if (!apply) {
    console.log("Dry run only — no changes made. Re-run with --apply to execute the plan above.");
  } else {
    console.log("Done.");
  }
}

// Only run when executed directly (`node sync-dns.mjs`), not when imported
// by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
