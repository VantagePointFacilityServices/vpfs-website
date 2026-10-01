/**
 * Vantage Point — GHL Lead Scoring Worker (v3, two-stage lead gate + two-stage applicant funnel)
 *
 * Eight endpoints, routed by path. Most fire on GHL workflow webhooks, but
 * /lead, /gate and /slots are also called directly by the public browser (the
 * website's own two-step booking-gate JS), and /gate is additionally
 * called live by the AI Receptionist mid-call — see corsHeaders()/
 * withCors() below for the resulting origin-allowlist requirement:
 *
 *   POST /lead     — fires on the website's SHORT Step 1 capture form
 *                    (first/last name, email, phone, postcode — no DQ
 *                    fields yet). Upserts the GHL contact (matched by
 *                    email/phone), tags it website-lead, and returns its
 *                    contact_id, which the browser carries into /gate.
 *                    Never scores anything; channel is a pass-through
 *                    tag only.
 *
 *   POST /slots    — takes the signed booking_token from /gate and
 *                    returns the open walkthrough days/times from the
 *                    GHL calendar matching the token's tier.
 *
 *   POST /book     — takes the booking_token, a chosen start_time and
 *                    the site_address, books the walkthrough on the tier's
 *                    GHL calendar against the token's contact (address as
 *                    the appointment location) and saves it as the
 *                    contact's address1.
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

const MIN_MONTHLY_SPEND = 2000; // under this -> nurture-budget
const PRIORITY_MONTHLY_SPEND = 5000; // at or over this -> always Priority (see calculateGateScore)
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
// Calendars API (free-slots) is versioned separately from the Contacts API.
const GHL_CALENDARS_API_VERSION = "2021-04-15";
const SLOTS_WINDOW_DAYS = 30;
const DEFAULT_BOOKING_TIMEZONE = "Australia/Brisbane";

// Added to every contact /lead captures. GHL workflows start on a
// "Contact Tag → Tag Added: website-lead" trigger rather than an Inbound
// Webhook (a premium, per-execution trigger with a public URL).
const WEBSITE_LEAD_TAG = "website-lead";

// Cloudflare Turnstile — /lead's bot check. Only enforced once the
// TURNSTILE_SECRET_KEY secret is set, so the Worker can ship before the
// widget exists. A lead that couldn't be checked because Cloudflare itself
// was unreachable is still taken, but tagged so it can be eyeballed.
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_UNVERIFIED_TAG = "turnstile-unverified";

// frequency string -> cleans-per-week, used against MIN_WEEKLY_CLEANS
const FREQUENCY_TO_WEEKLY = {
  daily: 7,
  five_days_week: 5,
  three_days_week: 3,
  // Legacy value from the old "A few times a week" option — still accepted
  // in case the AI Receptionist or a GHL survey sends it.
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

// Endpoints are now called directly by the public browser (the website's
// booking gate), not just by trusted server-to-server callers (GHL
// workflow webhooks, the AI Receptionist's live /gate call) — so
// responses need an explicit CORS allowlist rather than none at all.
const ALLOWED_ORIGINS = [
  "https://www.vantagepointfacilityservices.com.au",
  "https://vantagepointfacilityservices.com.au",
];

function corsHeaders(request) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// Applied to every response this Worker returns (not just /gate's) so any
// future browser-facing endpoint gets the same allowlisted-origin behavior
// for free.
function withCors(request, response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    return withCors(request, await route(request, env));
  },
};

async function route(request, env) {
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

  if (url.pathname === "/lead") {
    return handleLead(payload, env, request);
  }
  if (url.pathname === "/slots") {
    return handleSlots(payload, env);
  }
  if (url.pathname === "/book") {
    return handleBook(payload, env);
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
}

// ---- /lead — STEP 1 CONTACT CAPTURE ------------------------------------
// Called directly by the browser (not a GHL webhook) when the website's
// short "Book a Walkthrough" form (name/email/phone) is submitted. No DQ
// fields exist yet at this point — this endpoint only creates the GHL
// contact and returns its id, which the browser then carries into the
// Step 2 DQ questions and passes to /gate. See
// commercial/docs/lead-scoring-and-two-stage-gate-form.md in the vpos repo.
async function handleLead(payload, env, request) {
  const f = extractLeadFields(payload);

  if (f.honeypot) {
    // Bot filled the invisible field — respond as if successful without
    // ever calling the GHL API, so nothing is created and the bot isn't
    // tipped off that it was caught.
    return jsonResponse({ contact_id: null });
  }

  const turnstile = await verifyTurnstile(
    payload.turnstile_token,
    request.headers.get("CF-Connecting-IP"),
    env
  );
  if (turnstile === "rejected") {
    return new Response("Verification failed", { status: 403 });
  }

  if (!f.email || !f.phone) {
    return new Response("Missing required field: email and phone are required", { status: 400 });
  }

  const result = await upsertContactInGHL(f, env);

  if (!result.success) {
    return jsonResponse({ contact_id: null, ghl_error: result.error });
  }

  // The contact already exists by now, so a failed tag call must not stop
  // the visitor reaching Step 2 — it only means the tag-triggered GHL
  // workflow won't fire for this lead.
  const tags = [WEBSITE_LEAD_TAG];
  if (turnstile === "unverified") tags.push(TURNSTILE_UNVERIFIED_TAG);
  await addTagsInGHL(result.contactId, tags, env);

  return jsonResponse({ contact_id: result.contactId });
}

// Returns "passed", "rejected", or "unverified" (Cloudflare unreachable —
// fail open so a Cloudflare outage never costs a real enquiry), or "skipped"
// when no secret is configured.
async function verifyTurnstile(token, remoteIp, env) {
  if (!env.TURNSTILE_SECRET_KEY) return "skipped";
  if (!token) return "rejected";

  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        stripUndefined({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: remoteIp })
      ),
    });
    if (!res.ok) return "unverified";
    const data = await res.json();
    return data.success ? "passed" : "rejected";
  } catch (err) {
    return "unverified";
  }
}

function extractLeadFields(payload) {
  return {
    firstName: payload.first_name || "",
    lastName: payload.last_name || "",
    email: payload.email || "",
    phone: payload.phone || "",
    // Captured in Step 1 now (see assets/js/booking-gate.js), but not a
    // DQ input here — /gate still runs the actual service-area check
    // once the browser sends this same value back under customFields.
    postcode: payload.postcode || "",
    // Pass-through tag only — identifies which form/page the lead came
    // from (website-homepage, website-contact, ...). Never a DQ input;
    // checkDisqualifiers()/calculateGateScore() never read it.
    channel: payload.channel || "",
    honeypot: payload.url || "",
    utm_source: payload.utm_source,
    utm_medium: payload.utm_medium,
    utm_campaign: payload.utm_campaign,
    utm_term: payload.utm_term,
    utm_content: payload.utm_content,
  };
}

// ---- Booking token (signed, stateless) ----------------------------------
// base64url(JSON{cid,tier,exp}) + "." + base64url(HMAC-SHA256(payloadPart)).
// Lets /slots and /book trust the contact + tier without re-asking the browser.

const BOOKING_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const BOOKING_TIERS = ["priority", "standard", "standard-flagged"];

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("bad base64url");
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function hmacKey(env, usage) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BOOKING_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

async function signBookingToken({ cid, tier }, env) {
  if (!env.BOOKING_TOKEN_SECRET) return null;
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ cid, tier, exp: Date.now() + BOOKING_TOKEN_TTL_MS }))
  );
  const key = await hmacKey(env, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyBookingToken(token, env) {
  if (!env.BOOKING_TOKEN_SECRET || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await hmacKey(env, "verify");
    // crypto.subtle.verify compares in constant time.
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(parts[1]),
      new TextEncoder().encode(parts[0])
    );
    if (!ok) return null;
    const { cid, tier, exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (typeof cid !== "string" || !cid || !BOOKING_TIERS.includes(tier)) return null;
    if (typeof exp !== "number" || Date.now() >= exp) return null;
    return { cid, tier };
  } catch {
    return null;
  }
}

function calendarIdForTier(tier, env) {
  if (tier === "priority") return env.CALENDAR_PRIORITY_ID || null;
  if (tier === "standard" || tier === "standard-flagged") return env.CALENDAR_STANDARD_ID || null;
  return null;
}

// ---- /slots — OPEN WALKTHROUGH TIMES -----------------------------------
// Browser-called with the signed booking_token from /gate. The calendar is
// chosen only from the verified token's tier — never from the request body.
async function handleSlots(payload, env) {
  if (!env.BOOKING_TOKEN_SECRET) {
    return new Response("Booking not configured", { status: 503 });
  }
  const claims = await verifyBookingToken(payload && payload.booking_token, env);
  if (!claims) {
    return new Response("Invalid booking token", { status: 403 });
  }
  const calendarId = calendarIdForTier(claims.tier, env);
  if (!calendarId) {
    return slotsUnavailable();
  }

  const timezone = env.BOOKING_TIMEZONE || DEFAULT_BOOKING_TIMEZONE;
  const now = Date.now();
  const params = new URLSearchParams({
    startDate: String(now),
    endDate: String(now + SLOTS_WINDOW_DAYS * 24 * 60 * 60 * 1000),
    timezone,
  });

  let data;
  try {
    const res = await fetch(`${GHL_API_BASE}/calendars/${calendarId}/free-slots?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.GHL_API_KEY}`,
        Version: GHL_CALENDARS_API_VERSION,
      },
    });
    if (!res.ok) return slotsUnavailable();
    data = await res.json();
  } catch {
    return slotsUnavailable();
  }

  // GHL returns { "YYYY-MM-DD": { slots: [...] }, ... } plus a traceId.
  const days = Object.keys(data || {})
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .map((date) => {
      const raw = data[date];
      const list = Array.isArray(raw) ? raw : raw && raw.slots;
      return { date, slots: Array.isArray(list) ? [...list].sort() : [] };
    })
    .filter((d) => d.slots.length > 0);

  return jsonResponse({ timezone, window_days: SLOTS_WINDOW_DAYS, days });
}

function slotsUnavailable() {
  return new Response(JSON.stringify({ error: "slots_unavailable" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- /book — CONFIRM A WALKTHROUGH TIME --------------------------------
// Browser-called. Contact and calendar come only from the verified token;
// start_time is validated server-side (now → now + 30 days).
async function handleBook(payload, env) {
  if (!env.BOOKING_TOKEN_SECRET) {
    return new Response("Booking not configured", { status: 503 });
  }
  const claims = await verifyBookingToken(payload && payload.booking_token, env);
  if (!claims) {
    return new Response("Invalid booking token", { status: 403 });
  }

  const startRaw = payload && payload.start_time;
  const startMs = typeof startRaw === "string" ? Date.parse(startRaw) : NaN;
  const now = Date.now();
  if (
    !Number.isFinite(startMs) ||
    startMs <= now ||
    startMs > now + SLOTS_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ) {
    return new Response("Invalid start_time", { status: 400 });
  }

  const siteAddress = typeof (payload && payload.site_address) === "string" ? payload.site_address.trim() : "";
  if (!siteAddress || siteAddress.length > 200) {
    return new Response("Invalid site_address", { status: 400 });
  }

  const calendarId = calendarIdForTier(claims.tier, env);
  if (!calendarId) return bookingFailed();

  const headers = {
    Authorization: `Bearer ${env.GHL_API_KEY}`,
    Version: GHL_CALENDARS_API_VERSION,
    "Content-Type": "application/json",
  };

  let endTime;
  try {
    // Already has an upcoming, non-cancelled appointment? Create nothing.
    const listRes = await fetch(
      `${GHL_API_BASE}/contacts/${encodeURIComponent(claims.cid)}/appointments`,
      { method: "GET", headers }
    );
    if (!listRes.ok) return bookingFailed();
    const listed = await listRes.json();
    const existing = (Array.isArray(listed && listed.events) ? listed.events : [])
      .filter((e) => {
        const status = String(e.appointmentStatus || e.status || "").toLowerCase();
        const t = Date.parse(e.startTime);
        return status !== "cancelled" && status !== "canceled" && Number.isFinite(t) && t > now;
      })
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))[0];
    if (existing) {
      return new Response(
        JSON.stringify({ error: "already_booked", start_time: existing.startTime }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // GHL does not infer endTime; derive it from the calendar's slot length.
    const calRes = await fetch(`${GHL_API_BASE}/calendars/${calendarId}`, { method: "GET", headers });
    if (!calRes.ok) return bookingFailed();
    const cal = ((await calRes.json()) || {}).calendar || {};
    const duration = Number(cal.slotDuration) > 0 ? Number(cal.slotDuration) : 30;
    const unit = String(cal.slotDurationUnit || "mins").toLowerCase();
    const durationMs = (unit.startsWith("hour") ? 3600000 : 60000) * duration;
    endTime = formatLikeStart(startRaw, startMs + durationMs);

    const res = await fetch(`${GHL_API_BASE}/calendars/events/appointments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        calendarId,
        locationId: env.GHL_LOCATION_ID,
        contactId: claims.cid,
        startTime: startRaw,
        endTime,
        title: "Walkthrough",
        appointmentStatus: "confirmed",
        toNotify: true,
        address: siteAddress,
      }),
    });
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {}
      if ([400, 409, 422].includes(res.status) && /slot|available|booked/i.test(text)) {
        return new Response(JSON.stringify({ error: "slot_unavailable" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return bookingFailed();
    }
  } catch {
    return bookingFailed();
  }

  // Best effort: the booking already exists, so a failure here must not fail it.
  let contactAddressSaved = false;
  try {
    const putRes = await fetch(`${GHL_API_BASE}/contacts/${encodeURIComponent(claims.cid)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GHL_API_KEY}`,
        "Content-Type": "application/json",
        Version: GHL_API_VERSION,
      },
      body: JSON.stringify({ address1: siteAddress }),
    });
    contactAddressSaved = putRes.ok;
  } catch {}

  const out = { booked: true, start_time: startRaw, end_time: endTime };
  if (!contactAddressSaved) out.contact_address_saved = false;
  return jsonResponse(out);
}

// Renders endMs with the same UTC offset as the start string, so the
// returned/sent times stay in the calendar's local time.
function formatLikeStart(startRaw, endMs) {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(startRaw);
  if (!m) return new Date(endMs).toISOString();
  const offMin = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const local = new Date(endMs + offMin * 60000).toISOString().slice(0, 19);
  return `${local}${m[1]}${m[2]}:${m[3]}`;
}

function bookingFailed() {
  return new Response(JSON.stringify({ error: "booking_failed" }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

// ---- /gate — SHORT QUALIFYING FORM -------------------------------------

async function handleGate(contactId, payload, env) {
  const f = extractGateFields(payload);
  const utm = extractUtmFields(payload);

  const dq = checkDisqualifiers(f);
  const flags = leadFlags(f);

  let tier, score;

  if (dq.disqualified) {
    tier = "nurture";
    score = 0;
  } else {
    score = calculateGateScore(f);
    tier = tierFromScore(score);
  }

  // Speed-to-lead: the SLA flag written to the contact drives GHL workflow
  // 29's breach escalation (vpos). Priority: call within 5 minutes.
  // Standard — and standard-flagged, which books the same Standard
  // calendar — call within 15 minutes. Nurture gets no SLA.
  const slaFlag =
    tier === "priority"
      ? "call-within-5min"
      : tier === "standard" || tier === "standard-flagged"
        ? "call-within-15min"
        : "none";

  const result = await writeBackToGHL(
    contactId,
    {
      lead_score: score,
      lead_tier: tier,
      dq_flag: dq.disqualified ? dq.reason : "none",
      lead_flags: flags.length > 0 ? flags.join(",") : "none",
      sla_flag: slaFlag,
      lead_captured_at: new Date().toISOString(),
      // The visitor's own Step 2 answers, so the team can see them on the
      // contact (the AI Receptionist also writes these itself). Blanks are
      // stripped so a missing answer never wipes an existing value.
      ...stripUndefined({
        facility_type: f.facilityType,
        monthly_budget: f.monthlyBudget || undefined,
        cleaning_frequency: f.frequency,
      }),
      ...stripUndefined(utm),
    },
    env
  );

  const bookingToken = BOOKING_TIERS.includes(tier)
    ? await signBookingToken({ cid: contactId, tier }, env)
    : null;

  return jsonResponse({
    contactId,
    stage: "gate",
    score,
    tier,
    dq_flag: dq.reason || "none",
    lead_flags: flags,
    sla_flag: slaFlag,
    ghl_update: result,
    ...(bookingToken ? { booking_token: bookingToken } : {}),
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

// Budget is the only disqualifier: under $2,000/month -> nurture, no
// calendar. Everything else a lead can fall short on is recorded by
// leadFlags() for the team to review, but never blocks a booking.
function checkDisqualifiers(f) {
  if (f.monthlyBudget > 0 && f.monthlyBudget < MIN_MONTHLY_SPEND) {
    return { disqualified: true, reason: "nurture-budget" };
  }

  return { disqualified: false, reason: null };
}

// Service-fit concerns worth a look before the walkthrough — written to the
// contact as lead_flags. Blank answers are never flagged.
function leadFlags(f) {
  const flags = [];

  const weeklyCleans = FREQUENCY_TO_WEEKLY[f.frequency] ?? 0;
  if (f.frequency && weeklyCleans < MIN_WEEKLY_CLEANS) flags.push("low-frequency");

  if (f.facilityType && !CAPABLE_FACILITY_TYPES.includes(f.facilityType)) flags.push("capability-gap");

  if (f.postcode && !SERVICE_POSTCODES.includes(f.postcode)) flags.push("out-of-area");

  return flags;
}

// Budget decides the tier on its own: $5,000+ scores 70 (always Priority,
// since tierFromScore's cut-off is 70), $2,000–$4,999 scores 30 and can reach
// at most 60 with the other factors (always Standard). Frequency and facility
// fit only rank leads within their tier.
function calculateGateScore(f) {
  let score = 0;

  // Budget tier (0-70)
  if (f.monthlyBudget >= PRIORITY_MONTHLY_SPEND) score += 70;
  else if (f.monthlyBudget >= MIN_MONTHLY_SPEND) score += 30;

  // Frequency (0-20)
  const weeklyCleans = FREQUENCY_TO_WEEKLY[f.frequency] ?? 0;
  if (weeklyCleans >= 7) score += 20;
  else if (weeklyCleans >= 5) score += 15;
  else if (weeklyCleans >= 3) score += 10;

  // Facility type fit (0-10)
  if (f.facilityType === "strata" || f.facilityType === "office") score += 10;
  else if (f.facilityType === "construction") score += 5;

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

// Creates the GHL contact, or updates the existing one matched by
// email/phone — a repeat enquiry from the same person gets their existing
// contact_id back instead of a duplicate-contact error. Distinct from
// writeBackToGHL below, which only PUTs updates onto a known contact id.
// Tags are deliberately never sent here — on an existing contact the
// upsert can overwrite its tags — so they go through addTagsInGHL's
// additive endpoint instead.
async function upsertContactInGHL(f, env) {
  const url = `${GHL_API_BASE}/contacts/upsert`;

  const customFields = Object.entries({
    postcode: f.postcode,
    channel: f.channel,
    utm_source: f.utm_source,
    utm_medium: f.utm_medium,
    utm_campaign: f.utm_campaign,
    utm_term: f.utm_term,
    utm_content: f.utm_content,
  })
    .filter(([, value]) => value)
    .map(([key, value]) => ({ key, field_value: String(value) }));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: GHL_API_VERSION,
    },
    body: JSON.stringify({
      locationId: env.GHL_LOCATION_ID,
      firstName: f.firstName,
      lastName: f.lastName,
      email: f.email,
      phone: f.phone,
      customFields,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: errText };
  }

  const data = await res.json();
  return { success: true, contactId: data.contact?.id };
}

// Additive — appends to the contact's existing tags rather than replacing
// them.
async function addTagsInGHL(contactId, tags, env) {
  const url = `${GHL_API_BASE}/contacts/${contactId}/tags`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: GHL_API_VERSION,
    },
    body: JSON.stringify({ tags }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { success: false, status: res.status, error: errText };
  }

  return { success: true };
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
  signBookingToken,
  verifyBookingToken,
  calendarIdForTier,
  checkDisqualifiers,
  leadFlags,
  calculateGateScore,
  tierFromScore,
  monthsUntilContractRenewal,
  checkApplicantAreaDisqualifier,
  checkApplicantDisqualifiers,
  calculateApplicantScore,
  applicantTierFromScore,
};
