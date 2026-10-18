import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker, { signBookingToken, verifyBookingToken, calendarIdForTier } from "../worker.js";

const env = { GHL_VPFS_API_KEY: "test-key", GHL_VPFS_LOCATION_ID: "loc-123" };

function makeRequest(path, body, { method = "POST", headers } = {}) {
  const init = { method };
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  if (headers) init.headers = headers;
  return new Request(`https://example.com${path}`, init);
}

const ALLOWED_ORIGIN = "https://www.vantagepointfacilityservices.com.au";

function mockGhlOk() {
  return vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
}

function fieldsFromLastCall(fetchMock) {
  const [, options] = fetchMock.mock.calls.at(-1);
  const sentBody = JSON.parse(options.body);
  return Object.fromEntries(sentBody.customFields.map((f) => [f.key, f.field_value]));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("routing and request validation", () => {
  it("rejects non-POST requests", async () => {
    const res = await worker.fetch(makeRequest("/gate", null, { method: "GET" }), env);
    expect(res.status).toBe(405);
  });

  it("rejects invalid JSON", async () => {
    const res = await worker.fetch(makeRequest("/gate", "not json"), env);
    expect(res.status).toBe(400);
  });

  it("requires contact_id", async () => {
    const res = await worker.fetch(makeRequest("/gate", {}), env);
    expect(res.status).toBe(400);
  });

  it("404s on an unknown route", async () => {
    const res = await worker.fetch(makeRequest("/nope", { contact_id: "abc" }), env);
    expect(res.status).toBe(404);
  });
});

// /lead makes two GHL calls: an upsert (returns { new, contact }), then an
// additive tag call on the resulting contact id.
function mockLeadGhl(contactId, { isNew = true } = {}) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ new: isNew, contact: { id: contactId } }), { status: 200 })
    )
    .mockResolvedValueOnce(new Response("{}", { status: 200 }));
}

function upsertBody(fetchMock) {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe("POST /lead", () => {
  it("upserts the GHL contact and returns its contact_id", async () => {
    global.fetch = mockLeadGhl("new-contact-1");

    const req = makeRequest("/lead", {
      first_name: "Alex",
      last_name: "Rowe",
      email: "alex@example.com",
      phone: "0400000000",
      conversion_page: "website-homepage",
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.contact_id).toBe("new-contact-1");

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/upsert");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer test-key");

    const sentBody = JSON.parse(options.body);
    expect(sentBody.firstName).toBe("Alex");
    expect(sentBody.lastName).toBe("Rowe");
    expect(sentBody.email).toBe("alex@example.com");
    expect(sentBody.phone).toBe("0400000000");
  });

  it("sends a trimmed company_name as companyName on the upsert", async () => {
    global.fetch = mockLeadGhl("c-1");
    await worker.fetch(
      makeRequest("/lead", { email: "a@example.com", phone: "0400000000", company_name: "  Acme Pty Ltd  " }),
      env
    );
    expect(upsertBody(global.fetch).companyName).toBe("Acme Pty Ltd");
  });

  it.each([undefined, "", "   "])("omits companyName and still succeeds when company_name is %j", async (name) => {
    global.fetch = mockLeadGhl("c-2");
    const res = await worker.fetch(
      makeRequest("/lead", { email: "a@example.com", phone: "0400000000", company_name: name }),
      env
    );
    expect((await res.json()).contact_id).toBe("c-2");
    expect(upsertBody(global.fetch)).not.toHaveProperty("companyName");
  });

  it("rejects a 201-character company_name with 400 and no GHL call", async () => {
    global.fetch = vi.fn();
    const res = await worker.fetch(
      makeRequest("/lead", { email: "a@example.com", phone: "0400000000", company_name: "a".repeat(201) }),
      env
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("company_name_too_long");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends the sub-account's locationId on the upsert", async () => {
    global.fetch = mockLeadGhl("new-contact-1");

    await worker.fetch(
      makeRequest("/lead", { email: "alex@example.com", phone: "0400000000" }),
      env
    );

    expect(upsertBody(global.fetch).locationId).toBe("loc-123");
  });

  it("returns the existing contact's id when the visitor is already in GHL", async () => {
    global.fetch = mockLeadGhl("existing-contact-9", { isNew: false });

    const res = await worker.fetch(
      makeRequest("/lead", { email: "repeat@example.com", phone: "0400000000" }),
      env
    );
    const json = await res.json();

    expect(json.contact_id).toBe("existing-contact-9");
  });

  it("adds the website-lead tag to the contact via the additive tags endpoint", async () => {
    global.fetch = mockLeadGhl("new-contact-4");

    await worker.fetch(
      makeRequest("/lead", { email: "alex@example.com", phone: "0400000000" }),
      env
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/new-contact-4/tags");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(options.body)).toEqual({ tags: ["website-lead"] });
  });

  it("never sends tags on the upsert itself, so existing tags aren't overwritten", async () => {
    global.fetch = mockLeadGhl("new-contact-5");

    await worker.fetch(
      makeRequest("/lead", { email: "alex@example.com", phone: "0400000000" }),
      env
    );

    expect(upsertBody(global.fetch)).not.toHaveProperty("tags");
  });

  it("still returns the contact_id when the tag call fails", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ new: true, contact: { id: "new-contact-6" } }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("tag error", { status: 500 }));

    const res = await worker.fetch(
      makeRequest("/lead", { email: "alex@example.com", phone: "0400000000" }),
      env
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.contact_id).toBe("new-contact-6");
  });

  it("writes conversion_page as a custom field on the contact", async () => {
    global.fetch = mockLeadGhl("new-contact-2");

    const req = makeRequest("/lead", {
      first_name: "Jamie",
      last_name: "Lee",
      email: "jamie@example.com",
      phone: "0411111111",
      conversion_page: "website-contact",
    });

    await worker.fetch(req, env);

    const field = upsertBody(global.fetch).customFields.find((f) => f.key === "conversion_page");
    expect(field.field_value).toBe("website-contact");
  });

  it("writes lead_channel derived from the click id, and never stores the click id or referrer", async () => {
    global.fetch = mockLeadGhl("new-contact-lc");

    await worker.fetch(
      makeRequest("/lead", {
        email: "alex@example.com",
        phone: "0400000000",
        gclid: "abc",
        referrer_host: "www.google.com",
      }),
      env
    );

    const fields = Object.fromEntries(
      upsertBody(global.fetch).customFields.map((f) => [f.key, f.field_value])
    );
    expect(fields.lead_channel).toBe("paid_search");
    expect(fields).not.toHaveProperty("gclid");
    expect(fields).not.toHaveProperty("referrer_host");
  });

  it("writes lead_channel: organic_search for a Google referrer with no tags", async () => {
    global.fetch = mockLeadGhl("new-contact-lc2");

    await worker.fetch(
      makeRequest("/lead", { email: "a@example.com", phone: "0400000000", referrer_host: "www.google.com.au" }),
      env
    );

    const field = upsertBody(global.fetch).customFields.find((f) => f.key === "lead_channel");
    expect(field.field_value).toBe("organic_search");
  });

  it("writes lead_channel: direct when nothing says how they arrived", async () => {
    global.fetch = mockLeadGhl("new-contact-lc3");

    await worker.fetch(makeRequest("/lead", { email: "a@example.com", phone: "0400000000" }), env);

    const field = upsertBody(global.fetch).customFields.find((f) => f.key === "lead_channel");
    expect(field.field_value).toBe("direct");
  });

  it("sends postcode as a custom field", async () => {
    global.fetch = mockLeadGhl("new-contact-3");

    const req = makeRequest("/lead", {
      first_name: "Sam",
      last_name: "Taylor",
      email: "sam@example.com",
      phone: "0400000000",
      postcode: "4211",
      conversion_page: "website-homepage",
    });

    await worker.fetch(req, env);

    const postcodeField = upsertBody(global.fetch).customFields.find((f) => f.key === "postcode");
    expect(postcodeField.field_value).toBe("4211");
  });

  it("sends marketing_consent Yes plus an ISO timestamp when consent is true", async () => {
    global.fetch = mockLeadGhl("c-consent");
    await worker.fetch(
      makeRequest("/lead", { email: "a@example.com", phone: "0400000000", marketing_consent: true }),
      env
    );
    const fields = Object.fromEntries(
      upsertBody(global.fetch).customFields.map((f) => [f.key, f.field_value])
    );
    expect(fields.marketing_consent).toBe("Yes");
    expect(new Date(fields.marketing_consent_at).toISOString()).toBe(fields.marketing_consent_at);
  });

  it.each([[false], [undefined], ["true"], ["on"], [1]])(
    "sends neither consent field when marketing_consent is %j",
    async (value) => {
      global.fetch = mockLeadGhl("c-noconsent");
      const body = { email: "a@example.com", phone: "0400000000" };
      if (value !== undefined) body.marketing_consent = value;
      const res = await worker.fetch(makeRequest("/lead", body), env);
      expect((await res.json()).contact_id).toBe("c-noconsent");
      const keys = upsertBody(global.fetch).customFields.map((f) => f.key);
      expect(keys).not.toContain("marketing_consent");
      expect(keys).not.toContain("marketing_consent_at");
      expect(global.fetch).toHaveBeenCalledTimes(2);
    }
  );

  it("writes utm params as custom fields and omits ones that weren't sent", async () => {
    global.fetch = mockLeadGhl("new-contact-7");

    await worker.fetch(
      makeRequest("/lead", {
        email: "alex@example.com",
        phone: "0400000000",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "office-gc",
      }),
      env
    );

    const fields = Object.fromEntries(
      upsertBody(global.fetch).customFields.map((f) => [f.key, f.field_value])
    );
    expect(fields.utm_source).toBe("google");
    expect(fields.utm_medium).toBe("cpc");
    expect(fields.utm_campaign).toBe("office-gc");
    expect(fields).not.toHaveProperty("utm_term");
    expect(fields).not.toHaveProperty("utm_content");
  });

  it("does not call the GHL API when the honeypot field is filled", async () => {
    global.fetch = vi.fn();

    const req = makeRequest("/lead", {
      first_name: "Bot",
      last_name: "Bot",
      email: "bot@example.com",
      phone: "0400000000",
      url: "http://spam.example.com",
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(json.contact_id).toBeNull();
  });

  it("rejects a submission missing email or phone", async () => {
    const req = makeRequest("/lead", {
      first_name: "Alex",
      last_name: "Rowe",
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(400);
  });

  it("surfaces a failed GHL upsert without throwing or tagging", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));

    const req = makeRequest("/lead", {
      first_name: "Alex",
      last_name: "Rowe",
      email: "alex@example.com",
      phone: "0400000000",
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.contact_id).toBeNull();
    expect(json.ghl_error).toBe("server error");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("POST /lead — Turnstile", () => {
  const turnstileEnv = { ...env, TURNSTILE_SECRET_KEY: "ts-secret" };
  const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

  function leadRequest(extra = {}) {
    return makeRequest(
      "/lead",
      {
        first_name: "Alex",
        email: "alex@example.com",
        phone: "0400000000",
        turnstile_token: "tok-1",
        ...extra,
      },
      { headers: { "CF-Connecting-IP": "203.0.113.7" } }
    );
  }

  function siteverifyResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status });
  }

  function tagsSent(fetchMock) {
    return JSON.parse(fetchMock.mock.calls.at(-1)[1].body).tags;
  }

  it("verifies the token with Cloudflare before creating the contact", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(siteverifyResponse({ success: true }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ contact: { id: "c-ok" } }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const res = await worker.fetch(leadRequest(), turnstileEnv);
    const json = await res.json();

    expect(json.contact_id).toBe("c-ok");
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(SITEVERIFY_URL);
    const sent = JSON.parse(options.body);
    expect(sent).toEqual({ secret: "ts-secret", response: "tok-1", remoteip: "203.0.113.7" });
    expect(tagsSent(global.fetch)).toEqual(["website-lead"]);
  });

  it("rejects a token Cloudflare says is invalid, without calling GHL", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(siteverifyResponse({ success: false, "error-codes": ["invalid-input-response"] }));

    const res = await worker.fetch(leadRequest(), turnstileEnv);

    expect(res.status).toBe(403);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing token without calling Cloudflare or GHL", async () => {
    global.fetch = vi.fn();

    const res = await worker.fetch(leadRequest({ turnstile_token: "" }), turnstileEnv);

    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("still takes the lead, tagged unverified, when Cloudflare can't be reached", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ contact: { id: "c-unv" } }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const res = await worker.fetch(leadRequest(), turnstileEnv);
    const json = await res.json();

    expect(json.contact_id).toBe("c-unv");
    expect(tagsSent(global.fetch)).toEqual(["website-lead", "turnstile-unverified"]);
  });

  it("still takes the lead, tagged unverified, when Cloudflare returns a server error", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ contact: { id: "c-502" } }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const res = await worker.fetch(leadRequest(), turnstileEnv);
    const json = await res.json();

    expect(json.contact_id).toBe("c-502");
    expect(tagsSent(global.fetch)).toEqual(["website-lead", "turnstile-unverified"]);
  });

  it("checks the honeypot before spending a Cloudflare call", async () => {
    global.fetch = vi.fn();

    const res = await worker.fetch(leadRequest({ url: "http://spam.example.com" }), turnstileEnv);
    const json = await res.json();

    expect(json.contact_id).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips verification entirely when no secret is configured", async () => {
    global.fetch = mockLeadGhl("c-nokey");

    const res = await worker.fetch(leadRequest({ turnstile_token: "" }), env);
    const json = await res.json();

    expect(json.contact_id).toBe("c-nokey");
    expect(global.fetch.mock.calls[0][0]).not.toBe(SITEVERIFY_URL);
  });
});

