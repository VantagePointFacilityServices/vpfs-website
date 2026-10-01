// Vantage Point Facility Services — two-step booking gate
//
// Step 1: name/email/phone/postcode -> POST /lead -> creates
// the GHL contact and reveals the Step 2 DQ questions. Step 2: facility
// type/budget/frequency -> POST /gate (the same DQ scoring the AI
// Receptionist already calls live on the phone). A qualifying tier returns
// a signed booking_token; the site posts it to POST /slots and draws the
// open walkthrough days/times in the built-in #walkthrough-picker (no GHL
// widget, no injected <script> tags). A nurture tier, a missing token, a
// /slots failure or zero open days shows the no-calendar "we'll be in
// touch" message instead. Postcode is only asked once, in Step 1, but
// /gate's DQ check still needs it — buildGatePayload() reads it back out
// of the (by then hidden, but still populated) Step 1 field rather than
// asking again.
//
// Shared between the homepage hero form and contact.html's form — see
// data-channel on each <form class="assessment-form"> for which page a
// submission came from. See docs/ARCHITECTURE.md for how this fits into
// the rest of the site/Worker/GHL flow.

import { readUtms, sessionStore } from "./utm.js";

var WORKER_BASE = "https://worker.vantagepointfacilityservices.com.au";
var FETCH_TIMEOUT_MS = 9000;
var GENERIC_ERROR_MESSAGE = "Something went wrong — please try again.";
var TURNSTILE_PENDING_MESSAGE = "Just a moment — we're still checking you're not a bot. Please try again in a few seconds.";

export function initBookingGate(form) {
  if (!form) return;
  initTurnstile(form);
  initStep1(form);
  initStep2(form);
  initDialog(form);
}

// ---- Turnstile — Cloudflare's bot check on Step 1 ------------------------
// api.js is loaded with ?render=explicit and `defer` before this module, so
// window.turnstile exists by the time this runs. The widget is rendered
// only when the page's .turnstile-widget has a site key; the Worker checks
// the token (verifyTurnstile in worker/worker.js). If the script failed to
// load, the form still submits and the Worker decides.

function initTurnstile(form) {
  var el = form.querySelector(".turnstile-widget");
  if (!el || !el.dataset.sitekey || !window.turnstile) return;
  el.dataset.widgetId = window.turnstile.render(el, {
    sitekey: el.dataset.sitekey,
    action: "lead",
    appearance: "interaction-only",
  });
}

function turnstileWidgetId(form) {
  var el = form.querySelector(".turnstile-widget");
  return el && el.dataset.widgetId && window.turnstile ? el.dataset.widgetId : null;
}

function turnstileToken(form) {
  var id = turnstileWidgetId(form);
  return id ? window.turnstile.getResponse(id) || "" : "";
}

// A token is single-use, so any failed /lead call needs a fresh one.
function resetTurnstile(form) {
  var id = turnstileWidgetId(form);
  if (id) window.turnstile.reset(id);
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

  var payload = buildLeadPayload(form);
  if (turnstileWidgetId(form) && !payload.turnstile_token) {
    showError(errorBox, TURNSTILE_PENDING_MESSAGE);
    return;
  }

  setLoading(submitBtn, true);

  postJson(WORKER_BASE + "/lead", payload)
    .then(function (data) {
      setLoading(submitBtn, false);
      if (!data || !data.contact_id) {
        resetTurnstile(form);
        showError(errorBox, GENERIC_ERROR_MESSAGE);
        return;
      }
      revealStep2(form, data.contact_id);
    })
    .catch(function () {
      setLoading(submitBtn, false);
      resetTurnstile(form);
      showError(errorBox, GENERIC_ERROR_MESSAGE);
    });
}

function buildLeadPayload(form) {
  var get = fieldGetter(form);

  return Object.assign({
    first_name: get("first_name"),
    last_name: get("last_name"),
    email: get("email"),
    phone: get("phone"),
    postcode: get("postcode"),
    channel: form.getAttribute("data-channel") || "",
    url: get("url"),
    turnstile_token: turnstileToken(form),
  }, readUtms(window.location.search, sessionStore()));
}

