// Vantage Point Facility Services — shared post-step survey offer
//
// Used by the careers/subcontractor pages (experience survey) and the
// commercial booking form (facility-details survey). Each caller passes its
// own survey URL, panels and copy; only the offer/embed mechanics are shared.
//
// createSurveyOffer(config) returns an onResultRevealed(target, form) hook for
// the two-step gate. When form[config.urlAttr]/config.getUrl yields a survey URL
// and the revealed panel is one of config.panelIds, it appends an offer (two
// buttons). The survey screen (iframe and GHL's form_embed.js) is created only
// when the visitor opts in.
//
// config: { getUrl(form) | urlAttr, panelIds, nowLabel, laterLabel, closeLabel?,
//           heading, subHeading, frameTitle, newTabLabel?,
//           offerHeading?, offerBody? }   (offer* = optional text above the buttons)

import { fieldGetter } from "./two-step-gate.js";

var EMBED_SCRIPT = "https://link.msgsndr.com/js/form_embed.js";

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

export function createSurveyOffer(config) {
  function surveyUrl(form) {
    var raw = config.getUrl ? config.getUrl(form) : form.getAttribute(config.urlAttr || "data-enrich-survey-url");
    return (raw || "").trim();
  }

  // The survey screen replaces the panel's content; iframe and form_embed.js
  // are created only here, when the visitor opts in.
  function openSurveyScreen(target, form, src) {
    // Wrap everything (including bare text nodes, which .children skips) and hide it.
    var prev = el("div", "enrich-prev");
    while (target.firstChild) prev.appendChild(target.firstChild);
    prev.hidden = true;
    target.appendChild(prev);
    var screen = el("div", "enrich-screen");
    var heading = el("h3", "", config.heading);
    heading.setAttribute("tabindex", "-1");
    screen.appendChild(heading);
    screen.appendChild(el("p", "small", config.subHeading));
    var frame = el("iframe", "enrich-frame");
    frame.src = src;
    frame.title = config.frameTitle;
    var actions = el("div", "enrich-actions");
    var link = el("a", "small enrich-newtab", config.newTabLabel || "Open in a new tab");
    link.href = src;
    link.target = "_blank";
    link.rel = "noopener";
    var done = el("button", "btn btn-secondary enrich-skip", config.closeLabel || "Close");
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

  return function onResultRevealed(target, form) {
    var base = surveyUrl(form);
    if (!base || config.panelIds.indexOf(target.id) === -1 || target.querySelector(".enrich-cta")) return;
    var get = fieldGetter(form);
    var src = base + "?email=" + encodeURIComponent(get("email")) + "&phone=" + encodeURIComponent(get("phone"));

    var box = el("div", "enrich-cta");
    if (config.offerHeading) box.appendChild(el("h3", "", config.offerHeading));
    if (config.offerBody) box.appendChild(el("p", "small", config.offerBody));
    var actions = el("div", "enrich-actions");
    var now = el("button", "btn btn-primary enrich-now", config.nowLabel);
    now.type = "button";
    now.addEventListener("click", function () { openSurveyScreen(target, form, src); });
    var later = el("button", "btn btn-secondary enrich-skip", config.laterLabel);
    later.type = "button";
    later.addEventListener("click", function () { closeDialog(form); });
    actions.appendChild(now);
    actions.appendChild(later);
    box.appendChild(actions);
    target.appendChild(box);
  };
}
