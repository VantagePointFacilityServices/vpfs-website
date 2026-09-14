/**
 * Vantage Point — GHL Lead Scoring Worker (v3, two-stage lead gate + two-stage applicant funnel)
 *
 * Six endpoints, routed by path, all triggered by GHL webhooks:
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
 *                    rooms, current contract renewal date, etc. —
 *                    sent to Priority/Standard leads after they've
 *                    already booked). Adds detail fields to the
 *                    contact and refines the score, but never
 *                    re-triggers DQ or changes tier downward — it
 *                    only informs walkthrough prep and can bump
 *                    Standard -> Priority if the extra detail
 *                    justifies it (a large facility, or an existing
 *                    contract renewing soon enough that the prospect
 *                    is actually free to switch providers).
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
 *   POST /apply    — fires on the CAREERS PAGE Stage 1 capture form
 *                    (site/careers.html — name, phone, email,
 *                    postcode only). Checks the one DQ knowable this
 *                    early (service-area postcode) and, if it clears,
 *                    writes applicant_stage: "screening_survey_sent"
 *                    so a GHL workflow can send the mandatory Stage 2
 *                    screening survey. No fit score is calculated
 *                    here. An out-of-area applicant is routed straight
 *                    to Unsuccessful without ever seeing the survey.
 *
 *   POST /apply-screen — fires on the MANDATORY Stage 2 screening
 *                    survey (sent by SMS/email after /apply clears).
 *                    Scores a job applicant against hard eligibility
 *                    gates (minimum experience, right to work, police
 *                    check) plus a fit score (experience, availability,
 *                    transport, physical capability, attitude), and
 *                    routes the contact into one of three GHL
 *                    recruitment pipelines: Priority, Standard, or
 *                    Unsuccessful. Also captures Blue Card and subcontractor-
 *                    insurance status as non-scoring enrichment signals
 *                    (applicant_blue_card_eligible, applicant_subcontractor_ready)
 *                    for downstream HR decisions. Unsuccessful applicants
 *                    are still recorded (not deleted) — see the "why
 *                    capture unsuccessful applicants at all" note below.
 *
 * Mirrors the structure of the existing Xero <-> GHL sync worker.
 *
 * Field keys and stage semantics are documented in the vpos repo:
 * commercial/docs/lead-scoring-and-two-stage-gate-form.md (leads)
 * commercial/docs/recruitment-scoring-and-application-form.md (applicants)
 */

// ---- CONFIG ---------------------------------------------------------

const MIN_MONTHLY_SPEND = 800; // adjust to your actual floor
const MIN_WEEKLY_CLEANS = 3; // hard floor — anything under this is DQ'd
const SERVICE_POSTCODES = ["4227", "4226", "4211", "4212"]; // Gold Coast coverage zone — extend as needed
const CAPABLE_FACILITY_TYPES = ["office", "strata", "construction"]; // subcontractor bench currently supports these
// add "education", "medical" once Blue Card / clinical-cert bench is ready

// A lead's EXISTING cleaning contract (with another provider) renewing
// within this many months means they're actually free to switch soon —
// worth prioritising ahead of leads locked into a longer term, even if
// otherwise similarly scored. Stage 2a only (see handleEnrich) — never
// gates Stage 1 booking, since not knowing this yet (or not having an
// existing contract at all) isn't a reason to deprioritise anyone.
const CONTRACT_RENEWAL_PRIORITY_THRESHOLD_MONTHS = 6;

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// frequency string -> cleans-per-week, used against MIN_WEEKLY_CLEANS
const FREQUENCY_TO_WEEKLY = {
  daily: 5,
  few_times_week: 3,
  weekly: 1,
  fortnightly: 0.5,
};

// ---- CAREERS APPLICATION SCORING CONFIG --------------------------------
// Applicants share the same SERVICE_POSTCODES gate as leads — a cleaner
// who can't reasonably reach a Gold Coast site is a hard DQ the same way
// an out-of-area client site is, just from the other direction. The
// postcode gate is checked at Stage 1 (/apply); everything else below is
// checked at Stage 2 (/apply-screen).

// Cross-checked against standard AU commercial-cleaning recruitment
// practice: under 1 year of experience is now a hard floor, not just a
// low scoring band — see commercial/docs/recruitment-scoring-and-application-form.md
// ("Why a hard floor on experience now") in the vpos repo.
const MIN_EXPERIENCE_LEVELS = ["none", "under_1_year"]; // any of these -> hard DQ

const EXPERIENCE_SCORE = {
  none: 0,
  under_1_year: 0,
  "1_to_3_years": 25,
  "3_plus_years": 40,
};

const AVAILABILITY_SCORE = {
  weekends_only: 5,
  business_hours: 10,
  after_hours: 20,
  flexible: 25,
};