function revealStep2(form, contactId) {
  var fields = form.querySelector(".form-fields");
  var step2 = form.querySelector(".booking-step-2");
  if (fields) fields.classList.add("hide-after-step1");
  if (!step2) return;
  step2.dataset.contactId = contactId;
  step2.classList.add("show");
  openDialog(form);
}

// ---- Step 2 overlay ------------------------------------------------------
// Step 2's questions and its result (calendar or message) live in a modal
// <dialog> inside the form, so they still belong to it. Opened with
// showModal(), the browser handles the backdrop, focus trapping and Esc.
// There's deliberately no click-outside-to-close: a stray click shouldn't
// throw away a half-picked calendar slot. Once closed, .booking-resume on
// the page offers the way back in (Step 1 is already done and hidden).

function initDialog(form) {
  var dialog = form.querySelector(".booking-dialog");
  if (!dialog) return;

  var closeBtn = dialog.querySelector(".booking-dialog-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", function () {
      dialog.close();
    });
  }

  var resume = form.querySelector(".booking-resume");
  var resumeBtn = form.querySelector(".booking-resume-btn");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", function () {
      openDialog(form);
    });
  }

  // Fires however it closed — close button, Esc, or a mobile back gesture.
  dialog.addEventListener("close", function () {
    if (resume) resume.classList.add("show");
  });
}

function openDialog(form) {
  var dialog = form.querySelector(".booking-dialog");
  if (!dialog || dialog.hasAttribute("open")) return;
  var resume = form.querySelector(".booking-resume");
  if (resume) resume.classList.remove("show");
  dialog.showModal();
}

// ---- Step 2 — DQ questions -> /gate -> tier-based calendar branch ------

function initStep2(form) {
  var step2 = form.querySelector(".booking-step-2");
  if (!step2) return;

  var submitBtn = step2.querySelector(".step2-submit");
  if (!submitBtn) return;

  submitBtn.addEventListener("click", function () {
    if (submitBtn.disabled) return; // already in flight
    handleStep2Submit(form, step2, submitBtn);
  });
}

var VALIDATION_ERROR_MESSAGE = "Please fill in every field so we can check availability.";

function handleStep2Submit(form, step2, submitBtn) {
  var errorBox = step2.querySelector(".booking-step-2-questions .booking-error");
  clearError(errorBox);

  var payload = buildGatePayload(form, step2);
  if (!isGatePayloadComplete(payload)) {
    showError(errorBox, VALIDATION_ERROR_MESSAGE);
    return;
  }

  setLoading(submitBtn, true);

  postJson(WORKER_BASE + "/gate", payload)
    .then(function (data) {
      if (!data || !data.tier) {
        setLoading(submitBtn, false);
        showError(errorBox, GENERIC_ERROR_MESSAGE);
        return;
      }
      if (data.tier === "nurture") setLoading(submitBtn, false);
      if (data.tier === "nurture") {
        revealResult(step2, data.dq_flag === "nurture-budget" ? "#budget-nurture-message" : "#no-calendar-message");
        return;
      }
      step2.dataset.bookingToken = data.booking_token || "";
      loadPicker(step2, submitBtn);
    })
    .catch(function () {
      setLoading(submitBtn, false);
      showError(errorBox, GENERIC_ERROR_MESSAGE);
    });
}