describe("POST /gate", () => {
  it("qualifies a strong lead into priority with a 5-min SLA flag", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c1",
      customFields: {
        facility_type: "office",
        monthly_budget: "6000",
        postcode: "4211",
        cleaning_frequency: "daily",
        utm_source: "google",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier).toBe("priority");
    expect(json.sla_flag).toBe("call-within-5min");
    expect(json.dq_flag).toBe("none");

    expect(global.fetch).toHaveBeenCalledTimes(2); // tag add + custom-field write
    const [url, options] = global.fetch.mock.calls[1];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/c1");
    expect(options.method).toBe("PUT");
    expect(options.headers.Authorization).toBe("Bearer test-key");

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.lead_tier).toBe("priority");
    expect(fields.utm_source).toBe("google");
  });

  it("disqualifies a lead under budget instead of scoring it", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c2",
      customFields: {
        facility_type: "office",
        monthly_budget: "500",
        postcode: "4211",
        cleaning_frequency: "daily",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier).toBe("nurture");
    expect(json.dq_flag).toBe("nurture-budget");
    expect(json.sla_flag).toBe("none");
    expect(json.score).toBe(0);
  });

  it("surfaces a failed GHL write without throwing", async () => {
    global.fetch = vi.fn(async () => new Response("server error", { status: 500 }));
    const req = makeRequest("/gate", {
      contact_id: "c3",
      customFields: {
        facility_type: "office",
        monthly_budget: "3000",
        postcode: "4211",
        cleaning_frequency: "daily",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    // The endpoint still responds 200 to GHL even when the write-back failed —
    // the failure is surfaced in ghl_update, not as an HTTP error to the caller.
    expect(res.status).toBe(200);
    expect(json.ghl_update.success).toBe(false);
    expect(json.ghl_update.status).toBe(500);
  });
});

describe("POST /enrich", () => {
  it("bumps standard to priority on a large facility", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/enrich", {
      contact_id: "c4",
      customFields: { size_sqm: "2500", headcount: "80" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier_bump).toBe("priority");
    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.lead_tier).toBe("priority");
    expect(fields.size_sqm).toBe("2500");
  });

  it("does not bump tier for a small facility", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/enrich", {
      contact_id: "c5",
      customFields: { size_sqm: "300" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier_bump).toBeNull();
    expect(json.bump_reasons).toEqual([]);
  });

  it("bumps standard to priority when the existing contract renews soon", async () => {
    global.fetch = mockGhlOk();
    const soon = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // ~2 months out
    const req = makeRequest("/enrich", {
      contact_id: "c25",
      customFields: { size_sqm: "300", contract_renewal_date: soon.toISOString().slice(0, 10) },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier_bump).toBe("priority");
    expect(json.bump_reasons).toEqual(["near-term-contract-renewal"]);
    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.lead_tier).toBe("priority");
    expect(fields.contract_renewal_months_out).toBe("2");
  });

  it("does not bump tier for a contract renewing over a year out", async () => {
    global.fetch = mockGhlOk();
    const farOut = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000); // > 12 months out
    const req = makeRequest("/enrich", {
      contact_id: "c26",
      customFields: { contract_renewal_date: farOut.toISOString().slice(0, 10) },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier_bump).toBeNull();
    expect(json.bump_reasons).toEqual([]);
  });

  it("does not bump tier for a contract renewal date already in the past", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/enrich", {
      contact_id: "c27",
      customFields: { contract_renewal_date: "2020-01-01" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier_bump).toBeNull();
    expect(json.bump_reasons).toEqual([]);
  });

  it("ignores an unparseable contract_renewal_date rather than bumping or erroring", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/enrich", {
      contact_id: "c28",
      customFields: { contract_renewal_date: "not-a-real-date" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier_bump).toBeNull();
    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.contract_renewal_months_out).toBeUndefined();
  });

  it("reports both bump reasons when a large facility AND a near-term renewal both apply", async () => {
    global.fetch = mockGhlOk();
    const soon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const req = makeRequest("/enrich", {
      contact_id: "c29",
      customFields: { size_sqm: "2200", contract_renewal_date: soon.toISOString().slice(0, 10) },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier_bump).toBe("priority");
    expect(json.bump_reasons).toEqual(["large-facility", "near-term-contract-renewal"]);
  });
});

describe("POST /gate — budget is the only thing that decides the calendar", () => {
  it.each([
    ["an out-of-area postcode", { postcode: "4000" }, "out-of-area"],
    ["weekly cleaning", { cleaning_frequency: "weekly" }, "low-frequency"],
  ])("still gives %s a calendar, and records the concern in lead_flags", async (_, override, flag) => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-flag",
      customFields: {
        facility_type: "office",
        monthly_budget: "6000",
        postcode: "4211",
        cleaning_frequency: "daily",
        ...override,
      },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.tier).toBe("priority");
    expect(json.dq_flag).toBe("none");
    expect(json.lead_flags).toEqual([flag]);
    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.dq_flag).toBe("none");
    expect(fields.lead_flags).toBe(flag);
  });

  it.each(["education", "medical", "childcare"])("raises no flag for a %s facility", async (facility) => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-fac",
      customFields: { facility_type: facility, monthly_budget: "6000", postcode: "4211", cleaning_frequency: "daily" },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.tier).toBe("priority");
    expect(json.lead_flags).toEqual([]);
    expect(fieldsFromLastCall(global.fetch).lead_flags).toBe("none");
  });

  it("writes lead_flags: none when nothing needs reviewing", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-clean",
      customFields: { facility_type: "office", monthly_budget: "3000", postcode: "4211", cleaning_frequency: "daily" },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.tier).toBe("standard");
    expect(json.lead_flags).toEqual([]);
    expect(fieldsFromLastCall(global.fetch).lead_flags).toBe("none");
  });

  it("sends an under-$1,500 budget to nurture even with other flags", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-nurture",
      customFields: { facility_type: "medical", monthly_budget: "1499", postcode: "4000", cleaning_frequency: "weekly" },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.tier).toBe("nurture");
    expect(json.dq_flag).toBe("nurture-budget");
    expect(json.lead_flags).toEqual(["low-frequency", "out-of-area"]);
  });
});

