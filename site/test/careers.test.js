import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const html = readFileSync(resolve(__dirname, "..", "careers.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const text = doc.body.textContent.replace(/\s+/g, " ");

describe("careers.html talent pool: copy", () => {
  it("calls the role cleaning technician and drops the old award-pay headline", () => {
    expect(text).not.toMatch(/\bcleaners?\b/i);
    expect(text).not.toContain("Award pay from");
    expect(doc.querySelector('meta[name="description"]').getAttribute("content")).toContain("Above-award pay for good technicians");
    expect(html).not.toMatch(/\bcleaners?\b/i);
  });

  it("renders hero, requirements, pay, bonuses, ladder, process and cross-link", () => {
    expect(doc.querySelector("h1").textContent).toBe("For cleaning technicians who take pride in the detail.");
    for (const s of [
      "Join the team as we grow",
      "What we ask of you",
      "Above-award pay for good technicians",
      "we pay good cleaning technicians above it",
      "$27.08 an hour",
      "$33.85 an hour",
      "Paid weekly",
      "Quarterly quality bonuses",
      "Build a career in cleaning, not just a shift.",
      "Cleaning Technician.",
      "Senior Cleaning Technician.",
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

describe("careers.html display fixes", () => {
  it("makes the requirements list readable and the hero eyebrow light", () => {
    expect(doc.querySelector(".careers-list").classList.contains("on-light")).toBe(true);
    expect(doc.querySelector(".hero-inner .eyebrow").classList.contains("on-inverse")).toBe(true);
  });

  it("says Email us, not Email or call", () => {
    expect(text).not.toContain("Email or call");
  });

  it("lets the hero email break after the @", () => {
    const a = doc.querySelector('.hero-inner a[href^="mailto:"], .hero-grid a[href^="mailto:"]');
    expect(a.innerHTML).toContain("careers@<wbr>");
  });
});

describe("careers.html approved copy", () => {
  const heroChecks = Array.from(doc.querySelectorAll(".hero-inner .hero-checks li")).map((li) => li.textContent.trim());

  it("mentions weekly pay and the supplied kit in the hero checks", () => {
    expect(heroChecks.some((c) => /weekly/i.test(c))).toBe(true);
    expect(heroChecks).toContain("Uniform, PPE and equipment supplied");
    expect(heroChecks).not.toContain("Written scope for every site");
    expect(heroChecks.length).toBe(4);
  });

  it("lists the three D1 benefits", () => {
    const h = doc.querySelector("#benefits");
    expect(h).not.toBeNull();
    const t = h.textContent.replace(/\s+/g, " ");
    expect(t).toContain("What comes with the job");
    expect(t).toContain("Uniform and PPE issued at induction");
    expect(t).toContain("Equipment and chemicals supplied");
    expect(t).toContain("The same sites, a small team");
    expect(t).toContain("Wherever possible");
  });

  it("has a What the work looks like section with the weekend and public-holiday line", () => {
    const sec = doc.querySelector("#the-work");
    expect(sec).not.toBeNull();
    expect(sec.querySelector("h2").textContent).toBe("What the work looks like");
    const t = sec.textContent.replace(/\s+/g, " ");
    expect(t).toContain("Our first intake is likely to be weekend and public-holiday casual shifts.");
    expect(t).toContain("Sign in on Connecteam when you arrive.");
    expect(sec.querySelectorAll("ol li").length).toBe(4);
    expect(text.indexOf("What we ask of you")).toBeLessThan(text.indexOf("What the work looks like"));
  });

  it("uses the approved meta description on all three tags", () => {
    const d = "Above-award pay for good technicians, paid weekly, with uniform, PPE and equipment supplied. Casual commercial cleaning on the Gold Coast. Join our shortlist.";
    expect(doc.querySelector('meta[name="description"]').getAttribute("content")).toBe(d);
    expect(doc.querySelector('meta[property="og:description"]').getAttribute("content")).toBe(d);
    expect(doc.querySelector('meta[name="twitter:description"]').getAttribute("content")).toBe(d);
  });

  it("carries the lengthened process lines", () => {
    expect(text).toContain("You’ll have the pay and the work in front of you before you decide.");
    expect(text).toContain("with someone on site to show you the scope, and you’re paid for it.");
  });
});

describe("careers.html section backgrounds", () => {
  it("alternates white and wash between the hero and the final call to action", () => {
    const sections = [...doc.querySelectorAll("body > section, main > section")].filter(
      (s) => !s.hidden && !s.classList.contains("hero-inverse") && !s.classList.contains("final-cta")
    );
    const isWash = (s) => (s.getAttribute("style") || "").includes("--surface-wash");
    expect(sections.length).toBeGreaterThan(3);
    sections.slice(1).forEach((s, i) => {
      expect(isWash(s), `#${s.id || i + 1} repeats its neighbour's background`).not.toBe(isWash(sections[i]));
    });
    expect(isWash(sections[sections.length - 1])).toBe(true);
  });
});
