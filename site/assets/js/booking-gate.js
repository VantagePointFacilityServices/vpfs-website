// Vantage Point Facility Services — two-step booking gate
//
// Step 1: name/email/phone -> POST /lead -> creates the GHL contact and
// reveals the Step 2 DQ questions. Step 2: facility type/budget/frequency/
// postcode -> POST /gate (the same DQ scoring the AI Receptionist already
// calls live on the phone) -> shows the Priority calendar, the Standard
// calendar, or a no-calendar "we'll be in touch" message, based on the
// returned tier. Both calendar containers exist in the page's static HTML
// from load (issue 06 fills in the real GHL embeds) — this module only
// toggles which one is visible; it never injects a <script> tag.
//
// Shared between the homepage hero form and contact.html's form — see
// data-channel on each <form class="assessment-form"> for which page a
// submission came from. See docs/ARCHITECTURE.md for how this fits into
// the rest of the site/Worker/GHL flow.

var WORKER_BASE = "https://worker.vantagepointfacilityservices.com.au";
var FETCH_TIMEOUT_MS = 9000;
var GENERIC_ERROR_MESSAGE = "Something went wrong — please try again.";

export function initBookingGate(form) {
  if (!form) return;
  initStep1(form);
  initStep2(form);
}

// ---- Step 1 — name/email/phone -> /lead --------------------------------

function initStep1(form) {
  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return; // already in flight

    handleStep1Submit(form, submitBtn);
  });
}

function handleStep1Submit(form, submitBtn) {
  var errorBox = form.querySelector(".form-fields .booking-error");
  clearError(errorBox);
  setLoading(submitBtn, true);

  var payload = buildLeadPayload(form);

  postJson(WORKER_BASE + "/lead", payload)
    .then(function (data) {
      setLoading(submitBtn, false);
      if (!data || !data.contact_id) {
        showError(errorBox, GENERIC_ERROR_MESSAGE);
        return;
      }
      revealStep2(form, data.contact_id);
    })
    .catch(function () {
      setLoading(submitBtn, false);
      showError(errorBox, GENERIC_ERROR_MESSAGE);
    });
}

// Homepage's form already has first_name/last_name as separate fields;
// contact.html has a single contact_name field — split it on the first
// space so both pages resolve to the same /lead contract without
// restructuring contact.html's existing markup.
function buildLeadPayload(form) {
  var get = fieldGetter(form);

  var firstName = get("first_name");
  var lastName = get("last_name");
  if (!firstName && !lastName) {
    var full = (get("contact_name") || "").trim();
    var parts = full.split(/\s+/).filter(Boolean);
    firstName = parts.shift() || "";
    lastName = parts.join(" ");
  }

  return {
    first_name: firstName,
    last_name: lastName,
    email: get("email"),
    phone: get("phone"),
    channel: form.getAttribute("data-channel") || "",
    url: get("url"),
  };
}

function revealStep2(form, contactId) {
  var fields = form.querySelector(".form-fields");
  var step2 = form.querySelector(".booking-step-2");
  if (fields) fields.classList.add("hide-after-step1");
  if (!step2) return;
  step2.dataset.contactId = contactId;
  step2.classList.add("show");
}

// ---- Step 2 — DQ questions -> /gate -> tier-based calendar branch ------

function initStep2(form) {
  var step2 = form.querySelector(".booking-step-2");
  if (!step2) return;

  var submitBtn = step2.querySelector(".step2-submit");
  if (!submitBtn) return;

  submitBtn.addEventListener("click", function () {
    if (submitBtn.disabled) return; // already in flight
    handleStep2Submit(step2, submitBtn);
  });
}

var VALIDATION_ERROR_MESSAGE = "Please fill in every field so we can check availability.";

function handleStep2Submit(step2, submitBtn) {
  var errorBox = step2.querySelector(".booking-step-2-questions .booking-error");
  clearError(errorBox);

  var payload = buildGatePayload(step2);
  if (!isGatePayloadComplete(payload)) {
    showError(errorBox, VALIDATION_ERROR_MESSAGE);
    return;
  }

  setLoading(submitBtn, true);

  postJson(WORKER_BASE + "/gate", payload)
    .then(function (data) {
      setLoading(submitBtn, false);
      if (!data || !data.tier) {
        showError(errorBox, GENERIC_ERROR_MESSAGE);
        return;
      }
      revealCalendarForTier(step2, data.tier);
    })
    .catch(function () {
      setLoading(submitBtn, false);
      showError(errorBox, GENERIC_ERROR_MESSAGE);
    });
}

// /gate's contract nests the DQ fields under customFields (see
// extractGateFields in worker/worker.js) — distinct from /lead's flat
// top-level shape.
function buildGatePayload(step2) {
  var get = fieldGetter(step2);

  return {
    contact_id: step2.dataset.contactId || "",
    customFields: {
      facility_type: get("facility_type"),
      monthly_budget: get("monthly_budget"),
      postcode: get("postcode"),
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

// tier is one of "priority" / "standard" / "standard-flagged" / "nurture"
// (tierFromScore() in worker.js). Exactly one result panel is ever shown.
function revealCalendarForTier(step2, tier) {
  var questions = step2.querySelector(".booking-step-2-questions");
  var result = step2.querySelector(".booking-result");
  var priority = step2.querySelector("#calendar-priority");
  var standard = step2.querySelector("#calendar-standard");
  var noCalendar = step2.querySelector("#no-calendar-message");

  if (questions) questions.classList.add("hide-after-step2");
  if (result) result.classList.add("show");

  [priority, standard, noCalendar].forEach(function (el) {
    if (el) el.classList.remove("show");
  });

  var target = tier === "priority" ? priority : tier === "nurture" ? noCalendar : standard;
  if (target) target.classList.add("show");
}

// ---- Shared helpers ------------------------------------------------------

// Scoped field lookup within a container (a <form> for Step 1, or the
// .booking-step-2 container for Step 2) — handles both plain inputs/
// selects and radio groups.
function fieldGetter(scope) {
  return function (name) {
    var el = scope.querySelector('[name="' + name + '"]');
    if (!el) return "";
    if (el.type === "radio") {
      var checked = scope.querySelector('[name="' + name + '"]:checked');
      return checked ? checked.value : "";
    }
    return el.value;
  };
}

function postJson(url, payload) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error("request failed: " + res.status);
      return res.json();
    })
    .catch(function (err) {
      clearTimeout(timer);
      throw err;
    });
}

function setLoading(btn, isLoading) {
  if (!btn) return;
  btn.disabled = isLoading;
}

function showError(box, message) {
  if (!box) return;
  box.textContent = message;
  box.classList.add("show");
}

function clearError(box) {
  if (!box) return;
  box.textContent = "";
  box.classList.remove("show");
}

document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector(".assessment-form");
  initBookingGate(form);
});
