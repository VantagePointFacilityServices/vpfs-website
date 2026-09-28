import { describe, it, expect, beforeEach } from "vitest";
import { captureUtms, readUtms, UTM_STORAGE_KEY } from "../assets/js/utm.js";

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

let storage;
beforeEach(() => {
  storage = fakeStorage();
});

describe("readUtms", () => {
  it("reads all five utm params from the current URL", () => {
    const search =
      "?utm_source=google&utm_medium=cpc&utm_campaign=office-gc&utm_term=office+cleaning&utm_content=ad1";
    expect(readUtms(search, storage)).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "office-gc",
      utm_term: "office cleaning",
      utm_content: "ad1",
    });
  });

  it("ignores non-utm params and blank values", () => {
    expect(readUtms("?utm_source=&gclid=abc&utm_medium=email", storage)).toEqual({
      utm_medium: "email",
    });
  });

  it("returns an empty object when there are no utms anywhere", () => {
    expect(readUtms("", storage)).toEqual({});
  });

  it("falls back to utms captured on an earlier page in the session", () => {
    captureUtms("?utm_source=facebook&utm_campaign=strata", storage);
    expect(readUtms("", storage)).toEqual({ utm_source: "facebook", utm_campaign: "strata" });
  });

  it("prefers the current URL's utms over stored ones", () => {
    captureUtms("?utm_source=facebook", storage);
    expect(readUtms("?utm_source=google", storage)).toEqual({ utm_source: "google" });
  });

  it("caps each value's length so junk params can't bloat the contact", () => {
    const long = "x".repeat(500);
    expect(readUtms("?utm_source=" + long, storage).utm_source).toHaveLength(200);
  });

  it("still reads the URL when storage is blocked", () => {
    expect(readUtms("?utm_source=google", throwingStorage())).toEqual({ utm_source: "google" });
  });
});

describe("captureUtms", () => {
  it("stores the landing page's utms for later pages", () => {
    captureUtms("?utm_source=google&utm_medium=cpc", storage);
    expect(JSON.parse(storage.getItem(UTM_STORAGE_KEY))).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
    });
  });

  it("does not wipe stored utms when a later page has none", () => {
    captureUtms("?utm_source=google", storage);
    captureUtms("", storage);
    expect(JSON.parse(storage.getItem(UTM_STORAGE_KEY))).toEqual({ utm_source: "google" });
  });

  it("replaces stored utms when the visitor arrives from a new campaign link", () => {
    captureUtms("?utm_source=google&utm_term=cleaning", storage);
    captureUtms("?utm_source=facebook", storage);
    expect(JSON.parse(storage.getItem(UTM_STORAGE_KEY))).toEqual({ utm_source: "facebook" });
  });

  it("does not throw when storage is blocked", () => {
    expect(() => captureUtms("?utm_source=google", throwingStorage())).not.toThrow();
  });

  it("ignores corrupt stored data", () => {
    storage.setItem(UTM_STORAGE_KEY, "{not json");
    expect(readUtms("", storage)).toEqual({});
  });
});
