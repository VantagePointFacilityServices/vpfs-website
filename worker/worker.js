/**
 * Vantage Point — GHL Lead Scoring Worker (v3, two-stage lead gate + two-stage applicant funnel)
 *
 * Ten endpoints, routed by path. Most fire on GHL workflow webhooks, but
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
 *                    Never scores anything; conversion_page is a
 *                    pass-through tag and lead_channel is derived from
 *                    the visitor's utms/click ids/referrer. Then, best
 *                    effort, ensures one open Sales Pipeline deal in New
 *                    Lead (SALES_PIPELINE_ID / STAGE_NEW_LEAD_ID; needs the
 *                    opportunities.readonly + opportunities.write scopes).
 *                    Existing deals keep their stage; failures are only
 *                    logged. /apply and /area-request never create deals.
 *
 *   POST /area-request — the Locations page's "Request a new area" form
 *                    (name, email, phone, postcode). Upserts the GHL
 *                    contact and tags it new-area-request (not
 *                    website-lead). Same honeypot + Turnstile as /lead.
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
 *   POST /outcome  — fires when a proposal is marked Lost after a
 *                    completed walkthrough, routing the contact into
 *                    its own nurture segment, distinct from gate-stage
 *                    DQ segments. (No-show /outcome is retired.)
 *
 *   POST /apply    — fires from the browser on the careers and
 *                    subcontractor pages' Step 1 form (name, email,
 *                    phone, postcode, engagement track). Creates or
 *                    updates the contact in the PEOPLE GHL sub-account
 *                    (never the commercial one — see peopleEnv), writes
 *                    engagement_track / postcode / applicant_stage:
 *                    "started" / applicant_completion_pct: 33 /
 *                    applicant_captured_at, tags it
 *                    applicant-employee or applicant-subcontractor and
 *                    returns { contact_id } so the browser can open the
 *                    Step 2 dialog. Same Turnstile + honeypot handling
 *                    as /area-request.
 *
 *   POST /apply-screen — browser-called Step 2 of the applicant funnel.
 *                    Applies the per-track disqualifiers and fit score
 *                    (PRD D18), writes score/tier/dq flag/stage to the
 *                    contact in the people sub-account, plus
 *                    applicant_completion_pct (67 for book/shortlist,
 *                    100 for unsuccessful), and returns
 *                    { tier, result: book | shortlist | unsuccessful,
 *                    dq_flag, booking_token? }. Employees get "shortlist"
 *                    while EMPLOYEE_INTAKE_OPEN is not "true".
 *
 * Mirrors the structure of the existing Xero <-> GHL sync worker.
 *
 * Field keys and stage semantics are documented in the vpos repo:
 * commercial/docs/lead-scoring-and-two-stage-gate-form.md (leads)
 * commercial/docs/recruitment-scoring-and-application-form.md (applicants)
 */

// ---- CONFIG ---------------------------------------------------------

const MIN_MONTHLY_SPEND = 1500; // under this -> nurture-budget
const PRIORITY_MONTHLY_SPEND = 5000; // at or over this -> always Priority (see calculateGateScore)
const MIN_WEEKLY_CLEANS = 3; // hard floor — anything under this is DQ'd

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

// ---- LAUNCH AREA ---------------------------------------------------
// One postcode list for both the lead gate (/gate) and applicant screening
// (/apply-screen): the launch-area decision, vpos Vol 1 §2.7b.
//
// Gold Coast and Tweed Shire, checked 2026-10-13:
// - City of Gold Coast suburbs sit in 4207-4230 (Wikipedia "List of Gold
//   Coast suburbs"). 4207 is shared with Logan (Beenleigh, Eagleby) and is
//   kept because it borders the northern Gold Coast sites.
// - Tweed Shire is 2484-2490 (NSW Electoral Commission, Tweed council
//   localities): 2484 Murwillumbah/Uki/Tyalgum, 2485 Tweed Heads, 2486
//   Banora Point/Terranora, 2487 Kingscliff, 2488 Cabarita, 2489 Pottsville,
//   2490 Tumbulgum.
// Left out on purpose (Blake, 2026-10-13): 2483 (mostly Byron Shire) and the
// 4270-4275 hinterland (mostly Scenic Rim).
const LAUNCH_AREA_POSTCODES = [
  ...Array.from({ length: 24 }, (_, i) => String(4207 + i)), // Gold Coast 4207-4230
  ...Array.from({ length: 7 }, (_, i) => String(2484 + i)), // Tweed Shire 2484-2490
];

