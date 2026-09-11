/**
 * Vantage Point — GHL Lead Scoring Worker (v2, two-stage form)
 *
 * Four endpoints, routed by path, all triggered by GHL webhooks:
 *
 *   POST /gate     — fires on the SHORT qualifying form (contact
 *                    details + facility_type + monthly_budget +
 *                    cleaning_frequency + postcode). Runs hard
 *                    disqualifiers, calculates an initial score from
 *                    the few fields available, writes lead_tier and
 *                    routes the pipeline. This is the only endpoint
 *                    that determines DQ vs qualified. Also captures
 *                    UTM params for source attribution.
 *
 *   POST /enrich   — fires on the OPTIONAL post-booking facility
 *                    detail survey (bathrooms, kitchens, meeting
 *                    rooms, etc. — sent to Priority/Standard leads
 *                    after they've already booked). Adds detail
 *                    fields to the contact and refines the score,
 *                    but never re-triggers DQ or changes tier
 *                    downward — it only informs walkthrough prep and
 *                    can bump Standard -> Priority if the extra
 *                    detail justifies it.
 *
 *   POST /confirm  — fires on the MANDATORY budget/frequency
 *                    confirmation follow-up sent to disqualified
 *                    leads. If flexible and the flexed value clears
 *                    the relevant minimum, re-routes the contact out
 *                    of nurture into Standard/Priority scoring.
 *
 *   POST /outcome  — fires on two distinct pipeline events:
 *                      - walkthrough no-show (after reschedule
 *                        attempts are exhausted)
 *                      - proposal marked Lost after a completed
 *                        walkthrough
 *                    Both route the contact into their own nurture
 *                    segment, distinct from gate-stage DQ segments,
 *                    since these leads already passed qualification.
 *
 * Mirrors the structure of the existing Xero <-> GHL sync worker.
 *
 * Field keys and stage semantics are documented in the vpos repo:
 * commercial/docs/lead-scoring-and-two-stage-gate-form.md
 */

// ---- CONFIG ---------------------------------------------------------

const MIN_MONTHLY_SPEND = 800; // adjust to your actual floor
const MIN_WEEKLY_CLEANS = 3; // hard floor — anything under this is DQ'd
const SERVICE_POSTCODES = ["4227", "4226", "4211", "4212"]; // Gold Coast coverage zone — extend as needed
const CAPABLE_FACILITY_TYPES = ["office", "strata", "construction"]; // subcontractor bench currently supports these
// add "education", "medical" once WWCC / clinical-cert bench is ready

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// frequency string -> cleans-per-week, used against MIN_WEEKLY_CLEANS
const FREQUENCY_TO_WEEKLY = {
  daily: 5,
  few_times_week: 3,
  weekly: 1,
  fortnightly: 0.5,
};

// ---- ENTRY POINT ------------------------------------------------------

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return new Response("Invalid JSON", { status: 400 });
    }

    const contactId = payload.contact_id || payload.contactId;
    if (!contactId) {
      return new Response("Missing contact_id", { status: 400 });
    }

    if (url.pathname === "/gate") {
      return handleGate(contactId, payload, env);
    }
    if (url.pathname === "/enrich") {
      return handleEnrich(contactId, payload, env);
    }
    if (url.pathname === "/confirm") {
      return handleConfirm(contactId, payload, env);
    }
    if (url.pathname === "/outcome") {
      return handleOutcome(contactId, payload, env);
    }

    return new Response("Unknown route", { status: 404 });
  },
};

// ---- /gate — SHORT QUALIFYING FORM -------------------------------------

