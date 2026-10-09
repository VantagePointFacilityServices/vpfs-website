import { describe, it, expect, beforeEach } from "vitest";
import { captureAttribution, readAttribution, ATTRIBUTION_STORAGE_KEY } from "../assets/js/utm.js";

function fakeStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
}

// A location on our own site, as window.location would be.
const at = (search) => ({ search, hostname: "www.vantagepointfacilityservices.com.au" });

let storage;
beforeEach(() => {
  storage = fakeStorage();
});

describe("readAttribution", () => {
  it("reads all five utm params from the current URL", () => {
    const search =
      "?utm_source=google&utm_medium=cpc&utm_campaign=office-gc&utm_term=office+cleaning&utm_content=ad1";
    expect(readAttribution(at(search), "", storage)).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "office-gc",
      utm_term: "office cleaning",
      utm_content: "ad1",
    });
  });

  it("ignores unknown params and blank values", () => {
    expect(readAttribution(at("?utm_source=&foo=abc&utm_medium=email"), "", storage)).toEqual({
      utm_medium: "email",
    });
  });

  it("reads ad click ids, which Google/Microsoft/Meta add instead of utms", () => {
    const search = "?gclid=g1&gbraid=g2&wbraid=g3&msclkid=m1&fbclid=f1";
    expect(readAttribution(at(search), "", storage)).toEqual({
      gclid: "g1", gbraid: "g2", wbraid: "g3", msclkid: "m1", fbclid: "f1",
    });
  });

  it("records an external referrer's hostname, never its path or query", () => {
    expect(readAttribution(at(""), "https://www.google.com/search?q=cleaners", storage)).toEqual({
      referrer_host: "www.google.com",
    });
  });

  it("ignores a referrer from our own site, with or without www", () => {
    expect(readAttribution(at(""), "https://www.vantagepointfacilityservices.com.au/services.html", storage)).toEqual({});
    expect(readAttribution(at(""), "https://vantagepointfacilityservices.com.au/", storage)).toEqual({});
  });

  it("ignores a referrer that isn't a URL", () => {
    expect(readAttribution(at(""), "not a url", storage)).toEqual({});
  });

  it("returns an empty object when there are no utms anywhere", () => {
    expect(readAttribution(at(""), "", storage)).toEqual({});
  });

  it("falls back to utms captured on an earlier page in the session", () => {
    captureAttribution(at("?utm_source=facebook&utm_campaign=strata"), "", storage);
    expect(readAttribution(at(""), "", storage)).toEqual({ utm_source: "facebook", utm_campaign: "strata" });
  });

  it("prefers the current URL's utms over stored ones", () => {
    captureAttribution(at("?utm_source=facebook"), "", storage);
    expect(readAttribution(at("?utm_source=google"), "", storage)).toEqual({ utm_source: "google" });
  });

  it("caps each value's length so junk params can't bloat the contact", () => {
    const long = "x".repeat(500);
    expect(readAttribution(at("?utm_source=" + long), "", storage).utm_source).toHaveLength(200);
  });

  it("still reads the URL when storage is blocked", () => {
    expect(readAttribution(at("?utm_source=google"), "", throwingStorage())).toEqual({ utm_source: "google" });
  });
});

describe("captureAttribution", () => {
  it("stores the landing page's utms for later pages", () => {
    captureAttribution(at("?utm_source=google&utm_medium=cpc"), "", storage);
    expect(JSON.parse(storage.getItem(ATTRIBUTION_STORAGE_KEY))).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
    });
  });

  it("does not wipe stored utms when a later page has none", () => {
    captureAttribution(at("?utm_source=google"), "", storage);
    captureAttribution(at(""), "", storage);
    expect(JSON.parse(storage.getItem(ATTRIBUTION_STORAGE_KEY))).toEqual({ utm_source: "google" });
  });

  it("stores the click id and referrer with the landing page's utms", () => {
    captureAttribution(at("?utm_source=google&gclid=abc"), "https://www.google.com/", storage);
    expect(JSON.parse(storage.getItem(ATTRIBUTION_STORAGE_KEY))).toEqual({
      utm_source: "google",
      gclid: "abc",
      referrer_host: "www.google.com",
    });
  });

  it("does not wipe the stored arrival when the visitor clicks through our own pages", () => {
    captureAttribution(at(""), "https://www.bing.com/", storage);
    captureAttribution(at(""), "https://www.vantagepointfacilityservices.com.au/", storage);
    expect(JSON.parse(storage.getItem(ATTRIBUTION_STORAGE_KEY))).toEqual({ referrer_host: "www.bing.com" });
  });

  it("replaces the whole stored arrival when the visitor comes back from another site", () => {
    captureAttribution(at("?utm_source=google&gclid=abc"), "", storage);
    captureAttribution(at(""), "https://www.facebook.com/", storage);
    expect(JSON.parse(storage.getItem(ATTRIBUTION_STORAGE_KEY))).toEqual({ referrer_host: "www.facebook.com" });
  });

  it("replaces stored utms when the visitor arrives from a new campaign link", () => {
    captureAttribution(at("?utm_source=google&utm_term=cleaning"), "", storage);
    captureAttribution(at("?utm_source=facebook"), "", storage);
    expect(JSON.parse(storage.getItem(ATTRIBUTION_STORAGE_KEY))).toEqual({ utm_source: "facebook" });
  });

  it("does not throw when storage is blocked", () => {
    expect(() => captureAttribution(at("?utm_source=google"), "", throwingStorage())).not.toThrow();
  });

  it("ignores corrupt stored data", () => {
    storage.setItem(ATTRIBUTION_STORAGE_KEY, "{not json");
    expect(readAttribution(at(""), "", storage)).toEqual({});
  });
});
