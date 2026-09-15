// Vantage Point Facility Services — two-step booking gate
//
// Step 1: name/email/phone -> POST /lead -> creates the GHL contact and
// reveals the Step 2 DQ questions (built by a follow-up module). Shared
// between the homepage hero form and contact.html's form — see
// data-channel on each <form class="assessment-form"> for which page a
// submission came from.
//
// See .scratch/booking-gate-dq-comms/PRD.md in this repo for the full
// architecture this implements.

var LEAD_ENDPOINT = "https://worker.vantagepointfacilityservices.com.au/lead";
var FETCH_TIMEOUT_MS = 9000;
var GENERIC_ERROR_MESSAGE = "Something went wrong — please try again.";

export function initBookingGate(form) {
  if (!form) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return; // already in flight

    handleStep1Submit(form, submitBtn);
  });
}

function handleStep1Submit(form, submitBtn) {
  var errorBox = form.querySelector(".booking-error");
  clearError(errorBox);
  setLoading(submitBtn, true);

  var payload = buildLeadPayload(form);

  postLead(payload)
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
  var get = function (name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value : "";
  };

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

function postLead(payload) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  return fetch(LEAD_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error("lead request failed: " + res.status);
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

function revealStep2(form, contactId) {
  var step2 = form.querySelector(".booking-step-2");
  if (!step2) return;
  step2.dataset.contactId = contactId;
  step2.classList.add("show");
}

document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector(".assessment-form");
  initBookingGate(form);
});