async function handleGate(contactId, payload, env) {
  const f = extractGateFields(payload);
  const utm = extractUtmFields(payload);

  const dq = checkDisqualifiers(f);

  let tier, score;

  if (dq.disqualified) {
    tier = "nurture";
    score = 0;
  } else {
    score = calculateGateScore(f);
    tier = tierFromScore(score);
  }

  // Speed-to-lead: Priority tier gets a timestamp + explicit SLA flag
  // written to the contact so a GHL workflow can trigger an
  // immediate call/SMS task (target: contact within 5-15 min) rather
  // than sitting in the normal queue. Standard gets a same-day flag.
  const slaFlag =
    tier === "priority" ? "call-within-15min" : tier === "standard" ? "call-same-day" : "none";

  const result = await writeBackToGHL(
    contactId,
    {
      lead_score: score,
      lead_tier: tier,
      dq_flag: dq.disqualified ? dq.reason : "none",
      sla_flag: slaFlag,
      lead_captured_at: new Date().toISOString(),
      ...stripUndefined(utm),
    },
    env
  );

  return jsonResponse({
    contactId,
    stage: "gate",
    score,
    tier,
    dq_flag: dq.reason || "none",
    sla_flag: slaFlag,
    ghl_update: result,
  });
}

function extractUtmFields(payload) {
  // Pulled from hidden form fields populated by URL params client-side
  // — not asked of the lead, so this adds zero friction to the gate.
  const cf = payload.customFields || payload.custom_fields || {};
  return {
    utm_source: cf.utm_source,
    utm_medium: cf.utm_medium,
    utm_campaign: cf.utm_campaign,
    utm_term: cf.utm_term,
    utm_content: cf.utm_content,
  };
}

function extractGateFields(payload) {
  const cf = payload.customFields || payload.custom_fields || {};
  // Note: gate only collects postcode (via address-autocomplete API),
  // not full street address — that's gathered later in /enrich once
  // the lead has committed to a booking, to keep the gate form short.
  return {
    facilityType: (cf.facility_type || "").toLowerCase(),
    monthlyBudget: Number(cf.monthly_budget) || 0,
    postcode: cf.postcode || "",
    frequency: (cf.cleaning_frequency || "").toLowerCase(),
  };
}

function checkDisqualifiers(f) {
  if (f.monthlyBudget > 0 && f.monthlyBudget < MIN_MONTHLY_SPEND) {
    return { disqualified: true, reason: "nurture-budget" };
  }

  const weeklyCleans = FREQUENCY_TO_WEEKLY[f.frequency] ?? 0;
  if (f.frequency && weeklyCleans < MIN_WEEKLY_CLEANS) {
    return { disqualified: true, reason: "nurture-frequency" };
  }

  if (f.facilityType && !CAPABLE_FACILITY_TYPES.includes(f.facilityType)) {
    return { disqualified: true, reason: "nurture-capability-gap" };
  }

  if (f.postcode && !SERVICE_POSTCODES.includes(f.postcode)) {
    return { disqualified: true, reason: "nurture-out-of-area" };
  }

  return { disqualified: false, reason: null };
}

// Scoring with only the gate's 4 fields available — coarser than the
// old full model, but that's fine: this score only needs to split
// qualified leads into Priority vs Standard, not rank them precisely.
function calculateGateScore(f) {
  let score = 0;

  // Budget tier (0-50)
  if (f.monthlyBudget >= MIN_MONTHLY_SPEND * 3) score += 50;
  else if (f.monthlyBudget >= MIN_MONTHLY_SPEND * 2) score += 30;
  else if (f.monthlyBudget >= MIN_MONTHLY_SPEND) score += 10;

  // Frequency (0-30)
  const weeklyCleans = FREQUENCY_TO_WEEKLY[f.frequency] ?? 0;
  if (weeklyCleans >= 5) score += 30;
  else if (weeklyCleans >= 3) score += 15;

  // Facility type fit (0-20)
  if (f.facilityType === "strata" || f.facilityType === "office") score += 20;
  else if (f.facilityType === "construction") score += 10;

  return Math.min(score, 100);
}

function tierFromScore(score) {
  if (score >= 70) return "priority";
  if (score >= 30) return "standard";
  return "standard-flagged"; // qualified (passed DQ) but low score — still bookable, lower priority
}

