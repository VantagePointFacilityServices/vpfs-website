import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const html = readFileSync(resolve(__dirname, "..", "careers.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const text = doc.body.textContent.replace(/\s+/g, " ");

describe("careers.html talent pool: copy", () => {
  it("renders hero, requirements, pay, bonuses, ladder, process and cross-link", () => {
    expect(doc.querySelector("h1").textContent).toBe("For cleaners who take pride in the detail.");
    for (const s of [
      "Join the team as we grow",
      "What we ask of you",
      "$27.08 an hour",
      "$33.85 an hour",
      "Paid weekly",
      "Quarterly quality bonuses",
      "Build a career in cleaning, not just a shift.",
      "Senior Cleaner.",
      "two consecutive quarters at the standard",
      "Site Lead / Trainer.",
      "Cleaning Supervisor.",
      "Operations Manager.",
      "Paid, supervised first shift",
      "We’re not hiring for a set role today",
    ]) expect(text).toContain(s);
    expect(doc.querySelectorAll(".career-ladder li").length).toBe(5);
    expect(doc.querySelectorAll(".process-step").length).toBe(5);
    expect(doc.querySelector('a[href="subcontractor.html"]')).not.toBeNull();
  });

  it("names no bonus amounts", () => {
    const bonus = text.slice(text.indexOf("Quarterly quality bonuses"), text.indexOf("Build a career"));
    expect(bonus).not.toMatch(/\$\d/);
  });

  it("has no JobPosting schema, referral card, or response-time promise", () => {
    expect(html).not.toContain("JobPosting");
    expect(doc.querySelector('script[type="application/ld+json"]')).toBeNull();
    for (const phrase of ["1 business day", "10 seconds", "referral", "upsell", "Cert III", "Certificate III"]) {
      expect(html.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it("uses the closed-intake form note and no collection notice", () => {
    expect(doc.querySelector(".form-privacy-notice")).toBeNull();
    expect(text).toContain("Takes about 2 minutes: a few quick screening questions to join our shortlist.");
    expect(text).not.toContain("then book your interview");
  });

  it("keeps the proof slots hidden", () => {
    const slots = doc.querySelector(".proof-slots");
    expect(slots).not.toBeNull();
    expect(slots.hasAttribute("hidden")).toBe(true);
    expect(slots.querySelectorAll("[data-slot]").length).toBe(3);
  });
});

describe("careers.html talent pool: form", () => {
  const form = doc.querySelector("form[data-apply]");

  it("is the applicant form on the employee track", () => {
    expect(form).not.toBeNull();
    expect(form.getAttribute("data-engagement-track")).toBe("employee");
    expect(doc.querySelector('script[src="assets/js/apply.js"]')).not.toBeNull();
  });

  it("has the Step 1 fields and the nine employee screening questions", () => {
    for (const n of ["first_name", "last_name", "email", "phone", "postcode"]) {
      expect(form.querySelector(`.form-fields [name="${n}"]`)).not.toBeNull();
    }
    for (const n of ["cleaning_experience", "right_to_work", "police_check_status", "blue_card_status",
      "availability", "start_availability", "reliable_transport", "physical_capability", "passion_rating"]) {
      expect(form.querySelectorAll(`.booking-step-2 [name="${n}"]`).length).toBeGreaterThan(1);
    }
    expect(form.querySelector('[name="has_own_insurance_and_abn"]')).toBeNull();
    expect(form.querySelector('[name="marketing_consent"]')).toBeNull();
  });

  it("has the shortlist and unsuccessful result panels", () => {
    for (const id of ["shortlist-message", "unsuccessful-message", "unsuccessful-no-abn-message",
      "no-calendar-message", "walkthrough-picker", "booking-confirmed"]) {
      expect(form.querySelector(`#${id}`)).not.toBeNull();
    }
  });

  it("points every join-our-shortlist button at the form", () => {
    const anchors = Array.from(doc.querySelectorAll("a.btn")).filter((a) => a.textContent.trim() === "Join our shortlist");
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const a of anchors) expect(a.getAttribute("href")).toBe("#apply");
  });
});