// /gate's contract nests the DQ fields under customFields (see
// extractGateFields in worker/worker.js) — distinct from /lead's flat
// top-level shape. postcode comes from the whole form (it's a Step 1
// field), everything else from step2.
function buildGatePayload(form, step2) {
  var get = fieldGetter(step2);
  var getFromForm = fieldGetter(form);

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

// Exactly one result panel is ever shown. A nurture lead disqualified on
// budget gets its own message; every other nurture reason (frequency,
// capability, area) gets the general one.
function revealResult(step2, selector) {
  var questions = step2.querySelector(".booking-step-2-questions");
  var result = step2.querySelector(".booking-result");
  if (questions) questions.classList.add("hide-after-step2");
  if (result) result.classList.add("show");

  [
    "#walkthrough-picker",
    "#no-calendar-message",
    "#budget-nurture-message",
    "#booking-confirmed",
  ].forEach(function (sel) {
    var el = step2.querySelector(sel);
    if (el) el.classList.remove("show");
  });

  var target = step2.querySelector(selector);
  if (!target) return null;
  target.classList.add("show");
  // The button that had focus is now hidden — move focus to what replaced it
  // so keyboard and screen-reader users land on the result.
  target.setAttribute("tabindex", "-1");
  target.focus();
  return target;
}

// ---- Walkthrough picker — /slots -> day row + time grid ------------------
// State lives in a WeakMap keyed by the picker element so it survives the
// dialog being closed and reopened (the DOM is never torn down). Issues 03
// (week paging) and 04 (/book) read/re-draw via pickerState(picker) and
// drawPicker(picker); the chosen time is state.startTime (also mirrored to
// picker.dataset.date / picker.dataset.startTime).

var pickerStates = new WeakMap();
var NO_CALENDAR = "#no-calendar-message";

export function pickerState(picker) {
  return pickerStates.get(picker);
}

function loadPicker(step2, submitBtn) {
  var token = step2.dataset.bookingToken;
  var picker = step2.querySelector("#walkthrough-picker");
  if (!token || !picker) {
    setLoading(submitBtn, false);
    revealResult(step2, NO_CALENDAR);
    return;
  }
  postJson(WORKER_BASE + "/slots", { booking_token: token })
    .then(function (data) {
      setLoading(submitBtn, false);
      var days = data && Array.isArray(data.days) ? data.days.filter(function (d) {
        return d && d.date && Array.isArray(d.slots) && d.slots.length;
      }) : [];
      if (!days.length) {
        revealResult(step2, NO_CALENDAR);
        return;
      }
      pickerStates.set(picker, {
        timezone: data.timezone || "Australia/Brisbane",
        days: days,
        weekStart: weekStartOf(days[0].date),
        firstWeek: weekStartOf(days[0].date),
        lastDate: days[days.length - 1].date,
        date: "",
        startTime: "",
      });
      initPicker(picker);
      drawPicker(picker);
      revealResult(step2, "#walkthrough-picker");
    })
    .catch(function () {
      setLoading(submitBtn, false);
      revealResult(step2, NO_CALENDAR);
    });
}

function initPicker(picker) {
  if (picker.dataset.ready) return;
  picker.dataset.ready = "1";
  // Natively `required` only once the picker is live: Step 1 and Step 2 share
  // one <form>, and a hidden required field would block Step 1's submit.
  var addressField = picker.querySelector('[name="site_address"]');
  if (addressField) addressField.required = true;
  var book = picker.querySelector(".picker-book");
  if (book) {
    book.addEventListener("click", function () {
      if (book.disabled) return; // already in flight / nothing chosen
      handleBook(picker, book);
    });
  }
  var prevWeek = picker.querySelector(".picker-prev-week");
  var nextWeek = picker.querySelector(".picker-next-week");
  prevWeek.addEventListener("click", function () {
    changeWeek(picker, -7, prevWeek, nextWeek);
  });
  nextWeek.addEventListener("click", function () {
    changeWeek(picker, 7, nextWeek, prevWeek);
  });
  picker.querySelector(".picker-days").addEventListener("keydown", function (e) {
    var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "first", End: "last" };
    if (!(e.key in keys) || e.altKey || e.ctrlKey || e.metaKey) return;
    var btn = e.target.closest(".picker-day");
    if (!btn) return;
    var enabled = Array.prototype.filter.call(picker.querySelectorAll(".picker-day"), function (b) {
      return !b.disabled;
    });
    if (!enabled.length) return;
    e.preventDefault();
    var step = keys[e.key];
    var idx = enabled.indexOf(btn);
    var next = step === "first" ? enabled[0]
      : step === "last" ? enabled[enabled.length - 1]
      : enabled[(idx + step + enabled.length) % enabled.length];
    selectDay(picker, next.dataset.date, true);
  });
  picker.querySelector(".picker-days").addEventListener("click", function (e) {
    var btn = e.target.closest(".picker-day");
    if (!btn || btn.disabled) return;
    // Redrawing replaces the button, so focus goes back to its replacement.
    selectDay(picker, btn.dataset.date, true);
  });
  picker.querySelector(".picker-times").addEventListener("click", function (e) {
    var btn = e.target.closest(".picker-time");
    if (!btn) return;
    var state = pickerState(picker);
    state.startTime = btn.dataset.start;
    drawPicker(picker);
    var again = picker.querySelector('.picker-time[data-start="' + state.startTime + '"]');
    if (again) again.focus();
  });
}

