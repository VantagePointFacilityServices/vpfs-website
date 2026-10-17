// Vantage Point Facility Services — two-step booking gate
//
// Step 1: name/email/phone/postcode -> POST /lead -> creates the GHL contact
// and reveals the Step 2 DQ questions. Step 2: facility type/budget/frequency
// -> POST /gate (the same DQ scoring the AI Receptionist already calls live
// on the phone). A qualifying tier returns a signed booking_token; the site
// posts it to POST /slots and draws the open walkthrough days/times in the
// built-in #walkthrough-picker. A nurture tier, a missing token, a /slots
// failure or zero open days shows the no-calendar "we'll be in touch"
// message instead. Postcode is only asked once, in Step 1, but /gate's DQ
// check still needs it — buildGatePayload() reads it back out of the (by then
// hidden, but still populated) Step 1 field rather than asking again.
//
// All the mechanics live in two-step-gate.js; this file is just the booking
// configuration. Shared between the homepage hero form and contact.html's
// form — see data-conversion-page on each <form class="assessment-form"> for
// which page a submission came from. See docs/ARCHITECTURE.md for how this
// fits into the rest of the site/Worker/GHL flow.

import { readAttribution, sessionStore } from "./utm.js";
import { initTwoStepGate, pickerState, drawPicker } from "./two-step-gate.js";

export { pickerState, drawPicker };

var WORKER_BASE = "https://worker.vantagepointfacilityservices.com.au";

function marketingConsent(form) {
  var box = form.querySelector('input[name="marketing_consent"]');
  return !!(box && box.checked);
}

function buildLeadPayload(form, helpers) {
  var get = helpers.fieldGetter(form);

  return Object.assign({
    first_name: get("first_name"),
    last_name: get("last_name"),
    company_name: get("company_name"),
    email: get("email"),
    phone: get("phone"),
    postcode: get("postcode"),
    conversion_page: form.getAttribute("data-conversion-page") || "",
    url: get("url"),
    marketing_consent: marketingConsent(form),
    turnstile_token: helpers.turnstileToken(),
  }, readAttribution(window.location, document.referrer, sessionStore()));
}

// /gate's contract nests the DQ fields under customFields (see
// extractGateFields in worker/worker.js) — distinct from /lead's flat
// top-level shape. postcode comes from the whole form (it's a Step 1
// field), everything else from step2.
function buildGatePayload(form, step2, helpers) {
  var get = helpers.fieldGetter(step2);
  var getFromForm = helpers.fieldGetter(form);

  return {
    contact_id: step2.dataset.contactId || "",
    customFields: {
      facility_type: get("facility_type"),
      monthly_budget: get("monthly_budget"),
      postcode: getFromForm("postcode"),
      cleaning_frequency: get("cleaning_frequency"),
    },
  };
}

// Step 2's submit button is a plain <button type="button"> (there's only
// one real <form> on the page, already claimed by Step 1), so it gets none
// of the browser's native `required`-attribute validation the way Step 1's
// real submit button does — this is the manual equivalent.
function isGatePayloadComplete(payload) {
  var cf = payload.customFields;
  return Boolean(cf.facility_type && cf.monthly_budget && cf.postcode && cf.cleaning_frequency);
}

// A nurture lead disqualified on budget gets its own message; every other
// nurture reason (frequency, capability, area) gets the general one.
function handleGateResult(data, ctx) {
  if (!data || !data.tier) {
    ctx.setLoading(ctx.submitBtn, false);
    ctx.showError(ctx.errorBox, "Something went wrong — please try again.");
    return;
  }
  if (data.tier === "nurture") {
    ctx.setLoading(ctx.submitBtn, false);
    ctx.revealResult(ctx.step2, data.dq_flag === "nurture-budget" ? "#budget-nurture-message" : "#no-calendar-message");
    return;
  }
  ctx.step2.dataset.bookingToken = data.booking_token || "";
  ctx.loadPicker(ctx.step2, ctx.submitBtn);
}

export function initBookingGate(form) {
  initTwoStepGate(form, {
    workerBase: WORKER_BASE,
    step1Endpoint: "/lead",
    step2Endpoint: "/gate",
    slotsEndpoint: "/slots",
    bookEndpoint: "/book",
    buildStep1Payload: buildLeadPayload,
    buildStep2Payload: buildGatePayload,
    isStep2Complete: isGatePayloadComplete,
    handleStep2Result: handleGateResult,
  });
}

document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector(".assessment-form");
  initBookingGate(form);
});