describe("POST /gate — saves the Step 2 answers to the contact", () => {
  it("writes facility_type, monthly_budget and cleaning_frequency alongside the score", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-answers",
      customFields: { facility_type: "Office", monthly_budget: "3000", postcode: "4211", cleaning_frequency: "Five_Days_Week" },
    });

    await worker.fetch(req, env);

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.facility_type).toBe("office");
    expect(fields.monthly_budget).toBe("3000");
    expect(fields.cleaning_frequency).toBe("five_days_week");
    expect(fields.lead_tier).toBe("standard");
  });

  it("saves the answers for a nurture lead too", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-answers-nurture",
      customFields: { facility_type: "strata", monthly_budget: "1499", postcode: "4211", cleaning_frequency: "weekly" },
    });

    await worker.fetch(req, env);

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.lead_tier).toBe("nurture");
    expect(fields.facility_type).toBe("strata");
    expect(fields.monthly_budget).toBe("1499");
    expect(fields.cleaning_frequency).toBe("weekly");
  });

  it("never writes blank answers, so it can't wipe an existing value", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c-answers-blank",
      customFields: { facility_type: "", monthly_budget: "", postcode: "4211", cleaning_frequency: "" },
    });

    await worker.fetch(req, env);

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields).not.toHaveProperty("facility_type");
    expect(fields).not.toHaveProperty("monthly_budget");
    expect(fields).not.toHaveProperty("cleaning_frequency");
    expect(fields.lead_tier).toBeDefined();
  });
});

describe("POST /confirm", () => {
  it("requalifies a budget-DQ'd lead when the flexible amount clears the floor", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c6",
      customFields: {
        dq_flag: "nurture-budget",
        budget_flexible: "yes",
        flexible_budget_amount: "1500",
        cleaning_frequency: "daily",
        facility_type: "office",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dimension).toBe("budget");
    expect(json.requalified).toBe(true);
    expect(json.tier).toBe("standard");
  });

  it("keeps a budget-DQ'd lead in nurture when the flexible amount is $1,400 (below the $1,500 floor)", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c6b",
      customFields: { dq_flag: "nurture-budget", budget_flexible: "yes", flexible_budget_amount: "1400" },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.dimension).toBe("budget");
    expect(json.requalified).toBe(false);
  });

  it("keeps a budget-DQ'd lead in nurture when the flexible amount is still below the floor", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c7",
      customFields: {
        dq_flag: "nurture-budget",
        budget_flexible: "yes",
        flexible_budget_amount: "600",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.requalified).toBe(false);
    expect(fieldsFromLastCall(global.fetch).dq_flag).toBe("nurture-budget-confirmed");
  });

  it("requalifies a frequency-DQ'd lead when the flexed frequency clears the floor and budget is fine", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c8",
      customFields: {
        dq_flag: "nurture-frequency",
        frequency_flexible: "yes",
        flexible_frequency: "few_times_week",
        monthly_budget: "2500",
        facility_type: "strata",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dimension).toBe("frequency");
    expect(json.requalified).toBe(true);
  });

  it("routes a frequency-DQ'd lead back to nurture-budget if budget still fails after the frequency flex", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c9",
      customFields: {
        dq_flag: "nurture-frequency",
        frequency_flexible: "yes",
        flexible_frequency: "daily",
        monthly_budget: "500",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.requalified).toBe(false);
    expect(fieldsFromLastCall(global.fetch).dq_flag).toBe("nurture-budget");
  });
});

describe("POST /outcome", () => {
  it("demotes a no-show to nurture with the no-show DQ flag", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/outcome", {
      contact_id: "c10",
      customFields: { outcome_type: "no_show", reschedule_attempts: "2" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.outcome_type).toBe("no_show");
    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.dq_flag).toBe("nurture-no-show");
    expect(fields.lead_tier).toBe("nurture");
  });

  it("demotes a lost-at-proposal lead with the specific loss reason", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/outcome", {
      contact_id: "c11",
      customFields: { outcome_type: "lost_at_proposal", loss_reason: "price" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.loss_reason).toBe("price");
    expect(fieldsFromLastCall(global.fetch).dq_flag).toBe("nurture-lost-price");
  });

  it("400s on an unrecognised outcome_type", async () => {
    const res = await worker.fetch(
      makeRequest("/outcome", { contact_id: "c12", customFields: { outcome_type: "something_else" } }),
      env
    );
    expect(res.status).toBe(400);
  });
});

// The tests above always populate customFields fully. These cover the
// fallback branches (missing fields, the snake_case customFields key, the
// untested "standard" tier) that only fire when a payload is sparse.
describe("field defaults and alternate payload shapes", () => {
  it("scores a mid-range lead into standard (not priority or nurture)", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c13",
      customFields: {
        facility_type: "",
        monthly_budget: "3000",
        postcode: "4211",
        cleaning_frequency: "daily",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier).toBe("standard");
    expect(json.sla_flag).toBe("call-within-15min");
    expect(fieldsFromLastCall(global.fetch).sla_flag).toBe("call-within-15min");
  });

  it("gives a no-budget standard-flagged lead the Standard 15-minute SLA, since it books the Standard calendar", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c13b",
      customFields: { facility_type: "construction", monthly_budget: "", postcode: "4211", cleaning_frequency: "three_days_week" },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.tier).toBe("standard-flagged");
    expect(json.sla_flag).toBe("call-within-15min");
  });

  it("gives a nurture lead no SLA", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c13c",
      customFields: { facility_type: "office", monthly_budget: "1499", postcode: "4211", cleaning_frequency: "daily" },
    });

    const json = await (await worker.fetch(req, env)).json();

    expect(json.tier).toBe("nurture");
    expect(json.sla_flag).toBe("none");
  });

  it("accepts custom_fields (snake_case) as an alternative to customFields", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c14",
      custom_fields: { monthly_budget: "6000", cleaning_frequency: "daily", facility_type: "office", postcode: "4211" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.tier).toBe("priority");
  });

  it("treats a completely empty customFields object as a qualifying (not disqualified) zero-score lead", async () => {
    global.fetch = mockGhlOk();
    // No frequency/budget/facilityType/postcode at all — checkDisqualifiers'
    // per-field checks all short-circuit false rather than disqualifying,
    // since an unanswered field isn't the same as a failing one at /gate.
    const req = makeRequest("/gate", { contact_id: "c15", customFields: {} });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dq_flag).toBe("none");
    expect(json.score).toBe(0);
    expect(json.tier).toBe("standard-flagged");
  });

  it("enrich handles a payload with no customFields and no size_sqm", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/enrich", { contact_id: "c16" });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.tier_bump).toBeNull();
  });

  it("confirm defaults to the budget path when dq_flag is entirely absent", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c17",
      customFields: { budget_flexible: "yes", flexible_budget_amount: "2500" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.dimension).toBe("budget");
  });

  it("frequency confirm stays in nurture when frequency_flexible is missing (not just 'no')", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c18",
      customFields: { dq_flag: "nurture-frequency" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.requalified).toBe(false);
    expect(fieldsFromLastCall(global.fetch).dq_flag).toBe("nurture-frequency-confirmed");
  });

  it("frequency confirm requalifies with no monthly_budget or facility_type present at all", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c19",
      customFields: { dq_flag: "nurture-frequency", frequency_flexible: "yes", flexible_frequency: "daily" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.requalified).toBe(true);
  });

  it("outcome reads outcome_type from the top-level payload, not just customFields", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/outcome", { contact_id: "c20", outcome_type: "no_show" });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.outcome_type).toBe("no_show");
    expect(fieldsFromLastCall(global.fetch).noshow_attempts).toBe("1"); // defaults to 1 when reschedule_attempts is absent
  });

  it("outcome defaults loss_reason to 'unspecified' when absent", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/outcome", { contact_id: "c21", customFields: { outcome_type: "lost_at_proposal" } });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.loss_reason).toBe("unspecified");
    expect(fieldsFromLastCall(global.fetch).dq_flag).toBe("nurture-lost-unspecified");
  });

  it("confirm accepts custom_fields (snake_case) too", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c22",
      custom_fields: { dq_flag: "nurture-budget", budget_flexible: "yes", flexible_budget_amount: "2500" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.requalified).toBe(true);
  });

  it("budget confirm stays in nurture when budget_flexible/flexible_budget_amount are entirely absent", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/confirm", {
      contact_id: "c23",
      customFields: { dq_flag: "nurture-budget" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.requalified).toBe(false);
    expect(fieldsFromLastCall(global.fetch).dq_flag).toBe("nurture-budget-confirmed");
  });

  it("outcome accepts custom_fields (snake_case) too", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/outcome", {
      contact_id: "c24",
      custom_fields: { outcome_type: "no_show" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.outcome_type).toBe("no_show");
  });
});

