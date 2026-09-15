import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../worker.js";

const env = { GHL_API_KEY: "test-key" };

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

describe("POST /lead", () => {
  it("creates a GHL contact and returns its contact_id", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contact: { id: "new-contact-1" } }), { status: 200 })
    );

    const req = makeRequest("/lead", {
      first_name: "Alex",
      last_name: "Rowe",
      email: "alex@example.com",
      phone: "0400000000",
      channel: "website-homepage",
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.contact_id).toBe("new-contact-1");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer test-key");

    const sentBody = JSON.parse(options.body);
    expect(sentBody.firstName).toBe("Alex");
    expect(sentBody.lastName).toBe("Rowe");
    expect(sentBody.email).toBe("alex@example.com");
    expect(sentBody.phone).toBe("0400000000");
  });

  it("writes channel as a custom field on the created contact", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ contact: { id: "new-contact-2" } }), { status: 200 })
    );

    const req = makeRequest("/lead", {
      first_name: "Jamie",
      last_name: "Lee",
      email: "jamie@example.com",
      phone: "0411111111",
      channel: "website-contact",
    });

    await worker.fetch(req, env);

    const [, options] = global.fetch.mock.calls[0];
    const sentBody = JSON.parse(options.body);
    const channelField = sentBody.customFields.find((f) => f.key === "channel");
    expect(channelField.field_value).toBe("website-contact");
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

  it("surfaces a failed GHL contact-creation call without throwing", async () => {
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
  });
});

describe("POST /gate", () => {
  it("qualifies a strong lead into priority with a 15-min SLA flag", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c1",
      customFields: {
        facility_type: "office",
        monthly_budget: "3000",
        postcode: "4211",
        cleaning_frequency: "daily",
        utm_source: "google",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier).toBe("priority");
    expect(json.sla_flag).toBe("call-within-15min");
    expect(json.dq_flag).toBe("none");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
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
    global.fetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
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
        monthly_budget: "2000",
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
        monthly_budget: "1000",
        postcode: "4211",
        cleaning_frequency: "daily",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier).toBe("standard");
    expect(json.sla_flag).toBe("call-same-day");
  });

  it("accepts custom_fields (snake_case) as an alternative to customFields", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/gate", {
      contact_id: "c14",
      custom_fields: { monthly_budget: "3000", cleaning_frequency: "daily", facility_type: "office", postcode: "4211" },
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
      customFields: { budget_flexible: "yes", flexible_budget_amount: "2000" },
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
      custom_fields: { dq_flag: "nurture-budget", budget_flexible: "yes", flexible_budget_amount: "2000" },
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

describe("POST /apply (Stage 1 — careers.html capture form)", () => {
  it("clears an in-area applicant to the screening survey stage, unscored", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply", {
      contact_id: "a1",
      customFields: {
        first_name: "Sam",
        last_name: "Lee",
        phone: "0400000000",
        email: "sam@example.com",
        postcode: "4211",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.applicant_stage).toBe("screening_survey_sent");
    expect(json.tier).toBe("pending");
    expect(json.dq_flag).toBe("none");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/a1");
    expect(options.method).toBe("PUT");

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.applicant_stage).toBe("screening_survey_sent");
    expect(fields.applicant_dq_flag).toBe("none");
    expect(fields.postcode).toBe("4211");
    expect(fields.applicant_tier).toBeUndefined();
  });

  it("routes an out-of-area applicant straight to unsuccessful without sending a survey", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply", {
      contact_id: "a2",
      customFields: { first_name: "Jo", phone: "0400000000", email: "jo@example.com", postcode: "9999" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.applicant_stage).toBe("unsuccessful");
    expect(json.tier).toBe("unsuccessful");
    expect(json.dq_flag).toBe("unsuccessful-out-of-area");

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.applicant_tier).toBe("unsuccessful");
    expect(fields.applicant_dq_flag).toBe("unsuccessful-out-of-area");
    expect(fields.applicant_stage).toBeUndefined();
  });

  it("accepts custom_fields (snake_case) as an alternative to customFields", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply", {
      contact_id: "a3",
      custom_fields: { first_name: "Sam", phone: "0400000000", email: "sam@example.com", postcode: "4211" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.applicant_stage).toBe("screening_survey_sent");
  });

  it("treats a completely empty customFields object as clearing the (missing) postcode gate", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply", { contact_id: "a4", customFields: {} });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dq_flag).toBe("none");
    expect(json.applicant_stage).toBe("screening_survey_sent");
  });

  it("surfaces a failed GHL write without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const req = makeRequest("/apply", {
      contact_id: "a5",
      customFields: { first_name: "Sam", phone: "0400000000", email: "sam@example.com", postcode: "4211" },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ghl_update.success).toBe(false);
    expect(json.ghl_update.status).toBe(500);
  });
});

