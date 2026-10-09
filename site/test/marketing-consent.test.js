import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const SITE_DIR = resolve(__dirname, "..");
const PAGES = readdirSync(SITE_DIR).filter((n) => n.endsWith(".html"));
const LABEL = "Send me occasional offers and updates from Vantage Point by email and SMS. I can unsubscribe at any time.";

describe("marketing_consent checkbox", () => {
  const forms = [];
  for (const page of PAGES) {
    const doc = new DOMParser().parseFromString(readFileSync(resolve(SITE_DIR, page), "utf8"), "text/html");
    for (const form of doc.querySelectorAll("form.assessment-form")) forms.push({ page, form });
  }

  it("finds the 18 lead forms", () => {
    expect(forms.filter(({ form }) => form.hasAttribute("data-channel")).length).toBe(18);
  });

  it.each(forms.map((f) => [f.page, f]))("%s form", (_p, { form }) => {
    const box = form.querySelector('input[type="checkbox"][name="marketing_consent"]');
    if (!form.hasAttribute("data-channel")) {
      expect(box).toBeNull();
      return;
    }
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    expect(box.hasAttribute("checked")).toBe(false);
    expect(box.required).toBe(false);
    expect(form.querySelector(`label[for="${box.id}"]`).textContent.trim()).toBe(LABEL);
    expect(box.closest(".marketing-consent").nextElementSibling.matches('button[type="submit"]')).toBe(true);
  });
});
