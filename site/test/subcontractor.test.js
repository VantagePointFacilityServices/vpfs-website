import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const SITE_DIR = resolve(__dirname, "..");
const html = readFileSync(resolve(SITE_DIR, "subcontractor.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

describe("subcontractor.html copy", () => {
  it("renders the approved hero, requirements, process and cross-links", () => {
    expect(doc.querySelector("h1").textContent).toBe("Good contractors deserve good sites.");
    const body = text(doc.body);
    expect(body).toContain("We're looking for experienced commercial cleaning contractors with an ABN.");
    const reqs = Array.from(doc.querySelectorAll("#requirements li"), (li) => text(li));
    expect(reqs).toEqual([
      "An ABN", "Public liability insurance", "Your own equipment", "Your own reliable transport",
      "The right to work in Australia", "A police check (we collect it after your interview)",
      "At least 1 year of commercial cleaning experience", "A Blue Card, for school or childcare sites only",
    ]);
    const steps = Array.from(doc.querySelectorAll("#how-it-works .process-step h4"), (h) => text(h));
    expect(steps).toEqual([
      "1. Apply", "2. A few quick questions", "3. Book your group interview call",
      "4. Compliance documents", "5. Site induction", "6. Paid trial job",
    ]);
    const links = Array.from(doc.querySelectorAll("main a, section a")).filter((a) => /Join the team/.test(a.textContent));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.every((a) => a.getAttribute("href") === "careers.html")).toBe(true);
  });

  it("states no rates or payment terms and has a hidden contractor story and photo slot", () => {
    expect(doc.querySelector("#contractor-story").hasAttribute("hidden")).toBe(true);
    expect(doc.querySelector(".image-slot").hasAttribute("hidden")).toBe(true);
    expect(text(doc.body)).not.toMatch(/\$\d/);
  });

  it("passes the employee-programme guardrail", () => {
    const visible = html.toLowerCase();
    for (const word of ["bonus", "roster", "equipment supplied", "crew", "promot"]) {
      expect(visible).not.toContain(word);
    }
  });
});

describe("subcontractor.html form", () => {
  const form = doc.querySelector("form[data-apply]");

  it("is the applicant flow with the subcontractor track and a post fallback", () => {
    expect(form.getAttribute("data-engagement-track")).toBe("subcontractor");
    expect(form.getAttribute("method")).toBe("post");
    expect(doc.querySelector('script[type="module"][src^="assets/js/apply.js"]')).not.toBeNull();
  });

  it("has the five Step 1 fields and no required field in Step 2", () => {
    const names = Array.from(form.querySelectorAll(".form-fields input[name]"), (i) => i.name);
    for (const n of ["first_name", "last_name", "email", "phone", "postcode"]) expect(names).toContain(n);
    expect(form.querySelectorAll(".booking-step-2 [required]").length).toBe(0);
  });

  it("asks the nine common and three subcontractor questions in the Step 2 dialog", () => {
    const dialog = form.querySelector("dialog.booking-dialog");
    const names = [...new Set(Array.from(dialog.querySelectorAll(".booking-step-2-questions input[type=radio]"), (i) => i.name))];
    expect(names).toEqual([
      "cleaning_experience", "right_to_work", "police_check_status", "blue_card_status", "availability",
      "start_availability", "reliable_transport", "physical_capability", "passion_rating",
      "has_own_insurance_and_abn", "own_equipment", "works_for_other_clients",
    ]);
    const exp = Array.from(dialog.querySelectorAll('[name="cleaning_experience"]'), (i) => i.value);
    expect(exp).toEqual(["none", "under_1_year", "1_to_3_years", "3_to_5_years", "5_plus_years"]);
    for (const sel of ["#walkthrough-picker", "#booking-confirmed", "#no-calendar-message", "#unsuccessful-message", "#unsuccessful-no-abn-message"]) {
      expect(dialog.querySelector(sel)).not.toBeNull();
    }
  });

  it("carries no collection notice and the D20 form note", () => {
    expect(form.querySelector(".form-privacy-notice")).toBeNull();
    expect(text(form.querySelector(".form-note"))).toBe("Takes about 2 minutes: a few quick screening questions, then book your interview.");
  });
});

describe("subcontractor.html schema and discovery", () => {
  const schemas = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'), (s) => JSON.parse(s.textContent));

  it("has a CONTRACTOR JobPosting with datePosted and validThrough, and no FAQ or Review schema", () => {
    const job = schemas.find((s) => s["@type"] === "JobPosting");
    expect(job.employmentType).toBe("CONTRACTOR");
    expect(job.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(job.validThrough).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(job.validThrough) > new Date(job.datePosted)).toBe(true);
    expect(job.baseSalary).toBeUndefined();
    expect(schemas.map((s) => s["@type"]).filter((t) => /FAQ|Review/.test(t))).toEqual([]);
  });

  it("is in the sitemap", () => {
    const sitemap = readFileSync(resolve(SITE_DIR, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://www.vantagepointfacilityservices.com.au/subcontractor.html</loc>");
  });
});

describe("footer link", () => {
  const isRedirect = (h) => /<meta http-equiv="refresh"/.test(h);
  const pages = readdirSync(SITE_DIR).filter((f) => f.endsWith(".html"))
    .filter((f) => !isRedirect(readFileSync(resolve(SITE_DIR, f), "utf8")));

  it.each(pages)("%s links Subcontract with us right after Careers", (page) => {
    const d = new DOMParser().parseFromString(readFileSync(resolve(SITE_DIR, page), "utf8"), "text/html");
    const careers = Array.from(d.querySelectorAll("footer li")).find((li) => li.textContent.trim() === "Careers");
    const next = careers.nextElementSibling;
    expect(next.textContent.trim()).toBe("Subcontract with us");
    expect(next.querySelector("a").getAttribute("href")).toBe("subcontractor.html");
  });
});