describe("POST /apply (Step 1 — applicant capture, people sub-account)", () => {
  const peopleEnvVars = {
    ...env,
    GHL_VPP_API_KEY: "people-key",
    GHL_VPP_LOCATION_ID: "people-loc",
  };
  const body = {
    first_name: "Sam",
    last_name: "Lee",
    email: "sam@example.com",
    phone: "0400000000",
    postcode: "4211",
    engagement_track: "employee",
  };

  it("upserts in the people sub-account, tags the track and returns contact_id", async () => {
    global.fetch = mockLeadGhl("app-1");
    const res = await worker.fetch(makeRequest("/apply", body), peopleEnvVars);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contact_id: "app-1" });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [upsertUrl, upsertOpts] = global.fetch.mock.calls[0];
    expect(upsertUrl).toBe("https://services.leadconnectorhq.com/contacts/upsert");
    const sent = JSON.parse(upsertOpts.body);
    expect(sent.locationId).toBe("people-loc");
    expect(upsertOpts.headers.Authorization).toBe("Bearer people-key");
    const fields = Object.fromEntries(sent.customFields.map((f) => [f.key, f.field_value]));
    expect(fields.engagement_track).toBe("employee");
    expect(fields.postcode).toBe("4211");
    expect(fields.applicant_stage).toBe("started");
    expect(fields.applicant_captured_at).toBeTruthy();
    expect(fields.applicant_completion_pct).toBe("33");

    const [tagUrl, tagOpts] = global.fetch.mock.calls[1];
    expect(tagUrl).toBe("https://services.leadconnectorhq.com/contacts/app-1/tags");
    expect(tagOpts.headers.Authorization).toBe("Bearer people-key");
    expect(JSON.parse(tagOpts.body).tags).toEqual(["applicant-employee"]);
  });

  it("trims whitespace from every submitted field", async () => {
    global.fetch = mockLeadGhl("app-3");
    const padded = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, `  ${v} `]));
    const res = await worker.fetch(makeRequest("/apply", padded), peopleEnvVars);
    expect(res.status).toBe(200);
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent.email).toBe("sam@example.com");
    expect(sent.phone).toBe("0400000000");
    expect(sent.firstName).toBe("Sam");
    expect(sent.lastName).toBe("Lee");
    const fields = Object.fromEntries(sent.customFields.map((f) => [f.key, f.field_value]));
    expect(fields.postcode).toBe("4211");
  });

  it("rejects whitespace-only required fields", async () => {
    global.fetch = vi.fn();
    const res = await worker.fetch(makeRequest("/apply", { ...body, email: "   " }), peopleEnvVars);
    expect(res.status).toBe(400);
  });

  it("never uses the commercial location ID or token on any GHL call", async () => {
    global.fetch = mockLeadGhl("app-2");
    await worker.fetch(makeRequest("/apply", { ...body, engagement_track: "subcontractor" }), peopleEnvVars);

    for (const [, opts] of global.fetch.mock.calls) {
      expect(opts.headers.Authorization).not.toContain("test-key");
      expect(opts.body).not.toContain("loc-123");
    }
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).tags).toEqual(["applicant-subcontractor"]);
  });

  it("returns 503 and calls GHL not at all when the people credentials are missing", async () => {
    for (const e of [env, { ...env, GHL_VPP_API_KEY: "k" }, { ...env, GHL_VPP_LOCATION_ID: "l" }]) {
      global.fetch = vi.fn();
      const res = await worker.fetch(makeRequest("/apply", body), e);
      expect(res.status).toBe(503);
      expect(global.fetch).not.toHaveBeenCalled();
    }
  });

  it("returns 400 when email, phone or postcode is missing", async () => {
    for (const missing of ["email", "phone", "postcode"]) {
      global.fetch = vi.fn();
      const res = await worker.fetch(makeRequest("/apply", { ...body, [missing]: "" }), peopleEnvVars);
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    }
  });

  it("returns 400 for an unknown or missing track", async () => {
    for (const track of ["admin", "", undefined]) {
      global.fetch = vi.fn();
      const res = await worker.fetch(makeRequest("/apply", { ...body, engagement_track: track }), peopleEnvVars);
      expect(res.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    }
  });

  it("answers 200 {ok:true} to a filled honeypot without calling GHL", async () => {
    global.fetch = vi.fn();
    const res = await worker.fetch(makeRequest("/apply", { ...body, url: "spam.example" }), peopleEnvVars);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 403 when Turnstile rejects the token", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const res = await worker.fetch(makeRequest("/apply", body), { ...peopleEnvVars, TURNSTILE_SECRET_KEY: "ts" });
    expect(res.status).toBe(403);
  });

  it("proceeds and adds turnstile-unverified when Cloudflare is unreachable", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ contact: { id: "app-3" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const res = await worker.fetch(
      makeRequest("/apply", { ...body, turnstile_token: "tok" }),
      { ...peopleEnvVars, TURNSTILE_SECRET_KEY: "ts" }
    );
    expect(res.status).toBe(200);
    expect((await res.json()).contact_id).toBe("app-3");
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).tags).toEqual(["applicant-employee", "turnstile-unverified"]);
  });

  it("returns 502 when the upsert fails", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await worker.fetch(makeRequest("/apply", body), peopleEnvVars);
    expect(res.status).toBe(502);
  });
});

