import { describe, it, expect } from "vitest";
import { deriveLeadChannel } from "../worker.js";

describe("deriveLeadChannel", () => {
  it("is direct when there's no utm, click id or referrer", () => {
    expect(deriveLeadChannel({})).toBe("direct");
  });

  it.each(["gclid", "gbraid", "wbraid", "msclkid"])(
    "is paid_search for a %s click, even with a search-engine referrer",
    (clickId) => {
      expect(deriveLeadChannel({ [clickId]: "abc", referrerHost: "www.google.com" })).toBe("paid_search");
    }
  );

  it.each(["cpc", "CPC", "ppc", "paid", "paid_search", "paid-search", "paidsearch", "sem"])(
    "is paid_search for utm_medium=%s",
    (medium) => {
      expect(deriveLeadChannel({ utm_source: "google", utm_medium: medium })).toBe("paid_search");
    }
  );

  it.each(["facebook", "fb", "instagram", "ig", "meta", "linkedin", "tiktok"])(
    "is paid_social for paid utms from %s",
    (source) => {
      expect(deriveLeadChannel({ utm_source: source, utm_medium: "cpc" })).toBe("paid_social");
    }
  );

  it.each(["paid_social", "paid-social", "paidsocial"])("is paid_social for utm_medium=%s", (medium) => {
    expect(deriveLeadChannel({ utm_source: "partner", utm_medium: medium })).toBe("paid_social");
  });

  it("is paid_social for a Meta click with a paid medium", () => {
    expect(deriveLeadChannel({ fbclid: "x", utm_medium: "paid" })).toBe("paid_social");
  });

  it.each(["email", "e-mail", "newsletter"])("is email for utm_medium=%s", (medium) => {
    expect(deriveLeadChannel({ utm_medium: medium })).toBe("email");
  });

  it.each(["social", "social-media", "organic_social", "sm"])("is organic_social for utm_medium=%s", (medium) => {
    expect(deriveLeadChannel({ utm_medium: medium })).toBe("organic_social");
  });

  it("is organic_search for utm_medium=organic", () => {
    expect(deriveLeadChannel({ utm_source: "google", utm_medium: "organic" })).toBe("organic_search");
  });

  it("is referral for utm_medium=referral", () => {
    expect(deriveLeadChannel({ utm_source: "partner-site", utm_medium: "referral" })).toBe("referral");
  });

  it("is organic_social for a social utm_source with no medium", () => {
    expect(deriveLeadChannel({ utm_source: "linkedin" })).toBe("organic_social");
  });

  it("is unassigned for campaign tags it can't place, rather than guessing", () => {
    expect(deriveLeadChannel({ utm_source: "flyer", utm_medium: "qr" })).toBe("unassigned");
    expect(deriveLeadChannel({ utm_campaign: "spring" })).toBe("unassigned");
  });

  it("lets utms win over the referrer", () => {
    expect(deriveLeadChannel({ utm_medium: "email", referrerHost: "mail.google.com" })).toBe("email");
  });

  it("is organic_social for a Meta click with no paid medium (fbclid is on every Facebook link)", () => {
    expect(deriveLeadChannel({ fbclid: "x", referrerHost: "l.facebook.com" })).toBe("organic_social");
  });

  it.each(["www.google.com", "www.google.com.au", "www.bing.com", "duckduckgo.com", "search.yahoo.com", "www.ecosia.org", "search.brave.com"])(
    "is organic_search for a %s referrer",
    (host) => {
      expect(deriveLeadChannel({ referrerHost: host })).toBe("organic_search");
    }
  );

  it.each(["l.facebook.com", "m.facebook.com", "www.instagram.com", "www.linkedin.com", "lnkd.in", "t.co", "x.com", "www.youtube.com"])(
    "is organic_social for a %s referrer",
    (host) => {
      expect(deriveLeadChannel({ referrerHost: host })).toBe("organic_social");
    }
  );

  it("is referral for any other external site", () => {
    expect(deriveLeadChannel({ referrerHost: "www.yellowpages.com.au" })).toBe("referral");
  });

  it("does not mistake a lookalike host for a search engine", () => {
    expect(deriveLeadChannel({ referrerHost: "notgoogle.com" })).toBe("referral");
  });
});
