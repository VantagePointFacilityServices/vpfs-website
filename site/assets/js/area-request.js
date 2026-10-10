// "Request a new area" form (locations.html). Posts the visitor's details to
// the Worker's /area-request endpoint, which upserts the GHL contact and tags
// it new-area-request (worker/worker.js, handleAreaRequest). Without this the
// form had no action and reloaded the page with the details in the URL.

var WORKER_URL = "https://worker.vantagepointfacilityservices.com.au/area-request";
var FIELDS = ["first_name", "last_name", "email", "phone", "postcode", "url"];
var ERROR_MESSAGE = "Sorry, we couldn't send that. Please try again, or call us on 07 5651 2257.";

export function initAreaRequest(form) {
  if (!form) return;
  var widget = form.querySelector(".turnstile-widget");
  var widgetId = null;
  if (widget && widget.dataset.sitekey && window.turnstile) {
    widgetId = window.turnstile.render(widget, { sitekey: widget.dataset.sitekey });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var button = form.querySelector('button[type="submit"]');
    var errorBox = form.querySelector(".booking-error");
    if (button && button.disabled) return; // already in flight

    var payload = {};
    FIELDS.forEach(function (name) {
      var input = form.elements.namedItem(name);
      payload[name] = input ? input.value.trim() : "";
    });
    if (widgetId !== null) payload.turnstile_token = window.turnstile.getResponse(widgetId) || "";

    if (errorBox) errorBox.classList.remove("show");
    if (button) button.disabled = true;

    fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("area request failed: " + res.status);
        form.querySelector(".form-fields").hidden = true;
        form.querySelector(".form-success").classList.add("show");
      })
      .catch(function () {
        if (button) button.disabled = false;
        if (widgetId !== null) window.turnstile.reset(widgetId);
        if (errorBox) {
          errorBox.textContent = ERROR_MESSAGE;
          errorBox.classList.add("show");
        }
      });
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initAreaRequest(document.querySelector("form[data-area-request]"));
});