describe("POST /apply-screen (Step 2 per-track screening)", () => {
  const screenEnv = {
    GHL_VPFS_API_KEY: "commercial-key",
    GHL_VPFS_LOCATION_ID: "commercial-loc",
    GHL_VPP_API_KEY: "people-key",
    GHL_VPP_LOCATION_ID: "people-loc",
    BOOKING_TOKEN_SECRET: "s3cret",
  };

  const employee = {
    contact_id: "e1",
    engagement_track: "employee",
    postcode: "4211",
    cleaning_experience: "3_plus_years",
    residential_experience: "3_plus_years",
    right_to_work: "yes",
    police_check_status: "willing_no_current_check",
    availability: "flexible",
    reliable_transport: "yes",
  };
  const subcontractor = {
    ...employee,
    contact_id: "s1",
    engagement_track: "subcontractor",
    cleaning_experience: "5_plus_years",
    residential_experience: "5_plus_years",
    has_own_insurance_and_abn: "yes",
    own_equipment: "yes",
  };

  async function screen(body, e = screenEnv) {
    global.fetch = mockGhlOk();
    const res = await worker.fetch(makeRequest("/apply-screen", body), e);
    return { res, json: res.status === 200 ? await res.json() : null };
  }
  const putFields = () => {
    const [, o] = global.fetch.mock.calls.find(([, o]) => o.method === "PUT");
    return Object.fromEntries(JSON.parse(o.body).customFields.map((f) => [f.key, f.field_value]));
  };
  const tagsSent = () =>
    global.fetch.mock.calls.filter(([u]) => u.endsWith("/tags")).map(([, o]) => JSON.parse(o.body).tags);

  it("book: a qualifying subcontractor gets a token and no tag", async () => {
    const { json } = await screen(subcontractor);
    expect(json).toMatchObject({ tier: "priority", result: "book", dq_flag: "none" });
    expect(json.booking_token).toBeTruthy();
    expect(tagsSent()).toEqual([]);
    expect(putFields().applicant_tier).toBe("priority");
    expect(putFields().applicant_completion_pct).toBe("67");
  });

  it("book: always for a subcontractor, even with EMPLOYEE_INTAKE_OPEN off", async () => {
    const { json } = await screen(subcontractor, { ...screenEnv, EMPLOYEE_INTAKE_OPEN: "false" });
    expect(json.result).toBe("book");
  });

  it("shortlist: a qualifying employee with the intake off gets no token and the shortlist tag", async () => {
    const { json } = await screen(employee);
    expect(json).toMatchObject({ result: "shortlist", tier: "priority" });
    expect(json.booking_token).toBeUndefined();
    expect(tagsSent()).toEqual([["applicant-shortlist"]]);
  });

  it("book: a qualifying employee with the intake on gets an applicant token", async () => {
    const { json } = await screen(employee, { ...screenEnv, EMPLOYEE_INTAKE_OPEN: "true" });
    expect(json.result).toBe("book");
    expect(await verifyBookingToken(json.booking_token, screenEnv)).toMatchObject({
      cid: "e1",
      aud: "applicant",
      track: "employee",
    });
  });

  it("shipped wrangler.toml opens employee intake: employee books the employee calendar; flag \"false\" still shortlists", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const flag = toml.match(/^EMPLOYEE_INTAKE_OPEN\s*=\s*"([^"]*)"/m)[1];
    expect(flag).toBe("true");
    const env = { ...screenEnv, EMPLOYEE_INTAKE_OPEN: flag, CALENDAR_INTERVIEW_EMPLOYEE_ID: "int-emp" };
    const { json } = await screen(employee, env);
    expect(json.result).toBe("book");
    global.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    await worker.fetch(makeRequest("/slots", { booking_token: json.booking_token }), env);
    expect(global.fetch.mock.calls[0][0]).toContain("/calendars/int-emp/free-slots");
    const off = await screen(employee, { ...env, EMPLOYEE_INTAKE_OPEN: "false" });
    expect(off.json.result).toBe("shortlist");
  });

  it("the weakest applicant who clears every gate lands at the Standard floor (30), so only a DQ is unsuccessful", async () => {
    const { json } = await screen({
      ...employee,
      cleaning_experience: "1_to_3_years",
      residential_experience: "none",
      availability: "weekends_only",
      reliable_transport: "no",
    });
    expect(json).toMatchObject({ tier: "standard", result: "shortlist" });
    expect(Number(putFields().applicant_score)).toBeGreaterThanOrEqual(30);
  });

  // One case per D18 disqualifier row, per track.
  const common = [
    ["experience under 1 year", { cleaning_experience: "under_1_year", residential_experience: "under_1_year" }, "unsuccessful-insufficient-experience"],
    ["no experience", { cleaning_experience: "none", residential_experience: "none" }, "unsuccessful-insufficient-experience"],
    ["no right to work", { right_to_work: "no" }, "unsuccessful-no-right-to-work"],
    ["police check not willing", { police_check_status: "not_willing" }, "unsuccessful-no-police-check"],
    ["out of area", { postcode: "9999" }, "unsuccessful-out-of-area"],
  ];
  it.each(common)("employee DQ: %s", async (_n, over, flag) => {
    const { json } = await screen({ ...employee, ...over });
    expect(json).toMatchObject({ tier: "unsuccessful", result: "unsuccessful", dq_flag: flag });
    expect(json.booking_token).toBeUndefined();
    expect(putFields().applicant_dq_flag).toBe(flag);
    expect(tagsSent()).toEqual([["applicant-unsuccessful"]]);
  });
  it.each([
    ...common,
    ["no ABN and insurance", { has_own_insurance_and_abn: "no" }, "unsuccessful-no-abn-redirect-careers"],
    ["no own equipment", { own_equipment: "no" }, "unsuccessful-no-own-equipment"],
    ["no own transport", { reliable_transport: "no" }, "unsuccessful-no-transport"],
  ])("subcontractor DQ: %s", async (_n, over, flag) => {
    const { json } = await screen({ ...subcontractor, ...over });
    expect(json).toMatchObject({ tier: "unsuccessful", result: "unsuccessful", dq_flag: flag });
    expect(json.booking_token).toBeUndefined();
    expect(tagsSent()).toEqual([["applicant-unsuccessful"]]);
  });

  it("employee without own transport is scored, not disqualified", async () => {
    const { json } = await screen({ ...employee, reliable_transport: "no" });
    expect(json.dq_flag).toBe("none");
    expect(putFields().applicant_score).toBe("85");
  });

  it("out-of-area uses LAUNCH_AREA_POSTCODES: a Tweed postcode passes", async () => {
    const { json } = await screen({ ...employee, postcode: "2486" });
    expect(json.dq_flag).toBe("none");
  });

  it("incomplete answers -> 400 (common, track-specific, bad track, bad experience option)", async () => {
    const { reliable_transport, ...noTransport } = employee;
    expect((await screen(noTransport)).res.status).toBe(400);
    const { own_equipment, ...noEquipment } = subcontractor;
    expect((await screen(noEquipment)).res.status).toBe(400);
    expect((await screen({ ...employee, engagement_track: "other" })).res.status).toBe(400);
    expect((await screen({ ...employee, cleaning_experience: "5_plus_years" })).res.status).toBe(400);
    expect((await screen({ ...employee, contact_id: "" })).res.status).toBe(400);
  });

  it("residential_experience: missing or off-track -> 400; saved lower-cased; counts towards the minimum", async () => {
    const { residential_experience, ...noRes } = employee;
    expect((await screen(noRes)).res.status).toBe(400);
    expect((await screen({ ...employee, residential_experience: "5_plus_years" })).res.status).toBe(400);
    expect((await screen({ ...subcontractor, residential_experience: "3_plus_years" })).res.status).toBe(400);
    const { json } = await screen({
      ...employee, cleaning_experience: "under_1_year", residential_experience: "1_TO_3_YEARS",
    });
    expect(json.result).not.toBe("unsuccessful");
    expect(putFields().residential_experience).toBe("1_to_3_years");
  });

  it("503 and no GHL call when the people credentials are missing", async () => {
    const { res } = await screen(employee, { GHL_VPFS_API_KEY: "k", GHL_VPFS_LOCATION_ID: "l" });
    expect(res.status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  const removed = {
    blue_card_status: "not_applicable",
    start_availability: "immediately",
    physical_capability: "yes",
    passion_rating: "genuinely_passionate",
    works_for_other_clients: "yes",
  };

  it("saves the subcontractor's answers to GHL under their own keys", async () => {
    await screen(subcontractor);
    const fields = putFields();
    expect(fields).toMatchObject({
      cleaning_experience: "5_plus_years",
      right_to_work: "yes",
      police_check_status: "willing_no_current_check",
      availability: "flexible",
      reliable_transport: "yes",
      has_own_insurance_and_abn: "yes",
      own_equipment: "yes",
      applicant_subcontractor_ready: "true",
    });
    expect(fields).not.toHaveProperty("applicant_blue_card_eligible");
  });

  it("saves the employee's answers without the subcontractor-only keys", async () => {
    await screen(employee);
    const fields = putFields();
    expect(fields).toMatchObject({ cleaning_experience: "3_plus_years" });
    for (const key of ["has_own_insurance_and_abn", "own_equipment"]) {
      expect(fields).not.toHaveProperty(key);
    }
    expect(fields).not.toHaveProperty("applicant_blue_card_eligible");
  });

  it.each([["employee"], ["subcontractor"]])("%s: removed fields from an old page are ignored, not written, not scored", async (t) => {
    const base = t === "employee" ? employee : subcontractor;
    const clean = await screen(base);
    const cleanFields = putFields();
    global.fetch.mockClear();
    const { res, json } = await screen({ ...base, ...removed });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ tier: clean.json.tier, result: clean.json.result });
    const fields = putFields();
    expect(fields.applicant_score).toBe(cleanFields.applicant_score);
    for (const k of Object.keys(removed)) expect(fields).not.toHaveProperty(k);
  });

  it.each([
    ["employee", ["cleaning_experience", "residential_experience", "right_to_work", "police_check_status", "availability", "reliable_transport"]],
    ["subcontractor", ["cleaning_experience", "residential_experience", "right_to_work", "police_check_status", "availability", "reliable_transport", "has_own_insurance_and_abn", "own_equipment"]],
  ])("%s: a missing D2 field is a 400", async (t, keys) => {
    const base = t === "employee" ? employee : subcontractor;
    for (const k of keys) {
      const { res } = await screen({ ...base, [k]: "" });
      expect(res.status).toBe(400);
    }
  });

  it("shortlist writes completion 67 and unsuccessful writes 100", async () => {
    await screen(employee);
    expect(putFields().applicant_completion_pct).toBe("67");
    global.fetch.mockClear();
    await screen({ ...subcontractor, own_equipment: "no" });
    expect(putFields().applicant_completion_pct).toBe("100");
  });

  it("still saves the answers when the applicant is disqualified", async () => {
    await screen({ ...subcontractor, own_equipment: "no" });
    expect(putFields()).toMatchObject({ applicant_tier: "unsuccessful", own_equipment: "no" });
  });

  it("every write uses the people credentials, never the commercial pair", async () => {
    await screen(employee);
    expect(global.fetch.mock.calls.length).toBeGreaterThan(1);
    for (const [, options] of global.fetch.mock.calls) {
      expect(options.headers.Authorization).toBe("Bearer people-key");
    }
  });

  it("502 and no token when the write fails (e.g. a contact outside the people sub-account)", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const res = await worker.fetch(makeRequest("/apply-screen", subcontractor), screenEnv);
    expect(res.status).toBe(502);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
describe("CORS", () => {
  it("answers an OPTIONS preflight for /gate from an allowed origin", async () => {
    const req = makeRequest("/gate", null, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN },
    });

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("includes Access-Control-Allow-Origin on an actual /gate response from an allowed origin", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest(
      "/gate",
      {
        contact_id: "c-cors-1",
        customFields: {
          facility_type: "office",
          monthly_budget: "3000",
          postcode: "4211",
          cleaning_frequency: "daily",
        },
      },
      { headers: { Origin: ALLOWED_ORIGIN, "Content-Type": "application/json" } }
    );

    const res = await worker.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("does not echo back a disallowed origin", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest(
      "/gate",
      {
        contact_id: "c-cors-2",
        customFields: {
          facility_type: "office",
          monthly_budget: "3000",
          postcode: "4211",
          cleaning_frequency: "daily",
        },
      },
      { headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" } }
    );

    const res = await worker.fetch(req, env);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("booking token", () => {
  const secretEnv = { ...env, BOOKING_TOKEN_SECRET: "s3cret" };
  const gateBody = (budget, postcode = "4211") => ({
    contact_id: "cb1",
    customFields: {
      facility_type: "office",
      monthly_budget: budget,
      postcode,
      cleaning_frequency: "daily",
    },
  });

  afterEach(() => vi.useRealTimers());

  it("/gate returns a verifiable booking_token for priority", async () => {
    global.fetch = mockGhlOk();
    const res = await worker.fetch(makeRequest("/gate", gateBody("6000")), secretEnv);
    const json = await res.json();
    expect(json.tier).toBe("priority");
    expect(await verifyBookingToken(json.booking_token, secretEnv)).toEqual({
      cid: "cb1",
      tier: "priority",
    });
  });

  it("/gate returns a token for standard and standard-flagged", async () => {
    global.fetch = mockGhlOk();
    const std = await (await worker.fetch(makeRequest("/gate", gateBody("3000")), secretEnv)).json();
    expect(std.tier).toBe("standard");
    expect(std.booking_token).toBeTruthy();
    const flagged = await (
      await worker.fetch(makeRequest("/gate", { contact_id: "cb2", customFields: {} }), secretEnv)
    ).json();
    expect(flagged.tier).toBe("standard-flagged");
    expect(flagged.booking_token).toBeTruthy();
  });

  it("/gate returns no token for nurture", async () => {
    global.fetch = mockGhlOk();
    const json = await (await worker.fetch(makeRequest("/gate", gateBody("500")), secretEnv)).json();
    expect(json.tier).toBe("nurture");
    expect(json).not.toHaveProperty("booking_token");
  });

  it("/gate omits the token without a secret, leaving the rest unchanged", async () => {
    global.fetch = mockGhlOk();
    const json = await (await worker.fetch(makeRequest("/gate", gateBody("6000")), env)).json();
    expect(json).not.toHaveProperty("booking_token");
    expect(json.tier).toBe("priority");
    expect(json.stage).toBe("gate");
    expect(global.fetch).toHaveBeenCalledTimes(2); // tag add + custom-field write
  });

  it("signBookingToken returns null without a secret", async () => {
    expect(await signBookingToken({ cid: "x", tier: "priority" }, env)).toBeNull();
  });

  it("rejects missing, malformed, wrongly signed, tampered and expired tokens", async () => {
    const token = await signBookingToken({ cid: "c9", tier: "standard" }, secretEnv);
    expect(await verifyBookingToken(token, secretEnv)).toEqual({ cid: "c9", tier: "standard" });
    expect(await verifyBookingToken(undefined, secretEnv)).toBeNull();
    expect(await verifyBookingToken("", secretEnv)).toBeNull();
    expect(await verifyBookingToken("garbage", secretEnv)).toBeNull();
    expect(await verifyBookingToken("a.b.c", secretEnv)).toBeNull();
    expect(await verifyBookingToken("!!!.???", secretEnv)).toBeNull();
    expect(await verifyBookingToken(token, { ...env, BOOKING_TOKEN_SECRET: "other" })).toBeNull();

    const [payload, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(payload)), tier: "priority" }))
      .replace(/=+$/, "");
    expect(await verifyBookingToken(`${forged}.${sig}`, secretEnv)).toBeNull();
  });

  it("expires after 2 hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signBookingToken({ cid: "c9", tier: "priority" }, secretEnv);
    vi.setSystemTime(new Date("2026-01-01T01:59:00Z"));
    expect(await verifyBookingToken(token, secretEnv)).not.toBeNull();
    vi.setSystemTime(new Date("2026-01-01T02:00:01Z"));
    expect(await verifyBookingToken(token, secretEnv)).toBeNull();
  });

  it("calendarIdForTier maps tiers to calendars", () => {
    const e = { CALENDAR_PRIORITY_ID: "P", CALENDAR_STANDARD_ID: "S" };
    expect(calendarIdForTier("priority", e)).toBe("P");
    expect(calendarIdForTier("standard", e)).toBe("S");
    expect(calendarIdForTier("standard-flagged", e)).toBe("S");
    expect(calendarIdForTier("nurture", e)).toBeNull();
  });
});

describe("/slots", () => {
  const slotsEnv = {
    ...env,
    BOOKING_TOKEN_SECRET: "s3cret",
    CALENDAR_PRIORITY_ID: "CAL_P",
    CALENDAR_STANDARD_ID: "CAL_S",
    BOOKING_TIMEZONE: "Australia/Brisbane",
  };
  afterEach(() => vi.useRealTimers());

  const ghlSlots = (body, ok = true) =>
    vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body), text: () => Promise.resolve("err") });

  it("returns 403 for missing, invalid and expired tokens", async () => {
    global.fetch = vi.fn();
    expect((await worker.fetch(makeRequest("/slots", {}), slotsEnv)).status).toBe(403);
    expect((await worker.fetch(makeRequest("/slots", { booking_token: "junk" }), slotsEnv)).status).toBe(403);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await signBookingToken({ cid: "c", tier: "standard" }, slotsEnv);
    vi.setSystemTime(new Date("2026-01-01T03:00:00Z"));
    expect((await worker.fetch(makeRequest("/slots", { booking_token: token }), slotsEnv)).status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns 503 when BOOKING_TOKEN_SECRET is unset", async () => {
    const res = await worker.fetch(makeRequest("/slots", { booking_token: "x" }), env);
    expect(res.status).toBe(503);
  });

  it("calls GHL free-slots on the tier's calendar with the window and Version header", async () => {
    const now = new Date("2026-03-02T00:00:00Z").getTime();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    for (const [tier, cal] of [["priority", "CAL_P"], ["standard", "CAL_S"], ["standard-flagged", "CAL_S"]]) {
      global.fetch = ghlSlots({});
      const token = await signBookingToken({ cid: "c1", tier }, slotsEnv);
      await worker.fetch(makeRequest("/slots", { booking_token: token, calendar_id: "EVIL" }), slotsEnv);
      const [url, opts] = global.fetch.mock.calls[0];
      const u = new URL(url);
      expect(u.pathname).toBe(`/calendars/${cal}/free-slots`);
      expect(u.searchParams.get("startDate")).toBe(String(now));
      expect(u.searchParams.get("endDate")).toBe(String(now + 30 * 86400000));
      expect(u.searchParams.get("timezone")).toBe("Australia/Brisbane");
      expect(opts.method).toBe("GET");
      expect(opts.headers.Version).toBe("2021-04-15");
    }
  });

  it("returns sorted days, leaving out empty ones", async () => {
    global.fetch = ghlSlots({
      "2026-03-05": { slots: ["2026-03-05T10:00:00+10:00", "2026-03-05T09:00:00+10:00"] },
      "2026-03-04": { slots: [] },
      "2026-03-03": { slots: ["2026-03-03T09:00:00+10:00"] },
      traceId: "t",
    });
    const token = await signBookingToken({ cid: "c1", tier: "priority" }, slotsEnv);
    const res = await worker.fetch(makeRequest("/slots", { booking_token: token }), slotsEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      timezone: "Australia/Brisbane",
      window_days: 30,
      days: [
        { date: "2026-03-03", slots: ["2026-03-03T09:00:00+10:00"] },
        { date: "2026-03-05", slots: ["2026-03-05T09:00:00+10:00", "2026-03-05T10:00:00+10:00"] },
      ],
    });
  });

  it("returns 502 slots_unavailable on a GHL error or network failure", async () => {
    const token = await signBookingToken({ cid: "c1", tier: "priority" }, slotsEnv);
    global.fetch = ghlSlots({}, false);
    let res = await worker.fetch(makeRequest("/slots", { booking_token: token }), slotsEnv);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "slots_unavailable" });
    global.fetch = vi.fn().mockRejectedValue(new Error("net"));
    res = await worker.fetch(makeRequest("/slots", { booking_token: token }), slotsEnv);
    expect(res.status).toBe(502);
  });
});

