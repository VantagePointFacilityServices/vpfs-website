// Vantage Point Facility Services — UTM capture
//
// Ad/campaign links land on any page (services.html?utm_source=google...),
// but the visitor usually clicks through to the homepage or contact.html
// before submitting the booking gate — losing the URL's utm params on the
// way. So every page loads this module, which stashes the landing page's
// utms in sessionStorage; booking-gate.js then calls readUtms() at Step 1
// submit and sends them to the Worker's /lead, which writes them onto the
// GHL contact as custom fields.
//
// Last-touch within the session: a new campaign link replaces the stored
// utms, a page without any leaves them alone. Storage can be blocked
// (private windows, disabled site data) — the current URL still works then.

export var UTM_STORAGE_KEY = "vpfs_utm";

var UTM_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
var MAX_VALUE_LENGTH = 200;

function utmsFromSearch(search) {
  var params = new URLSearchParams(search || "");
  var utms = {};
  UTM_PARAMS.forEach(function (name) {
    var value = (params.get(name) || "").trim();
    if (value) utms[name] = value.slice(0, MAX_VALUE_LENGTH);
  });
  return utms;
}

function storedUtms(storage) {
  try {
    var raw = storage && storage.getItem(UTM_STORAGE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

export function captureUtms(search, storage) {
  var utms = utmsFromSearch(search);
  if (Object.keys(utms).length === 0) return;
  try {
    storage.setItem(UTM_STORAGE_KEY, JSON.stringify(utms));
  } catch (err) {
    // Storage blocked — readUtms() still reads the current URL.
  }
}

export function readUtms(search, storage) {
  var fromUrl = utmsFromSearch(search);
  return Object.keys(fromUrl).length > 0 ? fromUrl : storedUtms(storage);
}

// Accessing window.sessionStorage itself can throw when site data is
// blocked, not just its methods.
export function sessionStore() {
  try {
    return window.sessionStorage;
  } catch (err) {
    return null;
  }
}

captureUtms(window.location.search, sessionStore());
