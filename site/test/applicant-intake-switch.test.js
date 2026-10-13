import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Until the GHL people sub-account exists, both applicant pages run in
// "contact" mode: the forms stay in the markup but are switched off, and an
// email/phone block takes their place. Flipping <body data-applicant-intake>
// to "form" restores the forms (one line per page).
const SITE_DIR = resolve(__dirname, "..");
const css = readFileSync(resolve(SITE_DIR, "assets/css/style.css"), "utf8");
const parse = (page) => new DOMParser().parseFromString(readFileSync(resolve(SITE_DIR, page), "utf8"), "text/html");

describe("applicant intake switch CSS", () => {
  it("hides form-only content in contact mode and contact-only content in form mode", () => {
    const flat = css.replace(/\s+/g, " ");
    expect(flat).toContain('body[data-applicant-intake="contact"] [data-intake-only="form"]');
    expect(flat).toContain('body[data-applicant-intake="form"] [data-intake-only="contact"]');
  });
});

describe.each(["careers.html", "subcontractor.html"])("%s in contact mode", (page) => {
  const doc = parse(page);

  it("is switched to contact mode", () => {
    expect(doc.body.dataset.applicantIntake).toBe("contact");
  });

  it("keeps the application form in the page, marked form-only", () => {
    const form = doc.querySelector("form[data-apply]");
    expect(form).not.toBeNull();
    expect(form.closest('[data-intake-only="form"]')).not.toBeNull();
  });

  it("shows an email and phone block inside the #apply target", () => {
    const block = doc.querySelector('#apply [data-intake-only="contact"]');
    expect(block).not.toBeNull();
    expect(block.querySelector('a[href="mailto:booking@vantagepointfacilityservices.com.au"]')).not.toBeNull();
    expect(block.querySelector('a[href="tel:0756512257"]')).not.toBeNull();
  });

  it("marks every on-the-spot promise as form-only", () => {
    const visible = Array.from(doc.body.querySelectorAll("*"))
      .filter((el) => !el.closest('[data-intake-only="form"]') && el.children.length === 0)
      .map((el) => el.textContent)
      .join(" ");
    expect(visible).not.toMatch(/straight away|on the spot|right on the page|quick screening questions/i);
  });
});
