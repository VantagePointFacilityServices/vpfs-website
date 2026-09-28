import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Step 1 and Step 2 share one <form>, so the browser's native validation on
// Step 1's submit also checks Step 2's fields — which are hidden at that
// point. A `required` Step 2 field makes the browser block the submit with
// "An invalid form control ... is not focusable". Step 2 validates itself in
// JS (isGatePayloadComplete in booking-gate.js) instead.
const PAGES = ["index.html", "contact.html"];

function mountPage(page) {
  const html = readFileSync(resolve(__dirname, "..", page), "utf8");
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML;
  return document.querySelector(".assessment-form");
}

describe.each(PAGES)("%s booking form", (page) => {
  it("has no natively-required fields in the hidden Step 2", () => {
    const form = mountPage(page);
    const required = form.querySelectorAll(".booking-step-2 [required]");
    expect(Array.from(required, (el) => el.name)).toEqual([]);
  });

  it("passes native validation once only the Step 1 fields are filled", () => {
    const form = mountPage(page);
    const fill = { first_name: "Alex", email: "alex@example.com", phone: "0400000000", postcode: "4211" };
    for (const [name, value] of Object.entries(fill)) {
      form.querySelector(`.form-fields [name="${name}"]`).value = value;
    }
    expect(form.checkValidity()).toBe(true);
  });

  it("still marks the Step 2 questions as required for assistive tech", () => {
    const form = mountPage(page);
    for (const name of ["facility_type", "monthly_budget"]) {
      expect(form.querySelector(`.booking-step-2 [name="${name}"]`).getAttribute("aria-required")).toBe("true");
    }
  });
});
