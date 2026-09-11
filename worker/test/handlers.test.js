import { describe, it, expect, beforeEach, vi } from "vitest";
import worker from "../worker.js";

const env = { GHL_API_KEY: "test-key" };

function makeRequest(path, body, { method = "POST" } = {}) {
  const init = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

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
