import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const html = readFileSync(resolve(__dirname, "..", "careers.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");

describe("careers.html interim contact block", () => {
  it("has no form (the careers form was never connected)", () => {
    expect(doc.querySelector("form")).toBeNull();
    expect(doc.querySelector(".form-privacy-notice")).toBeNull();
  });

  it("offers mailto and tel links in the apply area", () => {
    const apply = doc.getElementById("apply");
    expect(apply).not.toBeNull();
    expect(apply.querySelector('a[href="mailto:booking@vantagepointfacilityservices.com.au"]')).not.toBeNull();
    expect(apply.querySelector('a[href="tel:0756512257"]')).not.toBeNull();
  });

  it("points every Apply now anchor at the apply area", () => {
    const anchors = Array.from(doc.querySelectorAll("a")).filter((a) => a.textContent.trim() === "Apply now");
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const a of anchors) expect(a.getAttribute("href")).toBe("#apply");
  });

  it("makes no claims about response time, sign-up speed or a screening survey", () => {
    for (const phrase of ["1 business day", "10 seconds", "screening survey"]) {
      expect(html.toLowerCase()).not.toContain(phrase);
    }
  });
});