function selectDay(picker, date, focus) {
  var state = pickerState(picker);
  if (state.date !== date) state.startTime = "";
  state.date = date;
  drawPicker(picker);
  if (focus) picker.querySelector('.picker-day[data-date="' + date + '"]').focus();
}

// Steps the shown week by 7 days within the window; a choice that is no
// longer on screen is dropped, which re-disables the Book button. A week
// button that disables itself at the window's edge can't keep focus, so
// focus moves to the other one (or the day row).
function changeWeek(picker, delta, clicked, other) {
  var state = pickerState(picker);
  var next = addDays(state.weekStart, delta);
  if (next < state.firstWeek || next > state.lastDate) return;
  state.weekStart = next;
  if (state.date && (state.date < next || state.date > addDays(next, 6))) {
    state.date = "";
    state.startTime = "";
  }
  drawPicker(picker);
  if (clicked.disabled) {
    if (!other.disabled) other.focus();
    else focusDayStop(picker);
  }
}

// Focuses the day row's tab stop (the chosen day, else the first open one).
function focusDayStop(picker) {
  var stop = picker.querySelector('.picker-day[tabindex="0"]');
  if (stop) stop.focus();
}

// (Re)draws the week label, day row and time grid from the picker's state.
export function drawPicker(picker) {
  var state = pickerState(picker);
  if (!state) return;
  var byDate = {};
  state.days.forEach(function (d) {
    byDate[d.date] = d.slots;
  });

  var label = picker.querySelector(".picker-week-label");
  var lastDay = addDays(state.weekStart, 6);
  if (label) label.textContent = formatDay(state.weekStart, { day: "numeric", month: "short" }) + " – " + formatDay(lastDay, { day: "numeric", month: "short" });

  var prev = picker.querySelector(".picker-prev-week");
  var nextBtn = picker.querySelector(".picker-next-week");
  if (prev) prev.disabled = state.weekStart <= state.firstWeek;
  if (nextBtn) nextBtn.disabled = addDays(state.weekStart, 7) > state.lastDate;

  var daysEl = picker.querySelector(".picker-days");
  daysEl.textContent = "";
  for (var i = 0; i < 7; i++) {
    var date = addDays(state.weekStart, i);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-day";
    btn.dataset.date = date;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", state.date === date ? "true" : "false");
    btn.textContent = formatDay(date, { weekday: "short", day: "numeric" });
    if (!byDate[date]) btn.disabled = true;
    btn.tabIndex = -1;
    daysEl.appendChild(btn);
  }
  // Roving tabindex: the chosen day, else the first enabled day.
  var all = Array.prototype.slice.call(daysEl.children);
  var stop = all.filter(function (b) { return b.dataset.date === state.date && !b.disabled; })[0] ||
    all.filter(function (b) { return !b.disabled; })[0];
  if (stop) stop.tabIndex = 0;

  var timesEl = picker.querySelector(".picker-times");
  timesEl.textContent = "";
  var slots = state.date && byDate[state.date] ? byDate[state.date] : [];
  slots.forEach(function (iso) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-time";
    btn.dataset.start = iso;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", state.startTime === iso ? "true" : "false");
    btn.textContent = formatTime(iso, state.timezone);
    timesEl.appendChild(btn);
  });

  picker.dataset.date = state.date;
  picker.dataset.startTime = state.startTime;

  var bookBtn = picker.querySelector(".picker-book");
  if (bookBtn) {
    bookBtn.disabled = !state.startTime || Boolean(state.booking);
    bookBtn.textContent = state.startTime
      ? "Book " + formatDay(state.date, { weekday: "short", day: "numeric", month: "short" }) + ", " + formatTime(state.startTime, state.timezone)
      : "Book walkthrough";
  }
}

// ---- Book — /book -> confirmation ---------------------------------------

var ADDRESS_REQUIRED_MESSAGE = "Please enter the site address for the walkthrough.";
var SLOT_TAKEN_MESSAGE = "That time was just taken — please pick another.";