const PASSION_SCORE = {
  just_a_job: 0,
  take_pride: 5,
  genuinely_passionate: 10,
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
    if (url.pathname === "/apply") {
      return handleApply(contactId, payload, env);
    }
    if (url.pathname === "/apply-screen") {
      return handleApplyScreen(contactId, payload, env);
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

  const monthsUntilRenewal = monthsUntilContractRenewal(cf.contract_renewal_date);

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
    // Raw date kept for the walkthrough team's reference; the rounded
    // months-out figure is what GHL views/reports can actually sort or
    // filter on to prioritise the closest renewals first.
    contract_renewal_date: cf.contract_renewal_date,
    contract_renewal_months_out:
      monthsUntilRenewal === null ? undefined : Math.round(monthsUntilRenewal),
  };

  // Optional score bump: either a large facility OR an existing cleaning
  // contract (with another provider) renewing soon can independently
  // justify Standard -> Priority. A near-term renewal means the prospect
  // is actually free to switch providers soon — the whole reason this
  // signal is worth reprioritising for, same as size_sqm already does for
  // facility scale. Neither DQ's nor demotes; DQ was already decided at
  // the gate.
  const sizeSqm = Number(cf.size_sqm) || 0;
  const bumpReasons = [];
  if (sizeSqm >= 2000) {
    bumpReasons.push("large-facility");
  }
  if (
    monthsUntilRenewal !== null &&
    monthsUntilRenewal >= 0 &&
    monthsUntilRenewal <= CONTRACT_RENEWAL_PRIORITY_THRESHOLD_MONTHS
  ) {
    bumpReasons.push("near-term-contract-renewal");
  }
  const tierBump = bumpReasons.length > 0 ? "priority" : null;

  const updates = { ...stripUndefined(detailFields) };
  if (tierBump) {
    updates.lead_tier = tierBump;
  }

  const result = await writeBackToGHL(contactId, updates, env);

  return jsonResponse({
    contactId,
    stage: "enrich",
    tier_bump: tierBump,
    bump_reasons: bumpReasons,
    ghl_update: result,
  });
}

