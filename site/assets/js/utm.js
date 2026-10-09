// Vantage Point Facility Services — UTM and arrival capture
//
// Ad/campaign links land on any page (services.html?utm_source=google...),
// but the visitor usually clicks through to the homepage or contact.html
// before submitting the booking gate — losing the URL's params on the
// way. So every page loads this module, which stashes how the visitor
// arrived in sessionStorage: utm_* tags, ad click ids (Google Ads
// auto-tagging sends gclid instead of utms) and the external referrer's
// hostname. booking-gate.js then calls readAttribution() at Step 1 submit
// and sends it to the Worker's /lead, which writes the utms onto the GHL
// contact and derives lead_channel from all of it.
//
// Last-touch within the session: arriving from another site or a campaign
// link replaces the whole stored arrival; clicking between our own pages
// leaves it alone. Storage can be blocked (private windows, disabled site
// data) — the current page's URL and referrer still work then.

export var ATTRIBUTION_STORAGE_KEY = "vpfs_attribution";

var URL_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "gbraid", "wbraid", "msclkid", "fbclid",
];
var MAX_VALUE_LENGTH = 200;

function withoutWww(host) {
  return host.toLowerCase().replace(/^www\./, "");
}

// Hostname only: the path and query of the page they came from can carry
// search terms or personal details we have no reason to keep.
function externalReferrerHost(referrer, ownHost) {
  var host;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch (err) {
    return "";
  }
  return host && withoutWww(host) !== withoutWww(ownHost || "") ? host.slice(0, MAX_VALUE_LENGTH) : "";
}

function arrivalFrom(location, referrer) {
  var params = new URLSearchParams(location.search || "");
  var arrival = {};
  URL_PARAMS.forEach(function (name) {
    var value = (params.get(name) || "").trim();
    if (value) arrival[name] = value.slice(0, MAX_VALUE_LENGTH);
  });
  var referrerHost = externalReferrerHost(referrer, location.hostname);
  if (referrerHost) arrival.referrer_host = referrerHost;
  return arrival;
}

function storedArrival(storage) {
  try {
    var raw = storage && storage.getItem(ATTRIBUTION_STORAGE_KEY);
    var parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

export function captureAttribution(location, referrer, storage) {
  var arrival = arrivalFrom(location, referrer);
  if (Object.keys(arrival).length === 0) return;
  try {
    storage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(arrival));
  } catch (err) {
    // Storage blocked — readAttribution() still reads the current page.
  }
}

export function readAttribution(location, referrer, storage) {
  var current = arrivalFrom(location, referrer);
  return Object.keys(current).length > 0 ? current : storedArrival(storage);
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

captureAttribution(window.location, document.referrer, sessionStore());