// Under 1 year of experience is a hard floor on both tracks (PRD D18).
const MIN_EXPERIENCE_LEVELS = ["none", "under_1_year"]; // any of these -> hard DQ

// Experience points differ per track (PRD v3 D5). Employee: experience 55 +
// availability 30 + transport 15. Subcontractor: experience 60 + availability 40.
const EXPERIENCE_SCORE = {
  employee: { none: 0, under_1_year: 0, "1_to_3_years": 35, "3_plus_years": 55 },
  subcontractor: {
    none: 0,
    under_1_year: 0,
    "1_to_3_years": 35,
    "3_to_5_years": 48,
    "5_plus_years": 60,
  },
};

// Experience scores the higher of the commercial and residential points.
const RESIDENTIAL_EXPERIENCE_SCORE = {
  employee: { none: 0, under_1_year: 0, "1_to_3_years": 20, "3_plus_years": 35 },
  subcontractor: {
    none: 0,
    under_1_year: 0,
    "1_to_3_years": 20,
    "3_to_5_years": 28,
    "5_plus_years": 35,
  },
};

const AVAILABILITY_SCORE = {
  employee: { weekends_only: 5, business_hours: 10, after_hours: 25, flexible: 30 },
  subcontractor: { weekends_only: 8, business_hours: 15, after_hours: 32, flexible: 40 },
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
  if (url.pathname === "/area-request") {
    return handleAreaRequest(payload, env, request);
  }
  if (url.pathname === "/apply") {
    return handleApply(payload, env, request);
  }
  if (url.pathname === "/apply-screen") {
    return handleApplyScreen(payload, env);
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
  return new Response("Unknown route", { status: 404 });
}

// ---- /lead — STEP 1 CONTACT CAPTURE ------------------------------------
// Called directly by the browser (not a GHL webhook) when the website's
// short "Book a Walkthrough" form (name/email/phone) is submitted. No DQ
// fields exist yet at this point — this endpoint only creates the GHL
// contact and returns its id, which the browser then carries into the
// Step 2 DQ questions and passes to /gate. See
// commercial/docs/lead-scoring-and-two-stage-gate-form.md in the vpos repo.
const MAX_COMPANY_NAME_LENGTH = 200;

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

  if (f.companyName.length > MAX_COMPANY_NAME_LENGTH) {
    return new Response(JSON.stringify({ error: "company_name_too_long" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
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

  // Best-effort: never changes the response (see ensureNewLeadDeal).
  await ensureNewLeadDeal(result.contactId, f, env);

  return jsonResponse({ contact_id: result.contactId });
}

// Every /lead ends with exactly one open Sales Pipeline deal in New Lead.
// Search first (no duplicates); an existing deal keeps its stage — the
// Worker never sends pipelineStageId on update — and only gets a name if
// it has none. Any failure (incl. 401/403 before the token has
// opportunities.* scopes) is logged and swallowed.
async function ensureNewLeadDeal(contactId, f, env) {
  try {
    if (!env.SALES_PIPELINE_ID || !env.STAGE_NEW_LEAD_ID) return null;
    const headers = {
      Authorization: `Bearer ${env.GHL_VPFS_API_KEY}`,
      "Content-Type": "application/json",
      Version: GHL_API_VERSION,
    };
    const qs = new URLSearchParams({
      location_id: env.GHL_VPFS_LOCATION_ID,
      contact_id: contactId,
      pipeline_id: env.SALES_PIPELINE_ID,
      status: "open",
    });
    const searchRes = await fetch(`${GHL_API_BASE}/opportunities/search?${qs}`, { headers });
    if (!searchRes.ok) {
      console.error(`opportunity search failed for contact ${contactId}: ${searchRes.status}`);
      return null;
    }
    const found = (await searchRes.json()).opportunities?.[0];
    const dealName = (c) => {
      const person = `${c.firstName || ""} ${c.lastName || ""}`.trim();
      return c.companyName ? `${c.companyName} — ${person}` : person;
    };
    let name = dealName(f);

    if (!found) {
      // /gate passes no name (phone leads never call /lead) — read it from
      // the contact, since GHL needs a non-empty deal name.
      if (!name) {
        const cRes = await fetch(`${GHL_API_BASE}/contacts/${contactId}`, { headers });
        if (cRes.ok) name = dealName((await cRes.json()).contact || {});
        else console.error(`contact lookup failed for contact ${contactId}: ${cRes.status}`);
      }
      name = name || "New lead";
      const res = await fetch(`${GHL_API_BASE}/opportunities/`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pipelineId: env.SALES_PIPELINE_ID,
          locationId: env.GHL_VPFS_LOCATION_ID,
          contactId,
          pipelineStageId: env.STAGE_NEW_LEAD_ID,
          name,
          status: "open",
        }),
      });
      if (!res.ok) {
        console.error(`opportunity create failed for contact ${contactId}: ${res.status}`);
        return null;
      }
      const created = await res.json().catch(() => ({}));
      return created?.opportunity?.id || created?.id || null;
    } else if (!found.name && name) {
      const res = await fetch(`${GHL_API_BASE}/opportunities/${found.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name }),
      });
      if (!res.ok) console.error(`opportunity update failed for contact ${contactId}: ${res.status}`);
    }
    return found?.id || null;
  } catch (err) {
    console.error(`opportunity call errored for contact ${contactId}: ${err?.message}`);
    return null;
  }
}

// /gate's GHL side: the tier tag (replaces the retired "Website Gate Tag
// Mapping" workflow), the deal's value (budget x 12) and, for budget
// nurture, status "abandoned". Best-effort — never throws, never changes
// the /gate response. pipelineStageId is never sent on update.
async function applyGateOutcomeToGHL(contactId, tier, dqReason, monthlyBudget, env) {
  try {
    const tag =
      tier === "priority"
        ? "priority-hot"
        : tier === "standard" || tier === "standard-flagged"
          ? "priority-warm"
          : dqReason === "nurture-budget"
            ? "nurture-budget"
            : null;
    if (tag) {
      const r = await addTagsInGHL(contactId, [tag], env);
      if (!r.success) console.error(`gate tag failed for contact ${contactId}: ${r.status}`);
    }
  } catch (err) {
    console.error(`gate tag errored for contact ${contactId}: ${err?.message}`);
  }
  try {
    const abandon = tier === "nurture" && dqReason === "nurture-budget";
    if (!abandon && !(monthlyBudget > 0)) {
      // Nothing to write — still make sure a deal exists (phone leads).
      await ensureNewLeadDeal(contactId, {}, env);
      return;
    }
    const dealId = await ensureNewLeadDeal(contactId, {}, env);
    if (!dealId) return;
    const body = {};
    if (monthlyBudget > 0) body.monetaryValue = monthlyBudget * 12;
    if (abandon) body.status = "abandoned";
    const res = await fetch(`${GHL_API_BASE}/opportunities/${dealId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GHL_VPFS_API_KEY}`,
        "Content-Type": "application/json",
        Version: GHL_API_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`gate opportunity update failed for contact ${contactId}: ${res.status}`);
  } catch (err) {
    console.error(`gate opportunity errored for contact ${contactId}: ${err?.message}`);
  }
}

// ---- /area-request — "REQUEST A NEW AREA" ------------------------------
// Called by the browser from the Locations page form. Same contact upsert as
// /lead, but tagged new-area-request — never website-lead, so the walkthrough
// booking workflows don't start. A GHL workflow on that tag follows up once
// the postcode is covered.
const AREA_REQUEST_TAG = "new-area-request";
const AREA_REQUEST_CONVERSION_PAGE = "website-locations-area-request";

async function handleAreaRequest(payload, env, request) {
  const f = { ...extractLeadFields(payload), conversionPage: AREA_REQUEST_CONVERSION_PAGE, marketingConsent: false };

  // Bot filled the invisible field — look successful, create nothing.
  if (f.honeypot) return jsonResponse({ ok: true });

  const turnstile = await verifyTurnstile(
    payload.turnstile_token,
    request.headers.get("CF-Connecting-IP"),
    env
  );
  if (turnstile === "rejected") {
    return new Response("Verification failed", { status: 403 });
  }

  if (!f.email || !f.phone || !f.postcode) {
    return new Response("Missing required field: email, phone and postcode are required", { status: 400 });
  }

  const result = await upsertContactInGHL(f, env);
  if (!result.success) {
    return new Response("Could not save the request", { status: 502 });
  }

  const tags = [AREA_REQUEST_TAG];
  if (turnstile === "unverified") tags.push(TURNSTILE_UNVERIFIED_TAG);
  await addTagsInGHL(result.contactId, tags, env);

  return jsonResponse({ ok: true });
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
    // Optional on purpose: a visitor on a cached old page has no field.
    companyName: typeof payload.company_name === "string" ? payload.company_name.trim() : "",
    email: payload.email || "",
    phone: payload.phone || "",
    // Captured in Step 1 now (see assets/js/booking-gate.js), but not a
    // DQ input here — /gate still runs the actual service-area check
    // once the browser sends this same value back under customFields.
    postcode: payload.postcode || "",
    // Pass-through tag only — identifies which page's form the lead
    // converted on (website-homepage, website-contact, ...). Never a DQ
    // input; checkDisqualifiers()/calculateGateScore() never read it.
    conversionPage: payload.conversion_page || "",
    honeypot: payload.url || "",
    // Strict boolean only: consent is never inferred from "true", "on" or 1.
    marketingConsent: payload.marketing_consent === true,
    utm_source: payload.utm_source,
    utm_medium: payload.utm_medium,
    utm_campaign: payload.utm_campaign,
    utm_term: payload.utm_term,
    utm_content: payload.utm_content,
    // Only read by deriveLeadChannel() — never written to the contact.
    gclid: payload.gclid,
    gbraid: payload.gbraid,
    wbraid: payload.wbraid,
    msclkid: payload.msclkid,
    fbclid: payload.fbclid,
    referrerHost: payload.referrer_host,
  };
}

// ---- Lead channel ---------------------------------------------------------
// How the visitor found us, named after GA4's default channel groups so the
// two line up in reports. Separate from conversion_page, which is where
// they filled in the form. Precedence: an ad click id (Google Ads
// auto-tagging sends gclid with no utms) > utm tags > the external
// referrer > direct. Tags it can't place are "unassigned" rather than
// guessed. Last-touch, like the utms: a repeat enquiry overwrites it.

const CLICK_IDS_PAID_SEARCH = ["gclid", "gbraid", "wbraid", "msclkid"];
const PAID_SEARCH_MEDIUM = /^(cpc|ppc|paid|paid[_-]?search|sem)$/;
const PAID_SOCIAL_MEDIUM = /^paid[_-]?social$/;
const SOCIAL_SOURCE = /^(facebook|fb|instagram|ig|meta|linkedin|twitter|x|tiktok|youtube|pinterest|reddit|threads)$/;
const SOCIAL_MEDIUM = /^(social|social[_-]?media|organic[_-]?social|sm)$/;
const EMAIL_MEDIUM = /^(email|e-mail|newsletter)$/;
const SEARCH_HOST = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|baidu|yandex)(\.[a-z]{2,3}){1,2}$|^search\.brave\.com$/;
const SOCIAL_HOST = /(^|\.)(facebook|instagram|linkedin|twitter|tiktok|youtube|pinterest|reddit|threads)\.(com|net)$|^(t\.co|x\.com|lnkd\.in)$/;

function deriveLeadChannel(f) {
  if (CLICK_IDS_PAID_SEARCH.some((id) => f[id])) return "paid_search";

  const medium = String(f.utm_medium || "").trim().toLowerCase();
  const source = String(f.utm_source || "").trim().toLowerCase();
  const paidMedium = PAID_SEARCH_MEDIUM.test(medium);

  if (PAID_SOCIAL_MEDIUM.test(medium)) return "paid_social";
  if (paidMedium) return SOCIAL_SOURCE.test(source) || f.fbclid ? "paid_social" : "paid_search";
  if (EMAIL_MEDIUM.test(medium)) return "email";
  if (SOCIAL_MEDIUM.test(medium)) return "organic_social";
  if (medium === "organic") return "organic_search";
  if (medium === "referral") return "referral";
  if (SOCIAL_SOURCE.test(source)) return "organic_social";
  if (medium || source || f.utm_campaign || f.utm_term || f.utm_content) return "unassigned";

  if (f.fbclid) return "organic_social";

  const host = String(f.referrerHost || "").trim().toLowerCase();
  if (!host) return "direct";
  if (SEARCH_HOST.test(host)) return "organic_search";
  if (SOCIAL_HOST.test(host)) return "organic_social";
  return "referral";
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

async function signBookingToken({ cid, tier, aud, track }, env) {
  if (!env.BOOKING_TOKEN_SECRET) return null;
  const claims = { cid, tier, exp: Date.now() + BOOKING_TOKEN_TTL_MS };
  if (aud) claims.aud = aud; // applicant tokens carry { aud: "applicant", track }
  if (track) claims.track = track;
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
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
    const { cid, tier, exp, aud, track } = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    if (typeof cid !== "string" || !cid || !BOOKING_TIERS.includes(tier)) return null;
    if (typeof exp !== "number" || Date.now() >= exp) return null;
    // Lead tokens have no aud claim and keep their original shape. An aud
    // is only ever "applicant", and then must name a known track.
    if (aud === undefined) return { cid, tier };
    if (aud !== "applicant" || !APPLICANT_TRACKS.includes(track)) return null;
    return { cid, tier, aud, track };
  } catch {
    return null;
  }
}

// What /slots and /book use for a verified token: lead tokens (no aud) keep
// the lead walkthrough calendars and the commercial credentials; applicant
// tokens use the track's interview calendar and the people credentials.
// Returns null when the calendar or credentials aren't configured.
function bookingContext(claims, env) {
  if (claims.aud === "applicant") {
    const calendarId =
      claims.track === "employee"
        ? env.CALENDAR_INTERVIEW_EMPLOYEE_ID
        : claims.track === "subcontractor"
          ? env.CALENDAR_INTERVIEW_SUBCONTRACTOR_ID
          : null;
    if (!calendarId || !env.GHL_VPP_API_KEY || !env.GHL_VPP_LOCATION_ID) return null;
    return { calendarId, genv: peopleEnv(env), applicant: true };
  }
  const calendarId = calendarIdForTier(claims.tier, env);
  return calendarId ? { calendarId, genv: env, applicant: false } : null;
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
  const bctx = bookingContext(claims, env);
  if (!bctx) {
    return slotsUnavailable();
  }
  const { calendarId, genv } = bctx;

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
        Authorization: `Bearer ${genv.GHL_VPFS_API_KEY}`,
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
      return { date, slots: Array.isArray(list) ? normaliseSlots(list) : [] };
    })
    .filter((d) => d.slots.length > 0);

  return jsonResponse({ timezone, window_days: SLOTS_WINDOW_DAYS, days });
}

// Standard calendars list free slots as start-time strings. Group/class
// calendars (the interview calendars) may report each as an object with the
// seats left; a full class (0 seats) is not bookable, so drop it.
function normaliseSlots(list) {
  const out = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push(item);
    } else if (item && typeof item === "object") {
      const start = item.startTime || item.slot || item.start;
      const seats = item.seatsLeft ?? item.availableSeats ?? item.seats;
      if (typeof start === "string" && !(typeof seats === "number" && seats <= 0)) out.push(start);
    }
  }
  return out.sort();
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

  // Applicants book an interview, not a site walkthrough: no address.
  const isApplicant = claims.aud === "applicant";
  const siteAddress = typeof (payload && payload.site_address) === "string" ? payload.site_address.trim() : "";
  if (!isApplicant && (!siteAddress || siteAddress.length > 200)) {
    return new Response("Invalid site_address", { status: 400 });
  }

  const bctx = bookingContext(claims, env);
  if (!bctx) return bookingFailed();
  const { calendarId, genv } = bctx;

  const headers = {
    Authorization: `Bearer ${genv.GHL_VPFS_API_KEY}`,
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
        locationId: genv.GHL_VPFS_LOCATION_ID,
        contactId: claims.cid,
        startTime: startRaw,
        endTime,
        title: isApplicant ? "Group interview" : "Walkthrough",
        appointmentStatus: "confirmed",
        toNotify: true,
        ...(isApplicant ? {} : { address: siteAddress }),
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

  if (isApplicant) {
    // Best effort: the booking already exists, so a failed tag must not fail it.
    try {
      await addTagsInGHL(claims.cid, [APPLICANT_INTERVIEW_BOOKED_TAG], genv);
    } catch {}
    return jsonResponse({ booked: true, start_time: startRaw, end_time: endTime });
  }

  // Best effort: the booking already exists, so a failure here must not fail it.
  let contactAddressSaved = false;
  try {
    const putRes = await fetch(`${GHL_API_BASE}/contacts/${encodeURIComponent(claims.cid)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GHL_VPFS_API_KEY}`,
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

  // Before the write-back so the custom-field write stays the last GHL call.
  await applyGateOutcomeToGHL(contactId, tier, dq.reason, f.monthlyBudget, env);

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

// Budget is the only disqualifier: under $1,500/month -> nurture, no
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

  if (f.postcode && !LAUNCH_AREA_POSTCODES.includes(f.postcode)) flags.push("out-of-area");

  return flags;
}

// Budget decides the tier on its own: $5,000+ scores 70 (always Priority,
// since tierFromScore's cut-off is 70), $1,500–$4,999 scores 30 and can reach
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
// Other DQ reasons (out-of-area) have no flex path —
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

// ---- /apply — APPLICANT STEP 1 CAPTURE ----------------------------------
// Called by the browser from the careers and subcontractor pages. Creates or
// updates the applicant in the PEOPLE sub-account and returns contact_id; the
// postcode check now happens in Step 2 (/apply-screen), as /gate does for
// leads. If the people credentials aren't configured this refuses (503)
// rather than ever falling back to the commercial account.
const APPLICANT_TRACKS = ["employee", "subcontractor"];
const APPLICANT_INTERVIEW_BOOKED_TAG = "applicant-interview-booked";

// The GHL helpers read GHL_VPFS_API_KEY / GHL_VPFS_LOCATION_ID, so putting the
// VPP (people) pair in those slots reuses them unchanged for the VPP sub-account.
function peopleEnv(env) {
  return { ...env, GHL_VPFS_API_KEY: env.GHL_VPP_API_KEY, GHL_VPFS_LOCATION_ID: env.GHL_VPP_LOCATION_ID };
}

async function handleApply(rawPayload, env, request) {
  // Trim every string input so padded values never reach GHL.
  const payload = Object.fromEntries(
    Object.entries(rawPayload).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
  );
  const f = {
    ...extractLeadFields(payload),
    conversionPage: "",
    marketingConsent: false,
  };
  const track = typeof payload.engagement_track === "string" ? payload.engagement_track.trim() : "";

  // Bot filled the invisible field — look successful, create nothing.
  if (f.honeypot) return jsonResponse({ ok: true });

  const turnstile = await verifyTurnstile(
    payload.turnstile_token,
    request.headers.get("CF-Connecting-IP"),
    env
  );
  if (turnstile === "rejected") {
    return new Response("Verification failed", { status: 403 });
  }

  if (!f.email || !f.phone || !f.postcode) {
    return new Response("Missing required field: email, phone and postcode are required", { status: 400 });
  }
  if (!APPLICANT_TRACKS.includes(track)) {
    return new Response("Invalid engagement_track", { status: 400 });
  }

  if (!env.GHL_VPP_API_KEY || !env.GHL_VPP_LOCATION_ID) {
    return new Response("Applicant intake is not configured", { status: 503 });
  }
  const penv = peopleEnv(env);

  f.extraFields = {
    engagement_track: track,
    applicant_stage: "started",
    applicant_completion_pct: 33,
    applicant_captured_at: new Date().toISOString(),
  };

  const result = await upsertContactInGHL(f, penv);
  if (!result.success || !result.contactId) {
    return new Response("Could not save the application", { status: 502 });
  }

  // The contact exists by now: a failed tag call only means the
  // tag-triggered GHL workflow won't fire, so it must not stop the applicant.
  const tags = [`applicant-${track}`];
  if (turnstile === "unverified") tags.push(TURNSTILE_UNVERIFIED_TAG);
  await addTagsInGHL(result.contactId, tags, penv);

  return jsonResponse({ contact_id: result.contactId });
}

// Out-of-area DQ, checked against LAUNCH_AREA_POSTCODES (launch-area decision,
// vpos Vol 1 §2.7b), the same list the lead gate uses. A missing postcode is rejected as incomplete by
// /apply-screen before this runs, so it is not a DQ here.
function checkApplicantAreaDisqualifier(f) {
  if (f.postcode && !LAUNCH_AREA_POSTCODES.includes(f.postcode)) {
    return { disqualified: true, reason: "unsuccessful-out-of-area" };
  }

  return { disqualified: false, reason: null };
}

// ---- /apply-screen -- STEP 2 PER-TRACK SCREENING -------------------------
// Browser-called with the contact_id from /apply. Hard disqualifiers first
// (PRD D18, per track), then a per-track fit score. Everything is written to
// the contact in the PEOPLE sub-account; a contact_id from any other
// sub-account fails the write (the people token cannot see it) and the
// request returns 502 without issuing a token.
const EXPERIENCE_OPTIONS = {
  employee: ["none", "under_1_year", "1_to_3_years", "3_plus_years"],
  subcontractor: ["none", "under_1_year", "1_to_3_years", "3_to_5_years", "5_plus_years"],
};
const COMMON_SCREEN_FIELDS = [
  "postcode",
  "cleaning_experience",
  "residential_experience",
  "right_to_work",
  "police_check_status",
  "availability",
  "reliable_transport",
];
const SUBCONTRACTOR_SCREEN_FIELDS = ["has_own_insurance_and_abn", "own_equipment"];

async function handleApplyScreen(rawPayload, env) {
  const payload = Object.fromEntries(
    Object.entries(rawPayload).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v])
  );
  const contactId = payload.contact_id || payload.contactId;
  if (!contactId) return new Response("Missing contact_id", { status: 400 });

  const track = payload.engagement_track;
  if (!APPLICANT_TRACKS.includes(track)) {
    return new Response("Invalid engagement_track", { status: 400 });
  }
  const required = [...COMMON_SCREEN_FIELDS, ...(track === "subcontractor" ? SUBCONTRACTOR_SCREEN_FIELDS : [])];
  const missing = required.filter((k) => typeof payload[k] !== "string" || !payload[k]);
  if (missing.length) {
    return new Response(`Incomplete screening answers: ${missing.join(", ")}`, { status: 400 });
  }
  if (!EXPERIENCE_OPTIONS[track].includes(payload.cleaning_experience.toLowerCase())) {
    return new Response("Invalid cleaning_experience for this track", { status: 400 });
  }
  if (!EXPERIENCE_OPTIONS[track].includes(payload.residential_experience.toLowerCase())) {
    return new Response("Invalid residential_experience for this track", { status: 400 });
  }

  if (!env.GHL_VPP_API_KEY || !env.GHL_VPP_LOCATION_ID) {
    return new Response("Applicant intake is not configured", { status: 503 });
  }
  const penv = peopleEnv(env);

  const f = extractApplicantScreenFields(payload);
  const dq = checkApplicantDisqualifiers(track, f);
  const score = applicantScore(track, f);
  const tier = dq.disqualified ? "unsuccessful" : applicantTierFromScore(score);

  let result;
  if (tier === "unsuccessful") result = "unsuccessful";
  else if (track === "employee" && env.EMPLOYEE_INTAKE_OPEN !== "true") result = "shortlist";
  else result = "book";

  // The applicant's own answers, saved under the keys they arrived with so the
  // HR Lead can read them in GHL before the interview. Postcode is already
  // saved by /apply; subcontractor-only questions are only sent on that track.
  const answerKeys = COMMON_SCREEN_FIELDS.filter((k) => k !== "postcode")
    .concat(track === "subcontractor" ? SUBCONTRACTOR_SCREEN_FIELDS : []);
  const answers = Object.fromEntries(answerKeys.map((k) => [k, String(payload[k]).toLowerCase()]));

  const subcontractorReady = f.hasOwnInsuranceAndAbn === "yes";

  const write = await writeBackToGHL(
    contactId,
    {
      ...answers,
      applicant_score: score,
      applicant_tier: tier,
      applicant_dq_flag: dq.disqualified ? dq.reason : "none",
      applicant_screened_at: new Date().toISOString(),
      applicant_completion_pct: result === "unsuccessful" ? 100 : 67,
      applicant_stage: result === "unsuccessful" ? "unsuccessful" : result === "shortlist" ? "shortlisted" : "screened",
      applicant_subcontractor_ready: subcontractorReady,
    },
    penv
  );
  if (!write.success) {
    return new Response("Could not save the screening result", { status: 502 });
  }

  // The tag triggers the GHL workflows; a failed tag call must not stop the
  // applicant seeing their result.
  const tag = result === "unsuccessful" ? "applicant-unsuccessful" : result === "shortlist" ? "applicant-shortlist" : null;
  if (tag) await addTagsInGHL(contactId, [tag], penv);

  const body = { tier, result, dq_flag: dq.disqualified ? dq.reason : "none" };
  if (result === "book") {
    const token = await signBookingToken({ cid: contactId, tier, aud: "applicant", track }, env);
    if (token) body.booking_token = token;
  }
  return jsonResponse(body);
}

function extractApplicantScreenFields(payload) {
  const low = (v) => (typeof v === "string" ? v.toLowerCase() : "");
  return {
    postcode: typeof payload.postcode === "string" ? payload.postcode : "",
    experience: low(payload.cleaning_experience),
    residentialExperience: low(payload.residential_experience),
    rightToWork: low(payload.right_to_work),
    policeCheckStatus: low(payload.police_check_status),
    hasOwnInsuranceAndAbn: low(payload.has_own_insurance_and_abn),
    ownEquipment: low(payload.own_equipment),
    availability: low(payload.availability),
    reliableTransport: low(payload.reliable_transport),
  };
}

// Hard gates (PRD D18), in the table's order. No flex path: a "no" here is
// final unless the applicant's circumstances change and they re-apply.
function checkApplicantDisqualifiers(track, f) {
  // Residential experience counts towards the minimum: DQ only when both are under 1 year.
  const underOne = (v) => !v || MIN_EXPERIENCE_LEVELS.includes(v);
  if (underOne(f.experience) && underOne(f.residentialExperience)) {
    return { disqualified: true, reason: "unsuccessful-insufficient-experience" };
  }
  if (f.rightToWork === "no") {
    return { disqualified: true, reason: "unsuccessful-no-right-to-work" };
  }
  if (f.policeCheckStatus === "not_willing") {
    return { disqualified: true, reason: "unsuccessful-no-police-check" };
  }
  const area = checkApplicantAreaDisqualifier(f);
  if (area.disqualified) return area;

  if (track === "subcontractor") {
    if (f.hasOwnInsuranceAndAbn === "no") {
      return { disqualified: true, reason: "unsuccessful-no-abn-redirect-careers" };
    }
    if (f.ownEquipment === "no") {
      return { disqualified: true, reason: "unsuccessful-no-own-equipment" };
    }
    if (f.reliableTransport === "no") {
      return { disqualified: true, reason: "unsuccessful-no-transport" };
    }
  }

  return { disqualified: false, reason: null };
}

// Per-track fit score (PRD v3 D5). Employee: transport scores 15. Subcontractor:
// transport is a hard gate instead, so it is not scored.
function applicantScore(track, f) {
  let score = 0;

  score += Math.max(
    (EXPERIENCE_SCORE[track] || {})[f.experience] ?? 0,
    (RESIDENTIAL_EXPERIENCE_SCORE[track] || {})[f.residentialExperience] ?? 0
  );
  score += (AVAILABILITY_SCORE[track] || {})[f.availability] ?? 0;
  if (track !== "subcontractor" && f.reliableTransport === "yes") score += 15;

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
    conversion_page: f.conversionPage,
    lead_channel: deriveLeadChannel(f),
    utm_source: f.utm_source,
    utm_medium: f.utm_medium,
    utm_campaign: f.utm_campaign,
    utm_term: f.utm_term,
    utm_content: f.utm_content,
    ...f.extraFields,
  })
    .filter(([, value]) => value)
    .map(([key, value]) => ({ key, field_value: String(value) }));

  // Only when ticked. Unticked/missing sends neither field, so a repeat
  // enquiry never clears earlier consent (withdrawal = GHL unsubscribe/DND).
  if (f.marketingConsent === true) {
    customFields.push(
      { key: "marketing_consent", field_value: "Yes" },
      { key: "marketing_consent_at", field_value: new Date().toISOString() }
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GHL_VPFS_API_KEY}`,
      "Content-Type": "application/json",
      Version: GHL_API_VERSION,
    },
    body: JSON.stringify({
      locationId: env.GHL_VPFS_LOCATION_ID,
      firstName: f.firstName,
      lastName: f.lastName,
      ...(f.companyName ? { companyName: f.companyName } : {}),
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
      Authorization: `Bearer ${env.GHL_VPFS_API_KEY}`,
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
      Authorization: `Bearer ${env.GHL_VPFS_API_KEY}`,
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
  deriveLeadChannel,
  checkDisqualifiers,
  leadFlags,
  calculateGateScore,
  tierFromScore,
  monthsUntilContractRenewal,
  checkApplicantAreaDisqualifier,
  checkApplicantDisqualifiers,
  applicantScore,
  LAUNCH_AREA_POSTCODES,
  applicantTierFromScore,
};