describe("/book", () => {
  const bookEnv = {
    ...env,
    BOOKING_TOKEN_SECRET: "s3cret",
    CALENDAR_PRIORITY_ID: "CAL_P",
    CALENDAR_STANDARD_ID: "CAL_S",
    GHL_VPFS_LOCATION_ID: "LOC",
  };
  const NOW = new Date("2026-03-02T00:00:00Z").getTime();
  const START = "2026-03-05T09:00:00+10:00";
  const ADDR = "12 Smith St, Southport QLD";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const res = (body, ok = true, status = ok ? 200 : 500) => ({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
  // Routes GHL calls by URL/method.
  const ghl = ({ events = [], cal = { calendar: { slotDuration: 45, slotDurationUnit: "mins" } }, create = res({}), contact = res({}) } = {}) =>
    (global.fetch = vi.fn((url, opts) => {
      if (opts.method === "PUT" && url.includes("/contacts/")) return Promise.resolve(contact);
      if (url.includes("/appointments") && opts.method === "GET") return Promise.resolve(res({ events }));
      if (url.endsWith("/calendars/events/appointments")) return Promise.resolve(create);
      return Promise.resolve(res(cal));
    }));
  const post = async (body, tier = "priority", e = bookEnv) => {
    const token = await signBookingToken({ cid: "c1", tier }, bookEnv);
    return worker.fetch(makeRequest("/book", { booking_token: token, site_address: ADDR, ...body }), e);
  };

  it("403 for bad token, 503 without secret", async () => {
    global.fetch = vi.fn();
    expect((await worker.fetch(makeRequest("/book", { booking_token: "junk", start_time: START }), bookEnv)).status).toBe(403);
    expect((await worker.fetch(makeRequest("/book", { booking_token: "x" }), env)).status).toBe(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("400 for missing, invalid, past and beyond-30-day start_time", async () => {
    global.fetch = vi.fn();
    for (const start_time of [undefined, "nope", "2026-03-01T09:00:00+10:00", "2026-04-05T09:00:00+10:00"]) {
      expect((await post({ start_time })).status).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("409 already_booked when an upcoming non-cancelled appointment exists, creating nothing", async () => {
    ghl({
      events: [
        { startTime: "2026-03-04T09:00:00+10:00", appointmentStatus: "cancelled" },
        { startTime: "2026-02-01T09:00:00+10:00", appointmentStatus: "confirmed" },
        { startTime: "2026-03-10T09:00:00+10:00", appointmentStatus: "confirmed" },
      ],
    });
    const r = await post({ start_time: START });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "already_booked", start_time: "2026-03-10T09:00:00+10:00" });
    expect(global.fetch.mock.calls.some(([u]) => u.endsWith("/calendars/events/appointments"))).toBe(false);
  });

  it("books on the tier's calendar with the token's contact", async () => {
    for (const [tier, cal] of [["priority", "CAL_P"], ["standard", "CAL_S"]]) {
      ghl();
      const r = await post({ start_time: START, contactId: "EVIL", calendar_id: "EVIL" }, tier);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ booked: true, start_time: START, end_time: "2026-03-05T09:45:00+10:00" });
      const [, opts] = global.fetch.mock.calls.find(([u]) => u.endsWith("/calendars/events/appointments"));
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        calendarId: cal,
        locationId: "LOC",
        contactId: "c1",
        startTime: START,
        endTime: "2026-03-05T09:45:00+10:00",
        title: "Walkthrough",
        appointmentStatus: "confirmed",
        toNotify: true,
        address: ADDR,
      });
    }
  });

  it("400 for missing, blank or over-200-character site_address, with no GHL calls", async () => {
    global.fetch = vi.fn();
    for (const site_address of [undefined, "", "   ", 5, "a".repeat(201)]) {
      expect((await post({ start_time: START, site_address })).status).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
    ghl();
    expect((await post({ start_time: START, site_address: "a".repeat(200) })).status).toBe(200);
  });

  it("trims the address and saves it to the contact as address1", async () => {
    ghl();
    const r = await post({ start_time: START, site_address: "  " + ADDR + "  " });
    expect(r.status).toBe(200);
    expect((await r.json()).contact_address_saved).toBeUndefined();
    const create = global.fetch.mock.calls.find(([u]) => u.endsWith("/calendars/events/appointments"));
    expect(JSON.parse(create[1].body).address).toBe(ADDR);
    const put = global.fetch.mock.calls.find(([, o]) => o.method === "PUT");
    expect(put[0]).toMatch(/\/contacts\/c1$/);
    expect(JSON.parse(put[1].body)).toEqual({ address1: ADDR });
  });

  it("still returns 200 with contact_address_saved:false when the contact update fails", async () => {
    ghl({ contact: res({}, false, 500) });
    let r = await post({ start_time: START });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ booked: true, start_time: START, end_time: "2026-03-05T09:45:00+10:00", contact_address_saved: false });
    const base = ghl();
    global.fetch = vi.fn((url, opts) =>
      opts.method === "PUT" ? Promise.reject(new Error("net")) : base(url, opts));
    r = await post({ start_time: START });
    expect(r.status).toBe(200);
    expect((await r.json()).contact_address_saved).toBe(false);
  });

  it("409 slot_unavailable when GHL refuses the slot", async () => {
    ghl({ create: res({ message: "The slot you have selected is no longer available" }, false, 400) });
    const r = await post({ start_time: START });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "slot_unavailable" });
  });

  it("502 booking_failed on other GHL failures", async () => {
    ghl({ create: res({ message: "boom" }, false, 500) });
    let r = await post({ start_time: START });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "booking_failed" });
    global.fetch = vi.fn().mockRejectedValue(new Error("net"));
    r = await post({ start_time: START });
    expect(r.status).toBe(502);
  });

  it("502 when the tier has no calendar, or the appointment/calendar lookups fail", async () => {
    global.fetch = vi.fn();
    let r = await post({ start_time: START }, "priority", { ...bookEnv, CALENDAR_PRIORITY_ID: undefined });
    // token is signed with bookEnv; verification passes, calendar missing
    expect(r.status).toBe(502);
    global.fetch = vi.fn().mockResolvedValue(res({}, false, 500));
    expect((await post({ start_time: START })).status).toBe(502);
    global.fetch = vi.fn((url, opts) =>
      Promise.resolve(url.includes("/appointments") && opts.method === "GET" ? res({}) : res({}, false, 500))
    );
    expect((await post({ start_time: START })).status).toBe(502);
  });

  it("derives endTime from hour units, defaults to 30 minutes, and handles UTC starts", async () => {
    ghl({ cal: { calendar: { slotDuration: 1, slotDurationUnit: "hours" } } });
    let r = await post({ start_time: START });
    expect((await r.json()).end_time).toBe("2026-03-05T10:00:00+10:00");
    ghl({ cal: {} });
    r = await post({ start_time: "2026-03-05T09:00:00Z" });
    expect((await r.json()).end_time).toBe("2026-03-05T09:30:00.000Z");
    ghl({ cal: { calendar: { slotDuration: 30 } }, events: [{ startTime: "2026-03-04T09:00:00+10:00", status: "canceled" }] });
    r = await post({ start_time: "2026-03-05T09:00:00-05:30" });
    expect((await r.json()).end_time).toBe("2026-03-05T09:30:00-05:30");
  });

  it("502 when GHL's refusal is not about the slot, and tolerates an unreadable body", async () => {
    ghl({ create: { ok: false, status: 400, text: () => Promise.reject(new Error("x")), json: () => Promise.resolve({}) } });
    expect((await post({ start_time: START })).status).toBe(502);
    ghl({ create: res({ message: "Invalid contact" }, false, 400) });
    expect((await post({ start_time: START })).status).toBe(502);
  });

  it("answers CORS on /book", async () => {
    ghl();
    const origin = "https://www.vantagepointfacilityservices.com.au";
    const pre = await worker.fetch(new Request("https://w/book", { method: "OPTIONS", headers: { Origin: origin } }), bookEnv);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const token = await signBookingToken({ cid: "c1", tier: "priority" }, bookEnv);
    const r = await worker.fetch(
      makeRequest("/book", { booking_token: token, start_time: START }, { headers: { Origin: origin } }),
      bookEnv
    );
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });
});

