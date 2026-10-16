// Vantage Point Facility Services — applicant two-step flow
//
// Step 1: first name/last name/email/phone/postcode -> POST /apply, which
// creates the applicant in the PEOPLE GHL sub-account (worker/worker.js,
// handleApply) and returns { contact_id }; the shared two-step gate
// (two-step-gate.js) then hides the Step 1 fields and opens the Step 2
// dialog. The form's track comes from form[data-engagement-track]
// ("employee" or "subcontractor"). Step 2 posts the track's screening answers to
// /apply-screen and shows the panel for the returned result.
//
// Unlike the booking form there is no marketing-consent box and no
// conversion page: applicants are not marketing leads.

import { readAttribution, sessionStore } from "./utm.js";
import { initTwoStepGate, fieldGetter } from "./two-step-gate.js";

var WORKER_BASE = "https://worker.vantagepointfacilityservices.com.au";

function trackOf(form) {
  return form.getAttribute("data-engagement-track") || "";
}

function buildApplyPayload(form, helpers) {
  var get = helpers.fieldGetter(form);

  return Object.assign({
    first_name: get("first_name"),
    last_name: get("last_name"),
    email: get("email"),
    phone: get("phone"),
    postcode: get("postcode"),
    engagement_track: trackOf(form),
    url: get("url"),
    turnstile_token: helpers.turnstileToken(),
  }, readAttribution(window.location, document.referrer, sessionStore()));
}

// Step 2 answers (names are the /apply-screen contract). The postcode is
// read back from the (hidden but populated) Step 1 field, as the booking
// gate does. The subcontractor-only questions are sent only on that track.
var COMMON_ANSWERS = [
  "cleaning_experience", "residential_experience", "right_to_work", "police_check_status",
  "availability", "reliable_transport",
];
var SUBCONTRACTOR_ANSWERS = ["has_own_insurance_and_abn", "own_equipment"];

function answersFor(track) {
  return track === "subcontractor" ? COMMON_ANSWERS.concat(SUBCONTRACTOR_ANSWERS) : COMMON_ANSWERS;
}

function buildScreenPayload(form, step2, helpers) {
  var get = helpers.fieldGetter(step2);
  var track = trackOf(form);
  var payload = {
    contact_id: step2.dataset.contactId || "",
    engagement_track: track,
    postcode: helpers.fieldGetter(form)("postcode"),
  };
  answersFor(track).forEach(function (name) { payload[name] = get(name); });
  return payload;
}

function isScreenComplete(payload) {
  return Boolean(payload.contact_id && payload.postcode) &&
    answersFor(payload.engagement_track).every(function (name) { return Boolean(payload[name]); });
}

// result: "book" -> the interview picker (no-calendar fallback when there is
// no token or no open slot); "shortlist" and "unsuccessful" -> their message.
// The no-ABN disqualifier gets its own message, which links to career.html.
function handleScreenResult(data, ctx) {
  if (!data || !data.result) {
    ctx.setLoading(ctx.submitBtn, false);
    ctx.showError(ctx.errorBox, "Something went wrong — please try again.");
    return;
  }
  if (data.result === "book") {
    ctx.step2.dataset.bookingToken = data.booking_token || "";
    ctx.loadPicker(ctx.step2, ctx.submitBtn);
    return;
  }
  ctx.setLoading(ctx.submitBtn, false);
  if (data.result === "shortlist") {
    ctx.revealResult(ctx.step2, "#shortlist-message");
  } else if (data.dq_flag === "unsuccessful-no-abn-redirect-careers") {
    ctx.revealResult(ctx.step2, "#unsuccessful-no-abn-message");
  } else {
    ctx.revealResult(ctx.step2, "#unsuccessful-message");
  }
}

// ---- Embedded experience survey -------------------------------------------
// Offer (two buttons) under the shortlist, no-calendar and booking-confirmed
// panels when form[data-enrich-survey-url] is set. The survey screen (iframe
// and GHL's form_embed.js) is created only when the applicant opts in.
var EMBED_SCRIPT = "https://link.msgsndr.com/js/form_embed.js";
var SURVEY_PANELS = ["shortlist-message", "no-calendar-message", "booking-confirmed"];

function surveyUrl(form) {
  return (form.getAttribute("data-enrich-survey-url") || "").trim();
}

function loadEmbedScript() {
  if (document.querySelector('script[src="' + EMBED_SCRIPT + '"]')) return;
  var s = document.createElement("script");
  s.src = EMBED_SCRIPT;
  s.async = true;
  document.body.appendChild(s);
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function closeDialog(form) {
  var dialog = form.querySelector(".booking-dialog");
  if (dialog) dialog.close();
}

// The survey screen replaces the panel's content; iframe and form_embed.js
// are created only here, when the applicant opts in.
function openSurveyScreen(target, form, src) {
  // Wrap everything (including bare text nodes, which .children skips) and hide it.
  var prev = el("div", "enrich-prev");
  while (target.firstChild) prev.appendChild(target.firstChild);
  prev.hidden = true;
  target.appendChild(prev);
  var screen = el("div", "enrich-screen");
  var heading = el("h3", "", "Add your experience");
  heading.setAttribute("tabindex", "-1");
  screen.appendChild(heading);
  screen.appendChild(el("p", "small", "about 3 minutes, helps us prepare for your interview"));
  var frame = el("iframe", "enrich-frame");
  frame.src = src;
  frame.title = "Experience survey";
  var actions = el("div", "enrich-actions");
  var link = el("a", "small enrich-newtab", "Open in a new tab");
  link.href = src;
  link.target = "_blank";
  link.rel = "noopener";
  var done = el("button", "btn btn-secondary enrich-skip", "Close");
  done.type = "button";
  done.addEventListener("click", function () { closeDialog(form); });
  actions.appendChild(link);
  actions.appendChild(done);
  screen.appendChild(frame);
  screen.appendChild(actions);
  target.appendChild(screen);
  // The button that had focus is now hidden — move focus to what replaced it.
  heading.focus();
  loadEmbedScript();
}

function showSurvey(target, form) {
  var base = surveyUrl(form);
  if (!base || SURVEY_PANELS.indexOf(target.id) === -1 || target.querySelector(".enrich-cta")) return;
  var get = fieldGetter(form);
  var src = base + "?email=" + encodeURIComponent(get("email")) + "&phone=" + encodeURIComponent(get("phone"));

  var box = el("div", "enrich-cta");
  var actions = el("div", "enrich-actions");
  var now = el("button", "btn btn-primary enrich-now", "Add your experience now (3 min)");
  now.type = "button";
  now.addEventListener("click", function () { openSurveyScreen(target, form, src); });
  var later = el("button", "btn btn-secondary enrich-skip", "I\u2019ll do it later, text me the link");
  later.type = "button";
  later.addEventListener("click", function () { closeDialog(form); });
  actions.appendChild(now);
  actions.appendChild(later);
  box.appendChild(actions);
  target.appendChild(box);
}

export function initApply(form) {
  initTwoStepGate(form, {
    workerBase: WORKER_BASE,
    step1Endpoint: "/apply",
    step2Endpoint: "/apply-screen",
    buildStep1Payload: buildApplyPayload,
    buildStep2Payload: buildScreenPayload,
    isStep2Complete: isScreenComplete,
    handleStep2Result: handleScreenResult,
    onResultRevealed: showSurvey,
    stepper: true,
    messages: {
      bookIdle: "Book interview",
      alreadyBooked: "You already have an interview booked for ",
    },
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initApply(document.querySelector("form[data-apply]"));
});