// ---- /enrich — OPTIONAL POST-BOOKING FACILITY DETAIL SURVEY ------------
// Sent only to priority/standard tiers after they've booked. Adds
// walkthrough-prep detail and can bump the tier UP, never down or
// back into nurture — DQ was already decided at the gate.
async function handleEnrich(contactId, payload, env) {
  const cf = payload.customFields || payload.custom_fields || {};

  const detailFields = {
    size_sqm: cf.size_sqm,
    headcount: cf.headcount,
    floor_count: cf.floor_count,
    lifts_present: cf.lifts_present,
    bathroom_count: cf.bathroom_count,
    kitchen_count: cf.kitchen_count,
    breakroom_count: cf.breakroom_count,
    meeting_room_count: cf.meeting_room_count,
    special_requests: cf.special_requests,
    supplies_provided: cf.supplies_provided,
    equipment_needed: cf.equipment_needed,
  };

  // Optional score bump: a large facility can justify Standard -> Priority
  const sizeSqm = Number(cf.size_sqm) || 0;
  let tierBump = null;
  if (sizeSqm >= 2000) {
    tierBump = "priority";
  }

  const updates = { ...stripUndefined(detailFields) };
  if (tierBump) {
    updates.lead_tier = tierBump;
  }

  const result = await writeBackToGHL(contactId, updates, env);

  return jsonResponse({ contactId, stage: "enrich", tier_bump: tierBump, ghl_update: result });
}

// ---- /confirm — MANDATORY CONFIRMATION FOR DISQUALIFIED LEADS ----------
// Single-question follow-up, tailored to why the lead was DQ'd:
//   - nurture-budget    -> "is your budget a hard ceiling, or is there
//                           flexibility?"
//   - nurture-frequency -> "would you consider 3x/week at a better
//                           rate, or is that frequency fixed?"
// If flexible on the relevant dimension and the flexed value clears
// the minimum, re-run gate-style scoring and promote out of nurture.
// Other DQ reasons (capability-gap, out-of-area) have no flex path —
// those aren't things the lead can change, so /confirm isn't sent for
// them; that routing decision lives in the GHL workflow, not here.
async function handleConfirm(contactId, payload, env) {
  const cf = payload.customFields || payload.custom_fields || {};
  const dqReason = (cf.dq_flag || "").toLowerCase();

  if (dqReason === "nurture-frequency") {
    return handleFrequencyConfirm(contactId, cf, env);
  }

  // Default / nurture-budget path
  return handleBudgetConfirm(contactId, cf, env);
}

async function handleBudgetConfirm(contactId, cf, env) {
  const isFlexible = (cf.budget_flexible || "").toLowerCase() === "yes";
  const flexibleAmount = Number(cf.flexible_budget_amount) || 0;

  if (!isFlexible || flexibleAmount < MIN_MONTHLY_SPEND) {
    // Confirmed hard ceiling below minimum — stays in nurture as-is
    const result = await writeBackToGHL(
      contactId,
      { dq_flag: "nurture-budget-confirmed" },
      env
    );
    return jsonResponse({
      contactId,
      stage: "confirm",
      dimension: "budget",
      requalified: false,
      ghl_update: result,
    });
  }

  // Requalified — re-score using the flexible amount
  const score = calculateGateScore({
    monthlyBudget: flexibleAmount,
    frequency: (cf.cleaning_frequency || "").toLowerCase(),
    facilityType: (cf.facility_type || "").toLowerCase(),
  });
  const tier = tierFromScore(score);

  const result = await writeBackToGHL(
    contactId,
    {
      lead_score: score,
      lead_tier: tier,
      dq_flag: "none",
      monthly_budget: flexibleAmount,
    },
    env
  );

  return jsonResponse({
    contactId,
    stage: "confirm",
    dimension: "budget",
    requalified: true,
    score,
    tier,
    ghl_update: result,
  });
}