function handleBook(picker, bookBtn) {
  var state = pickerState(picker);
  var step2 = picker.closest(".booking-step-2");
  if (!state || !state.startTime || state.booking || !step2) return;
  var errorBox = picker.querySelector(".booking-error");
  clearError(errorBox);

  var addressInput = picker.querySelector('[name="site_address"]');
  var siteAddress = addressInput ? addressInput.value.trim() : "";
  if (!siteAddress) {
    showError(errorBox, ADDRESS_REQUIRED_MESSAGE);
    if (addressInput) addressInput.focus();
    return;
  }

  var startTime = state.startTime;
  state.booking = true;
  setLoading(bookBtn, true);

  postJson(WORKER_BASE + "/book", { booking_token: step2.dataset.bookingToken, start_time: startTime, site_address: siteAddress })
    .then(function (data) {
      state.booking = false;
      var when = formatWhen(data && data.start_time ? data.start_time : startTime, state.timezone);
      showConfirmation(step2, "You\u2019re booked for " + when + " \u2014 we\u2019ve sent a confirmation by SMS and email.");
    })
    .catch(function (err) {
      state.booking = false;
      var code = err && err.data && err.data.error;
      if (err && err.status === 409 && code === "already_booked") {
        var t = err.data.start_time || startTime;
        showConfirmation(step2, "You already have a walkthrough booked for " + formatWhen(t, state.timezone) + ".");
        return;
      }
      if (err && err.status === 409 && code === "slot_unavailable") {
        refreshSlots(step2, picker, errorBox);
        return;
      }
      // Keep the chosen time so the visitor can simply retry.
      drawPicker(picker);
      showError(errorBox, GENERIC_ERROR_MESSAGE);
    });
}

function formatWhen(iso, timezone) {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

function showConfirmation(step2, text) {
  var panel = revealResult(step2, "#booking-confirmed");
  if (panel) panel.textContent = text;
}

// The chosen time was taken: re-fetch /slots, drop the choice, and stay on
// the same day when it still has times.
function refreshSlots(step2, picker, errorBox) {
  var state = pickerState(picker);
  state.startTime = "";
  postJson(WORKER_BASE + "/slots", { booking_token: step2.dataset.bookingToken })
    .then(function (data) {
      var days = data && Array.isArray(data.days) ? data.days.filter(function (d) {
        return d && d.date && Array.isArray(d.slots) && d.slots.length;
      }) : [];
      if (!days.length) {
        revealResult(step2, NO_CALENDAR);
        return;
      }
      state.days = days;
      // Keep week paging inside the refreshed window.
      state.firstWeek = weekStartOf(days[0].date);
      state.lastDate = days[days.length - 1].date;
      var stillOpen = days.some(function (d) { return d.date === state.date; });
      if (!stillOpen) {
        state.date = "";
        state.weekStart = weekStartOf(days[0].date);
      }
      drawPicker(picker);
      showError(errorBox, SLOT_TAKEN_MESSAGE);
      focusDayStop(picker); // Book is disabled again, so it can't keep focus
    })
    .catch(function () {
      drawPicker(picker);
      showError(errorBox, SLOT_TAKEN_MESSAGE);
      focusDayStop(picker);
    });
}

// Dates are "YYYY-MM-DD" strings in Brisbane's calendar; do day arithmetic
// in UTC so the browser's own timezone never shifts them.
function parseDate(str) {
  var p = str.split("-");
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
}

function addDays(str, n) {
  var d = parseDate(str);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the week holding the date.
function weekStartOf(str) {
  var dow = parseDate(str).getUTCDay(); // 0 = Sunday
  return addDays(str, -((dow + 6) % 7));
}

function formatDay(str, opts) {
  return new Intl.DateTimeFormat("en-AU", Object.assign({ timeZone: "UTC" }, opts)).format(parseDate(str));
}

function formatTime(iso, timezone) {
  return new Intl.DateTimeFormat("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
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
      if (!res.ok) {
        var err = new Error("request failed: " + res.status);
        err.status = res.status;
        return res.json().then(
          function (body) { err.data = body; throw err; },
          function () { throw err; }
        );
      }
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
