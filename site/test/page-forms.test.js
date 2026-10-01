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

  it("offers the five cleaning frequency options, in order", () => {
    const form = mountPage(page);
    const options = Array.from(form.querySelectorAll('[name="cleaning_frequency"]'), (el) => [
      el.value,
      el.closest("label").textContent.trim(),
    ]);
    expect(options).toEqual([
      ["daily", "Daily"],
      ["three_days_week", "3 days a week"],
      ["five_days_week", "5 days a week"],
      ["weekly", "Weekly"],
      ["fortnightly", "Fortnightly"],
    ]);
  });

  it("has a budget nurture message in the Step 2 results", () => {
    const form = mountPage(page);
    const message = form.querySelector(".booking-result #budget-nurture-message");
    expect(message).not.toBeNull();
    expect(message.textContent).toMatch(/budget/i);
  });

  it("puts Step 2 and every result panel inside a labelled modal dialog", () => {
    const form = mountPage(page);
    const dialog = form.querySelector("dialog.booking-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-label") || dialog.getAttribute("aria-labelledby")).toBeTruthy();
    for (const sel of [
      ".booking-step-2-questions",
      "#walkthrough-picker",
      "#booking-confirmed",
      "#no-calendar-message",
      "#budget-nurture-message",
    ]) {
      expect(dialog.querySelector(sel), sel).not.toBeNull();
    }
    expect(dialog.querySelector(".form-fields"), "Step 1 stays on the page").toBeNull();
  });

  it("focuses the first question, not the close button, when the dialog opens", () => {
    const form = mountPage(page);
    const autofocused = form.querySelectorAll(".booking-dialog [autofocus]");
    expect(Array.from(autofocused, (el) => el.name)).toEqual(["facility_type"]);
    expect(form.querySelectorAll("[autofocus]").length).toBe(1);
  });

  it("gives the dialog a labelled close button and the page a way back in", () => {
    const form = mountPage(page);
    const close = form.querySelector(".booking-dialog .booking-dialog-close");
    expect(close.getAttribute("type")).toBe("button");
    expect(close.getAttribute("aria-label")).toBe("Close");
    expect(form.querySelector(".booking-resume .booking-resume-btn").getAttribute("type")).toBe("button");
  });

  it("still marks the Step 2 questions as required for assistive tech", () => {
    const form = mountPage(page);
    for (const name of ["facility_type", "monthly_budget"]) {
      expect(form.querySelector(`.booking-step-2 [name="${name}"]`).getAttribute("aria-required")).toBe("true");
    }
  });

  it("has a Turnstile widget in Step 1, loaded before the booking-gate module", () => {
    const html = readFileSync(resolve(__dirname, "..", page), "utf8");
    const form = mountPage(page);
    const widget = form.querySelector(".form-fields .turnstile-widget");
    expect(widget).not.toBeNull();
    expect(widget.hasAttribute("data-sitekey")).toBe(true);

    const api = html.indexOf("challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(api).toBeGreaterThan(-1);
    expect(api).toBeLessThan(html.indexOf("assets/js/booking-gate.js"));
  });

  it("has the built-in picker and no GHL calendar embed", () => {
    const html = readFileSync(resolve(__dirname, "..", page), "utf8");
    expect(html).not.toMatch(/<iframe[^>]*leadconnectorhq/i);
    expect(html).not.toContain("form_embed.js");
    const form = mountPage(page);
    const picker = form.querySelector(".booking-result #walkthrough-picker");
    for (const sel of [".picker-week-label", ".picker-prev-week", ".picker-next-week", ".picker-days[role=radiogroup]", ".picker-times", ".picker-book[disabled]", ".booking-error"]) {
      expect(picker.querySelector(sel), sel).not.toBeNull();
    }
    const addr = picker.querySelector('input[name="site_address"]');
    expect(addr.getAttribute("autocomplete")).toBe("street-address");
    expect(addr.getAttribute("aria-required")).toBe("true"); // JS sets `required` once the picker is live
    expect(addr.getAttribute("maxlength")).toBe("200");
    expect(picker.querySelector(`label[for="${addr.id}"]`)).not.toBeNull();
    expect(addr.compareDocumentPosition(picker.querySelector(".picker-book")) & 4).toBeTruthy();
    expect(form.querySelector(".booking-result #booking-confirmed").textContent.trim()).toBe("");
  });
});