describe("POST /apply-screen (Stage 2 — mandatory screening survey)", () => {
  it("qualifies a strong applicant into priority", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b1",
      customFields: {
        cleaning_experience: "3_plus_years",
        right_to_work: "yes",
        police_check_status: "current_check_held",
        police_check_document: "https://files.example.com/npc.pdf",
        blue_card_status: "not_applicable",
        has_own_insurance_and_abn: "no",
        availability: "flexible",
        start_availability: "immediately",
        reliable_transport: "yes",
        physical_capability: "yes",
        passion_rating: "genuinely_passionate",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.tier).toBe("priority");
    expect(json.dq_flag).toBe("none");
    expect(json.score).toBe(100);
    expect(json.blue_card_eligible).toBe(false);
    expect(json.subcontractor_ready).toBe(false);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/contacts/b1");
    expect(options.method).toBe("PUT");

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.applicant_tier).toBe("priority");
    expect(fields.applicant_score).toBe("100");
    expect(fields.applicant_dq_flag).toBe("none");
    expect(fields.police_check_document).toBe("https://files.example.com/npc.pdf");
  });

  it("scores a mid-range applicant into standard", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b2",
      customFields: {
        cleaning_experience: "1_to_3_years",
        right_to_work: "yes",
        police_check_status: "willing_no_current_check",
        availability: "business_hours",
        reliable_transport: "yes",
        physical_capability: "no",
        passion_rating: "take_pride",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier).toBe("standard");
    expect(json.dq_flag).toBe("none");
  });

  it("routes an under-1-year-experience applicant straight to unsuccessful without a fit gate", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b3",
      customFields: {
        cleaning_experience: "under_1_year",
        right_to_work: "yes",
        police_check_status: "willing_no_current_check",
        availability: "flexible",
        reliable_transport: "yes",
        physical_capability: "yes",
        passion_rating: "genuinely_passionate",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier).toBe("unsuccessful");
    expect(json.dq_flag).toBe("unsuccessful-insufficient-experience");
    // Fit score is still calculated and recorded even though the tier is
    // forced to unsuccessful, so the applicant's data isn't discarded.
    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.applicant_score).toBe("60");
    expect(fields.applicant_tier).toBe("unsuccessful");
  });

  it("routes a no-right-to-work applicant to unsuccessful", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b4",
      customFields: {
        cleaning_experience: "3_plus_years",
        right_to_work: "no",
        police_check_status: "willing_no_current_check",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dq_flag).toBe("unsuccessful-no-right-to-work");
    expect(json.tier).toBe("unsuccessful");
  });

  it("routes a police-check refusal to unsuccessful", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b5",
      customFields: {
        cleaning_experience: "3_plus_years",
        right_to_work: "yes",
        police_check_status: "not_willing",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dq_flag).toBe("unsuccessful-no-police-check");
    expect(json.tier).toBe("unsuccessful");
  });

  it("the weakest-possible applicant who still clears the hard gates lands at the Standard floor, not Unsuccessful", async () => {
    // With the 1-year experience floor now a hard DQ, the lowest score any
    // eligible applicant can post is 25 (min experience) + 5 (min
    // availability) + 0 + 0 + 0 = 30 — exactly Standard's floor. An
    // eligible-but-weak applicant can no longer land in Unsuccessful via
    // fit score alone; only a hard DQ routes there now. See the parent
    // scoring doc's feedback-loop note on this consequence.
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b6",
      customFields: {
        cleaning_experience: "1_to_3_years",
        right_to_work: "yes",
        police_check_status: "willing_no_current_check",
        availability: "weekends_only",
        reliable_transport: "no",
        physical_capability: "no",
        passion_rating: "just_a_job",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.score).toBe(30);
    expect(json.tier).toBe("standard");
    expect(json.dq_flag).toBe("none");
  });

  it("flags Blue-Card-eligible and subcontractor-ready enrichment signals without affecting score or tier", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b7",
      customFields: {
        cleaning_experience: "1_to_3_years",
        right_to_work: "yes",
        police_check_status: "willing_no_current_check",
        blue_card_status: "willing_to_obtain",
        has_own_insurance_and_abn: "yes",
        insurance_certificate: "https://files.example.com/coc.pdf",
        availability: "business_hours",
        reliable_transport: "yes",
        physical_capability: "no",
        passion_rating: "take_pride",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.tier).toBe("standard");
    expect(json.blue_card_eligible).toBe(true);
    expect(json.subcontractor_ready).toBe(true);

    const fields = fieldsFromLastCall(global.fetch);
    expect(fields.applicant_blue_card_eligible).toBe("true");
    expect(fields.applicant_subcontractor_ready).toBe("true");
    expect(fields.insurance_certificate).toBe("https://files.example.com/coc.pdf");
  });

  it("accepts custom_fields (snake_case) as an alternative to customFields", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", {
      contact_id: "b8",
      custom_fields: {
        cleaning_experience: "3_plus_years",
        right_to_work: "yes",
        police_check_status: "willing_no_current_check",
        availability: "flexible",
        reliable_transport: "yes",
        physical_capability: "yes",
        passion_rating: "genuinely_passionate",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();
    expect(json.tier).toBe("priority");
  });

  it("treats a completely empty customFields object as a qualifying zero-score applicant", async () => {
    global.fetch = mockGhlOk();
    const req = makeRequest("/apply-screen", { contact_id: "b9", customFields: {} });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(json.dq_flag).toBe("none");
    expect(json.score).toBe(0);
    expect(json.tier).toBe("unsuccessful");
  });

  it("surfaces a failed GHL write without throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const req = makeRequest("/apply-screen", {
      contact_id: "b10",
      customFields: {
        cleaning_experience: "3_plus_years",
        right_to_work: "yes",
        police_check_status: "willing_no_current_check",
      },
    });

    const res = await worker.fetch(req, env);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ghl_update.success).toBe(false);
    expect(json.ghl_update.status).toBe(500);
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