// /area-request — the Locations page's "Request a new area" form. Same GHL
// upsert + additive tag as /lead, but tagged new-area-request (never
// website-lead, so the booking workflows don't start).
describe("POST /area-request", () => {
  const body = {
    first_name: "Sam", last_name: "Lee", email: "sam@example.com", phone: "0400000001", postcode: "4870",
  };

  it("upserts the contact with the postcode and tags it new-area-request only", async () => {
    global.fetch = mockLeadGhl("area-contact-1");
    const res = await worker.fetch(makeRequest("/area-request", body), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const sent = upsertBody(global.fetch);
    expect(sent.locationId).toBe("loc-123");
    expect(sent.email).toBe("sam@example.com");
    expect(fieldsFromLastCall({ mock: { calls: [global.fetch.mock.calls[0]] } })).toMatchObject({
      postcode: "4870",
      conversion_page: "website-locations-area-request",
    });

    const [tagUrl, tagOpts] = global.fetch.mock.calls[1];
    expect(tagUrl).toBe("https://services.leadconnectorhq.com/contacts/area-contact-1/tags");
    expect(JSON.parse(tagOpts.body).tags).toEqual(["new-area-request"]);
  });

  it("requires email, phone and postcode", async () => {
    global.fetch = mockGhlOk();
    for (const missing of ["email", "phone", "postcode"]) {
      const res = await worker.fetch(makeRequest("/area-request", { ...body, [missing]: "" }), env);
      expect(res.status, missing).toBe(400);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("silently accepts a honeypot hit without calling GHL", async () => {
    global.fetch = mockGhlOk();
    const res = await worker.fetch(makeRequest("/area-request", { ...body, url: "spam.example" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing Turnstile token once the secret is set", async () => {
    global.fetch = mockGhlOk();
    const res = await worker.fetch(makeRequest("/area-request", body), { ...env, TURNSTILE_SECRET_KEY: "ts-secret" });
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("reports a GHL failure so the visitor can try again", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await worker.fetch(makeRequest("/area-request", body), env);
    expect(res.status).toBe(502);
  });

  it("allows the website origin (CORS)", async () => {
    global.fetch = mockLeadGhl("area-contact-2");
    const res = await worker.fetch(
      makeRequest("/area-request", body, { headers: { Origin: ALLOWED_ORIGIN } }),
      env
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });
});

describe("Step 3 — applicant interview booking (/slots, /book)", () => {
  const benv = {
    GHL_VPFS_API_KEY: "lead-key",
    GHL_VPFS_LOCATION_ID: "lead-loc",
    GHL_VPP_API_KEY: "people-key",
    GHL_VPP_LOCATION_ID: "people-loc",
    BOOKING_TOKEN_SECRET: "s3cret",
    CALENDAR_PRIORITY_ID: "lead-pri",
    CALENDAR_STANDARD_ID: "lead-std",
    CALENDAR_INTERVIEW_EMPLOYEE_ID: "int-emp",
    CALENDAR_INTERVIEW_SUBCONTRACTOR_ID: "int-sub",
  };
  const tok = (claims) => signBookingToken({ cid: "c1", tier: "priority", ...claims }, benv);
  const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "+00:00");
  const urls = () => global.fetch.mock.calls.map(([u]) => u);

  function mockCal(slotsBody) {
    return vi.fn(async (u, o = {}) => {
      if (u.includes("/free-slots")) return new Response(JSON.stringify(slotsBody), { status: 200 });
      if (u.endsWith("/appointments") && o.method === "GET") return new Response('{"events":[]}', { status: 200 });
      if (/\/calendars\/[^/]+$/.test(u)) return new Response('{"calendar":{"slotDuration":60}}', { status: 200 });
      return new Response("{}", { status: 200 });
    });
  }
  const slotsFor = async (token, e = benv) => worker.fetch(makeRequest("/slots", { booking_token: token }), e);
  const bookFor = async (token, e = benv) =>
    worker.fetch(makeRequest("/book", { booking_token: token, start_time: future }), e);

  it.each([
    ["employee", "int-emp"],
    ["subcontractor", "int-sub"],
  ])("/slots for a %s applicant uses its interview calendar and the people credentials", async (track, calId) => {
    global.fetch = mockCal({ "2099-01-01": { slots: ["b", "a"] } });
    const res = await slotsFor(await tok({ aud: "applicant", track }));
    expect(res.status).toBe(200);
    expect(urls()[0]).toContain(`/calendars/${calId}/free-slots`);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer people-key");
    expect((await res.json()).days).toEqual([{ date: "2099-01-01", slots: ["a", "b"] }]);
  });

  it("/slots drops full class slots (0 seats left) and keeps others", async () => {
    global.fetch = mockCal({
      "2099-01-01": { slots: [{ startTime: "x", seatsLeft: 0 }, { startTime: "y", seatsLeft: 3 }] },
      "2099-01-02": { slots: [{ startTime: "z", seatsLeft: 0 }] },
    });
    const res = await slotsFor(await tok({ aud: "applicant", track: "employee" }));
    expect((await res.json()).days).toEqual([{ date: "2099-01-01", slots: ["y"] }]);
  });

  it("/book creates the appointment on the track calendar in the people account and tags the booking", async () => {
    global.fetch = mockCal({});
    const res = await bookFor(await tok({ aud: "applicant", track: "subcontractor" }));
    expect(res.status).toBe(200);
    expect((await res.json()).booked).toBe(true);
    const post = global.fetch.mock.calls.find(([u, o]) => u.endsWith("/events/appointments") && o.method === "POST");
    const body = JSON.parse(post[1].body);
    expect(body).toMatchObject({ calendarId: "int-sub", locationId: "people-loc", contactId: "c1" });
    expect(post[1].headers.Authorization).toBe("Bearer people-key");
    const tag = global.fetch.mock.calls.find(([u]) => u.endsWith("/tags"));
    expect(JSON.parse(tag[1].body).tags).toEqual(["applicant-interview-booked"]);
    expect(tag[1].headers.Authorization).toBe("Bearer people-key");
    expect(global.fetch.mock.calls.some(([u, o]) => o.method === "PUT")).toBe(false);
  });

  it("a missing interview calendar id gives the unavailable fallback, not an error page", async () => {
    global.fetch = mockCal({});
    const e = { ...benv, CALENDAR_INTERVIEW_EMPLOYEE_ID: "" };
    const res = await slotsFor(await tok({ aud: "applicant", track: "employee" }), e);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("slots_unavailable");
    expect(global.fetch).not.toHaveBeenCalled();
    const book = await bookFor(await tok({ aud: "applicant", track: "employee" }), e);
    expect((await book.json()).error).toBe("booking_failed");
  });

  it("a /slots failure from GHL gives the unavailable fallback", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    const res = await slotsFor(await tok({ aud: "applicant", track: "employee" }));
    expect((await res.json()).error).toBe("slots_unavailable");
  });

  it("applicant token → lead calendars: never touched", async () => {
    global.fetch = mockCal({});
    await slotsFor(await tok({ aud: "applicant", track: "employee" }));
    await bookFor(await tok({ aud: "applicant", track: "employee" }));
    expect(urls().some((u) => u.includes("lead-pri") || u.includes("lead-std"))).toBe(false);
  });

  it("lead token → interview calendars: never touched, lead credentials used", async () => {
    global.fetch = mockCal({});
    await slotsFor(await tok({}));
    expect(urls().some((u) => u.includes("int-emp") || u.includes("int-sub"))).toBe(false);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer lead-key");
  });

  it("employee token → subcontractor calendar: never touched", async () => {
    global.fetch = mockCal({});
    await slotsFor(await tok({ aud: "applicant", track: "employee" }));
    await bookFor(await tok({ aud: "applicant", track: "employee" }));
    expect(urls().some((u) => u.includes("int-sub"))).toBe(false);
  });

  it("subcontractor token → employee calendar: never touched", async () => {
    global.fetch = mockCal({});
    await slotsFor(await tok({ aud: "applicant", track: "subcontractor" }));
    await bookFor(await tok({ aud: "applicant", track: "subcontractor" }));
    expect(urls().some((u) => u.includes("int-emp"))).toBe(false);
  });

  it("an applicant token with an unknown track or a foreign aud is rejected", async () => {
    global.fetch = mockCal({});
    for (const claims of [{ aud: "applicant", track: "bogus" }, { aud: "applicant" }, { aud: "lead", track: "employee" }]) {
      expect((await slotsFor(await tok(claims))).status).toBe(403);
      expect((await bookFor(await tok(claims))).status).toBe(403);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("POST /lead — Sales Pipeline deal", () => {
  const oenv = { ...env, SALES_PIPELINE_ID: "pipe-1", STAGE_NEW_LEAD_ID: "stage-new" };
  const lead = { first_name: "Alex", last_name: "Rowe", email: "a@example.com", phone: "0400000000", company_name: "Acme" };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const oppCalls = (m) => m.mock.calls.filter(([u]) => u.includes("/opportunities"));

  function mockWith(searchResult) {
    return vi.fn(async (url) => {
      if (url.includes("/contacts/upsert")) return json({ contact: { id: "c-9" } });
      if (url.includes("/tags")) return json({});
      if (url.includes("/opportunities/search")) return searchResult();
      return json({});
    });
  }

  it("creates one New Lead deal when none is open", async () => {
    global.fetch = mockWith(() => json({ opportunities: [] }));
    const res = await worker.fetch(makeRequest("/lead", lead), oenv);
    expect(await res.json()).toEqual({ contact_id: "c-9" });
    const calls = oppCalls(global.fetch);
    expect(calls).toHaveLength(2);
    const search = new URL(calls[0][0]);
    expect(search.searchParams.get("contact_id")).toBe("c-9");
    expect(search.searchParams.get("pipeline_id")).toBe("pipe-1");
    expect(search.searchParams.get("status")).toBe("open");
    expect(calls[1][0]).toBe("https://services.leadconnectorhq.com/opportunities/");
    expect(calls[1][1].method).toBe("POST");
    expect(JSON.parse(calls[1][1].body)).toEqual({
      pipelineId: "pipe-1", locationId: "loc-123", contactId: "c-9",
      pipelineStageId: "stage-new", name: "Acme — Alex Rowe", status: "open",
    });
  });

  it("names the deal with just the person when company is blank", async () => {
    global.fetch = mockWith(() => json({ opportunities: [] }));
    await worker.fetch(makeRequest("/lead", { ...lead, company_name: "" }), oenv);
    expect(JSON.parse(oppCalls(global.fetch)[1][1].body).name).toBe("Alex Rowe");
  });

  it("creates nothing and never sends a stage when a deal is open", async () => {
    global.fetch = mockWith(() => json({ opportunities: [{ id: "o-1", name: "Existing" }] }));
    await worker.fetch(makeRequest("/lead", lead), oenv);
    const calls = oppCalls(global.fetch);
    expect(calls).toHaveLength(1);
    expect(global.fetch.mock.calls.some(([, o]) => o?.body?.includes("pipelineStageId"))).toBe(false);
  });

  it("fills a blank name on the existing deal without a stage", async () => {
    global.fetch = mockWith(() => json({ opportunities: [{ id: "o-1", name: "" }] }));
    await worker.fetch(makeRequest("/lead", lead), oenv);
    const calls = oppCalls(global.fetch);
    expect(calls[1][0]).toBe("https://services.leadconnectorhq.com/opportunities/o-1");
    expect(calls[1][1].method).toBe("PUT");
    expect(JSON.parse(calls[1][1].body)).toEqual({ name: "Acme — Alex Rowe" });
  });

  it.each([
    ["403", () => json({ message: "forbidden" }, 403)],
    ["500", () => json({}, 500)],
    ["network", () => { throw new Error("down"); }],
  ])("still returns the normal success when search fails (%s)", async (_n, fail) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = mockWith(fail);
    const res = await worker.fetch(makeRequest("/lead", lead), oenv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contact_id: "c-9" });
  });

  it("still succeeds when the create call fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async (url, o) => {
      if (url.includes("/contacts/upsert")) return json({ contact: { id: "c-9" } });
      if (url.includes("/opportunities/search")) return json({ opportunities: [] });
      if (url.endsWith("/opportunities/")) return json({}, 422);
      return json({});
    });
    const res = await worker.fetch(makeRequest("/lead", lead), oenv);
    expect(await res.json()).toEqual({ contact_id: "c-9" });
  });

  it("writes nothing to GHL on honeypot or Turnstile rejection", async () => {
    global.fetch = mockWith(() => json({ opportunities: [] }));
    await worker.fetch(makeRequest("/lead", { ...lead, url: "spam" }), oenv);
    const r = await worker.fetch(makeRequest("/lead", lead), { ...oenv, TURNSTILE_SECRET_KEY: "s" });
    expect(r.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("/apply and /area-request make no opportunity calls", async () => {
    global.fetch = mockWith(() => json({ opportunities: [] }));
    const penv = { ...oenv, GHL_VPP_API_KEY: "k", GHL_VPP_LOCATION_ID: "p" };
    await worker.fetch(makeRequest("/area-request", { ...lead, postcode: "4870" }), penv);
    await worker.fetch(makeRequest("/apply", { ...lead, postcode: "4870", engagement_track: "employee" }), penv);
    expect(global.fetch).toHaveBeenCalled();
    expect(oppCalls(global.fetch)).toHaveLength(0);
  });
});

describe("POST /gate — tier tag, deal value, budget abandon", () => {
  const oenv = { ...env, SALES_PIPELINE_ID: "pipe-1", STAGE_NEW_LEAD_ID: "stage-new" };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  const gate = (budget, extra = {}) =>
    worker.fetch(
      makeRequest("/gate", { contact_id: "c-1", customFields: { facility_type: "office", monthly_budget: budget, cleaning_frequency: "daily", postcode: "4217", ...extra } }),
      oenv
    );
  const mk = ({ open = true, failTag = false, failOpp = false } = {}) =>
    vi.fn(async (url, o) => {
      if (url.includes("/opportunities/search")) return json({ opportunities: open ? [{ id: "o-1", name: "X" }] : [] });
      if (url.endsWith("/opportunities/")) return failOpp ? json({}, 500) : json({ opportunity: { id: "o-new" } });
      if (url.includes("/opportunities/")) return failOpp ? json({}, 500) : json({});
      if (url.includes("/tags")) return failTag ? json({}, 500) : json({});
      return json({ contact: { id: "c-1" } });
    });
  const tagBodies = (m) => m.mock.calls.filter(([u]) => u.includes("/tags")).map(([, o]) => JSON.parse(o.body).tags);
  const puts = (m) => m.mock.calls.filter(([u, o]) => u.includes("/opportunities/") && o?.method === "PUT");

  it("tags per tier via add-tags", async () => {
    for (const [b, tag] of [[6000, "priority-hot"], [2000, "priority-warm"], [1000, "nurture-budget"]]) {
      global.fetch = mk();
      await gate(b);
      expect(tagBodies(global.fetch)).toEqual([[tag]]);
    }
    global.fetch = mk();
    await gate(0, { cleaning_frequency: "monthly", facility_type: "x" });
    expect(tagBodies(global.fetch)).toEqual([["priority-warm"]]);
  });

  it("sets monetaryValue = budget x 12; none without a budget", async () => {
    global.fetch = mk();
    await gate(6000);
    expect(JSON.parse(puts(global.fetch)[0][1].body)).toEqual({ monetaryValue: 72000 });
    global.fetch = mk();
    await gate(0);
    expect(puts(global.fetch)).toHaveLength(0);
  });

  it("budget nurture abandons the open deal, no stage", async () => {
    global.fetch = mk();
    await gate(1000);
    const body = JSON.parse(puts(global.fetch)[0][1].body);
    expect(body).toEqual({ monetaryValue: 12000, status: "abandoned" });
    expect(body.pipelineStageId).toBeUndefined();
  });

  it("creates a New Lead deal when none is open, then abandons it", async () => {
    global.fetch = mk({ open: false });
    await gate(1000);
    const post = global.fetch.mock.calls.find(([u]) => u.endsWith("/opportunities/"));
    expect(JSON.parse(post[1].body).pipelineStageId).toBe("stage-new");
    expect(puts(global.fetch)[0][0]).toContain("/opportunities/o-new");
    expect(JSON.parse(puts(global.fetch)[0][1].body).status).toBe("abandoned");
  });

  it("failing tag/opportunity calls leave the body intact", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = mk({ failTag: true, failOpp: true });
    const res = await worker.fetch(
      makeRequest("/gate", { contact_id: "c-1", customFields: { facility_type: "office", monthly_budget: 6000, cleaning_frequency: "daily", postcode: "4217" } }),
      { ...oenv, BOOKING_TOKEN_SECRET: "s3cret" }
    );
    const body = await res.json();
    expect(body.tier).toBe("priority");
    expect(body.booking_token).toBeTruthy();
  });

  it("thrown tag/opportunity errors are swallowed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const base = mk();
    global.fetch = vi.fn(async (url, o) => {
      if (url.includes("/tags") || (url.includes("/opportunities/o-1") && o?.method === "PUT")) throw new Error("boom");
      return base(url, o);
    });
    const res = await gate(6000);
    expect((await res.json()).tier).toBe("priority");
  });
});