// Months (fractional) between now and a stated contract renewal date —
// negative if the date has already passed. Returns null for a missing or
// unparseable date rather than throwing, since this field is optional and
// free-text-adjacent (a date picker on the form, but the payload is still
// just a string). `now` is injectable so this stays a pure, deterministic
// function for testing rather than depending on the real clock.
function monthsUntilContractRenewal(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  if (Number.isNaN(target.getTime())) return null;
  const msPerMonth = 1000 * 60 * 60 * 24 * 30.4375; // average month length — fine for a threshold comparison
  return (target.getTime() - now.getTime()) / msPerMonth;
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

// ---- /apply — CAREERS PAGE STAGE 1 CAPTURE FORM ------------------------
// Short capture form (name/phone/email/postcode) — the only thing checked
// here is the postcode gate, since it's the one DQ knowable this early and
// there's no reason to send a full screening survey (with document
// uploads) to someone who can't be rostered regardless of fit. Everyone
// who clears gets no score yet — that happens at /apply-screen once the
// Stage 2 survey comes back.
async function handleApply(contactId, payload, env) {
  const f = extractApplyStartFields(payload);

  const dq = checkApplicantAreaDisqualifier(f);

  const writeback = dq.disqualified
    ? {
        applicant_tier: "unsuccessful",
        applicant_dq_flag: dq.reason,
        applicant_captured_at: new Date().toISOString(),
      }
    : {
        applicant_stage: "screening_survey_sent",
        applicant_dq_flag: "none",
        applicant_captured_at: new Date().toISOString(),
      };

  const result = await writeBackToGHL(contactId, { postcode: f.postcode, ...writeback }, env);

  return jsonResponse({
    contactId,
    stage: "apply",
    applicant_stage: dq.disqualified ? "unsuccessful" : "screening_survey_sent",
    tier: dq.disqualified ? "unsuccessful" : "pending",
    dq_flag: dq.reason || "none",
    ghl_update: result,
  });
}

function extractApplyStartFields(payload) {
  const cf = payload.customFields || payload.custom_fields || {};
  return {
    firstName: cf.first_name || "",
    lastName: cf.last_name || "",
    phone: cf.phone || "",
    email: cf.email || "",
    postcode: cf.postcode || "",
  };
}

// The one Stage 1 disqualifier — mirrors the lead gate's own Stage 1
// postcode DQ. No flex path (there's no "confirm" follow-up for this; an
// applicant who's genuinely out of area re-applies from scratch if they
// relocate).
function checkApplicantAreaDisqualifier(f) {
  if (f.postcode && !SERVICE_POSTCODES.includes(f.postcode)) {
    return { disqualified: true, reason: "unsuccessful-out-of-area" };
  }

  return { disqualified: false, reason: null };
}

// ---- /apply-screen — MANDATORY STAGE 2 SCREENING SURVEY -----------------
// Same shape as /gate: hard disqualifiers first, then a fit score for
// everyone who clears them. A failed hard disqualifier here still gets a
// fit score run for the record (see checkApplicantDisqualifiers) since
// none of these is a spectrum the applicant can flex on later — but we
// still want the fit data captured in case circumstances change and they
// re-apply down the track.
async function handleApplyScreen(contactId, payload, env) {
  const f = extractApplicantScreenFields(payload);

  const dq = checkApplicantDisqualifiers(f);
  const score = calculateApplicantScore(f);
  const tier = dq.disqualified ? "unsuccessful" : applicantTierFromScore(score);

  const blueCardEligible = f.blueCardStatus === "current_blue_card_held" || f.blueCardStatus === "willing_to_obtain";
  const subcontractorReady = f.hasOwnInsuranceAndAbn === "yes";

  const result = await writeBackToGHL(
    contactId,
    {
      applicant_score: score,
      applicant_tier: tier,
      applicant_dq_flag: dq.disqualified ? dq.reason : "none",
      applicant_screened_at: new Date().toISOString(),
      applicant_blue_card_eligible: blueCardEligible,
      applicant_subcontractor_ready: subcontractorReady,
      police_check_document: f.policeCheckDocument,
      blue_card_document: f.blueCardDocument,
      insurance_certificate: f.insuranceCertificate,
      start_availability: f.startAvailability,
    },
    env
  );

  return jsonResponse({
    contactId,
    stage: "apply-screen",
    score,
    tier,
    dq_flag: dq.reason || "none",
    blue_card_eligible: blueCardEligible,
    subcontractor_ready: subcontractorReady,
    ghl_update: result,
  });
}

function extractApplicantScreenFields(payload) {
  const cf = payload.customFields || payload.custom_fields || {};
  return {
    experience: (cf.cleaning_experience || "").toLowerCase(),
    rightToWork: (cf.right_to_work || "").toLowerCase(),
    policeCheckStatus: (cf.police_check_status || "").toLowerCase(),
    policeCheckDocument: cf.police_check_document || "",
    blueCardStatus: (cf.blue_card_status || "").toLowerCase(),
    blueCardDocument: cf.blue_card_document || "",
    hasOwnInsuranceAndAbn: (cf.has_own_insurance_and_abn || "").toLowerCase(),
    insuranceCertificate: cf.insurance_certificate || "",
    availability: (cf.availability || "").toLowerCase(),
    startAvailability: (cf.start_availability || "").toLowerCase(),
    reliableTransport: (cf.reliable_transport || "").toLowerCase(),
    physicalCapability: (cf.physical_capability || "").toLowerCase(),
    passion: (cf.passion_rating || "").toLowerCase(),
  };
}

// Hard gates only — legal/access/experience requirements with no flex
// path (there's no "confirm" follow-up for these; a "no" here is final
// unless the applicant's circumstances change and they re-apply).
// Availability/transport/attitude are scoring inputs, not gates — an
// applicant who clears the floor but is light on other fit dimensions
// should still be reachable in Standard, not auto-rejected. Blue Card and
// insurance/ABN status are captured elsewhere but deliberately never
// checked here — see the parent scoring doc's "Why Blue Card and insurance/
// ABN aren't hard disqualifiers" note.
function checkApplicantDisqualifiers(f) {
  if (MIN_EXPERIENCE_LEVELS.includes(f.experience)) {
    return { disqualified: true, reason: "unsuccessful-insufficient-experience" };
  }

  if (f.rightToWork === "no") {
    return { disqualified: true, reason: "unsuccessful-no-right-to-work" };
  }

  if (f.policeCheckStatus === "not_willing") {
    return { disqualified: true, reason: "unsuccessful-no-police-check" };
  }

  return { disqualified: false, reason: null };
}

function calculateApplicantScore(f) {
  let score = 0;

  score += EXPERIENCE_SCORE[f.experience] ?? 0;
  score += AVAILABILITY_SCORE[f.availability] ?? 0;
  score += PASSION_SCORE[f.passion] ?? 0;
  if (f.reliableTransport === "yes") score += 15;
  if (f.physicalCapability === "yes") score += 10;

  return Math.min(score, 100);
}

function applicantTierFromScore(score) {
  if (score >= 70) return "priority";
  if (score >= 30) return "standard";
  return "unsuccessful"; // cleared the hard gates but too weak a fit to actively pursue right now
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
export {
  checkDisqualifiers,
  calculateGateScore,
  tierFromScore,
  monthsUntilContractRenewal,
  checkApplicantAreaDisqualifier,
  checkApplicantDisqualifiers,
  calculateApplicantScore,
  applicantTierFromScore,
};