async function handleFrequencyConfirm(contactId, cf, env) {
  const isFlexible = (cf.frequency_flexible || "").toLowerCase() === "yes";
  const flexibleFrequency = (cf.flexible_frequency || "").toLowerCase(); // e.g. "few_times_week"
  const weeklyCleans = FREQUENCY_TO_WEEKLY[flexibleFrequency] ?? 0;

  if (!isFlexible || weeklyCleans < MIN_WEEKLY_CLEANS) {
    // Confirmed fixed below the floor — stays in nurture as-is
    const result = await writeBackToGHL(
      contactId,
      { dq_flag: "nurture-frequency-confirmed" },
      env
    );
    return jsonResponse({
      contactId,
      stage: "confirm",
      dimension: "frequency",
      requalified: false,
      ghl_update: result,
    });
  }

  // Requalified — re-score using the flexed frequency, still checking budget
  const monthlyBudget = Number(cf.monthly_budget) || 0;
  if (monthlyBudget > 0 && monthlyBudget < MIN_MONTHLY_SPEND) {
    // Frequency is fine now, but budget alone still fails the floor
    const result = await writeBackToGHL(contactId, { dq_flag: "nurture-budget" }, env);
    return jsonResponse({
      contactId,
      stage: "confirm",
      dimension: "frequency",
      requalified: false,
      ghl_update: result,
    });
  }

  const score = calculateGateScore({
    monthlyBudget,
    frequency: flexibleFrequency,
    facilityType: (cf.facility_type || "").toLowerCase(),
  });
  const tier = tierFromScore(score);

  const result = await writeBackToGHL(
    contactId,
    {
      lead_score: score,
      lead_tier: tier,
      dq_flag: "none",
      cleaning_frequency: flexibleFrequency,
    },
    env
  );

  return jsonResponse({
    contactId,
    stage: "confirm",
    dimension: "frequency",
    requalified: true,
    score,
    tier,
    ghl_update: result,
  });
}

// ---- /outcome — NO-SHOW AND LOST-AT-PROPOSAL EVENTS --------------------
// Both events fire from GHL pipeline-stage-change workflows, not from
// a lead-facing form. Payload includes an `outcome_type` field set by
// the workflow itself: "no_show" or "lost_at_proposal".
//
// No-show: after N missed walkthrough attempts (reschedule offers
// exhausted), demote back into nurture with its own segment — not
// the same drip as a DQ'd lead, since this contact already passed
// qualification and just didn't show up.
//
// Lost-at-proposal: contact saw an actual walkthrough and a real
// quote, then said no. Warmer than a DQ or no-show, so it gets a
// shorter re-engagement cycle and objection-specific follow-up
// rather than the standard 60-90 day DQ cadence.
async function handleOutcome(contactId, payload, env) {
  const cf = payload.customFields || payload.custom_fields || {};
  const outcomeType = (cf.outcome_type || payload.outcome_type || "").toLowerCase();

  if (outcomeType === "no_show") {
    const attemptCount = Number(cf.reschedule_attempts) || 1;
    const result = await writeBackToGHL(
      contactId,
      {
        lead_tier: "nurture",
        dq_flag: "nurture-no-show",
        noshow_attempts: attemptCount,
      },
      env
    );
    return jsonResponse({ contactId, stage: "outcome", outcome_type: "no_show", ghl_update: result });
  }

  if (outcomeType === "lost_at_proposal") {
    const lossReason = (cf.loss_reason || "unspecified").toLowerCase(); // e.g. "price", "timing", "chose_competitor"
    const result = await writeBackToGHL(
      contactId,
      {
        lead_tier: "nurture",
        dq_flag: `nurture-lost-${lossReason}`,
        lost_at_proposal_date: new Date().toISOString(),
      },
      env
    );
    return jsonResponse({
      contactId,
      stage: "outcome",
      outcome_type: "lost_at_proposal",
      loss_reason: lossReason,
      ghl_update: result,
    });
  }

  return new Response("Unknown outcome_type", { status: 400 });
}

// ---- SHARED HELPERS -----------------------------------------------------

function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function writeBackToGHL(contactId, values, env) {
  const url = `${GHL_API_BASE}/contacts/${contactId}`;

  const customFields = Object.entries(values).map(([key, value]) => ({
    key,
    field_value: String(value),
  }));

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: GHL_API_VERSION,
    },
    body: JSON.stringify({ customFields }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: errText };
  }

  return { success: true };
}

// Exported for unit testing (test/scoring.test.js) — pure, no network
// dependency, so these can be tested without the workerd runtime.
export { checkDisqualifiers, calculateGateScore, tierFromScore };
