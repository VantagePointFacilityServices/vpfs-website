import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Step 1 and Step 2 share one <form>, so the browser's native validation on
// Step 1's submit also checks Step 2's fields — which are hidden at that
// point. A `required` Step 2 field makes the browser block the submit with
// "An invalid form control ... is not focusable". Step 2 validates itself in
// JS (isGatePayloadComplete in booking-gate.js) instead.
// Landing pages are discovered by <body data-page-type="landing">, so a new
// landing page is covered here without editing this file.
const SITE_DIR = resolve(__dirname, "..");
const LANDING_PAGES = readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => /data-page-type="landing"/.test(readFileSync(resolve(SITE_DIR, f), "utf8")));
const PAGES = ["index.html", "contact.html", ...LANDING_PAGES];

// D14: facility_type each vertical page pre-selects ("" = precinct, nothing).
const FACILITY_DEFAULT = {
  office: "office", strata: "strata", school: "education", childcare: "childcare",
  medical: "medical", warehouse: "construction",
};
const CTA = (key) => (key === "strata" ? "Request a Committee Proposal" : "Request a Facility Consultation");

function mountPage(page) {
  const html = readFileSync(resolve(__dirname, "..", page), "utf8");
  document.documentElement.innerHTML = new DOMParser()
    .parseFromString(html, "text/html")
    .documentElement.innerHTML;
  return document.querySelector(".assessment-form");
}

describe.each(PAGES)("%s booking form", (page) => {
  it("asks for a required business name between last name and email", () => {
    const form = mountPage(page);
    const field = form.querySelector('.form-fields [name="company_name"]');
    expect(field).not.toBeNull();
    expect(field.required).toBe(true);
    expect(field.getAttribute("autocomplete")).toBe("organization");
    const names = Array.from(form.querySelectorAll(".form-fields [name]"), (el) => el.name);
    expect(names.indexOf("company_name")).toBe(names.indexOf("last_name") + 1);
    expect(names.indexOf("email")).toBe(names.indexOf("company_name") + 1);
  });

  it("uses the approved no-calendar fallback copy and has no dead 'Request received' panel", () => {
    const form = mountPage(page);
    const msg = document.querySelector("#no-calendar-message");
    expect(msg).not.toBeNull();
    expect(msg.querySelector("p").textContent.trim()).toBe(
      "We couldn\u2019t load walkthrough times just now. One of the team will call you shortly to book one in \u2014 free, no obligation."
    );
    expect(msg.querySelector("h3").textContent).toContain("be in touch");
    expect(form.textContent).not.toContain("Request received");
  });

  it("offers childcare in the Step 2 facility type select", () => {
    const form = mountPage(page);
    const values = Array.from(form.querySelectorAll("select[name=facility_type] option"), (o) => o.value);
    expect(values).toContain("childcare");
  });

  it("has no natively-required fields in the hidden Step 2", () => {
    const form = mountPage(page);
    const required = form.querySelectorAll(".booking-step-2 [required]");
    expect(Array.from(required, (el) => el.name)).toEqual([]);
  });

  it("passes native validation once only the Step 1 fields are filled", () => {
    const form = mountPage(page);
    const fill = { first_name: "Alex", company_name: "Acme", email: "alex@example.com", phone: "0400000000", postcode: "4211" };
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

  it("offers the optional switch-timing question with the six values", () => {
    const form = mountPage(page);
    const options = Array.from(form.querySelectorAll('[name="switch_timing"]'), (el) => [
      el.value,
      el.closest("label").textContent.trim(),
    ]);
    expect(options).toEqual([
      ["ready_now", "No current cleaner / ready now"],
      ["within_3_months", "Within 3 months"],
      ["3_to_6_months", "3\u20136 months"],
      ["6_to_12_months", "6\u201312 months"],
      ["12_plus_months", "12+ months (locked in)"],
      ["not_sure", "Not sure"],
    ]);
    expect(form.querySelector('[name="switch_timing"][required]')).toBeNull();
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

describe("landing page forms", () => {
  const keyOf = (page) => {
    mountPage(page);
    return document.body.dataset.pageKey;
  };

  it("uses a unique website-lp-<key> conversion page matching the page key", () => {
    const values = LANDING_PAGES.map((page) => {
      const key = keyOf(page);
      const value = mountPage(page).dataset.conversionPage;
      expect(value, page).toBe(`website-lp-${key}`);
      return value;
    });
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(LANDING_PAGES)("%s pre-selects the D14 facility_type", (page) => {
    const key = keyOf(page);
    const form = mountPage(page);
    const selected = Array.from(form.querySelectorAll('select[name="facility_type"] option[selected]'), (o) => o.value);
    const expected = key in FACILITY_DEFAULT ? [FACILITY_DEFAULT[key]] : [];
    expect(selected).toEqual(expected);
  });

  it.each(LANDING_PAGES)("%s uses the consultation CTA wording on heading and submit", (page) => {
    const key = keyOf(page);
    const form = mountPage(page);
    expect(form.querySelector(".form-fields h3").textContent.trim()).toBe(CTA(key));
    expect(form.querySelector('.form-fields button[type="submit"]').textContent.trim()).toBe(CTA(key));
  });

  it.each(LANDING_PAGES)("%s keeps the construction value and labels it Warehouse / industrial", (page) => {
    const form = mountPage(page);
    const opt = form.querySelector('select[name="facility_type"] option[value="construction"]');
    expect(opt.textContent.trim()).toBe("Warehouse / industrial");
  });
});

// Every page carrying a data-conversion-page form (discovered, so a new page
// is covered automatically) must ask for the business name.
const CONVERSION_PAGES = readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html"))
  .filter((f) => /data-conversion-page=/.test(readFileSync(resolve(SITE_DIR, f), "utf8")));

describe.each(CONVERSION_PAGES)("%s conversion form business name", (page) => {
  it("has a required company_name input with autocomplete=organization", () => {
    mountPage(page);
    const form = document.querySelector("form[data-conversion-page]");
    const field = form.querySelector('[name="company_name"]');
    expect(field).not.toBeNull();
    expect(field.required).toBe(true);
    expect(field.getAttribute("autocomplete")).toBe("organization");
  });
});

describe("contact.html approved booking wording", () => {
  it("states instant SMS/email confirmation in the intro and step 1", () => {
    mountPage("contact.html");
    const text = document.body.textContent.replace(/\s+/g, " ");
    expect(text).toContain("Send the form below and pick a walkthrough time that suits you \u2014 your booking is confirmed instantly by SMS and email.");
    expect(text).toContain("You pick a walkthrough time online, confirmed by SMS and email");
    expect(text).not.toContain("within one business day");
    expect(text).not.toContain("We call to confirm a walkthrough time");
  });
});

// Every sales-form page (not the career/subcontractor interview flows) shares
// the approved no-calendar fallback copy, including pages without a landing marker.
const NO_CALENDAR_PAGES = readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html") && !["career.html", "subcontractor.html"].includes(f))
  .filter((f) => /id="no-calendar-message"/.test(readFileSync(resolve(SITE_DIR, f), "utf8")));

describe.each(NO_CALENDAR_PAGES)("%s no-calendar fallback", (page) => {
  it("uses the approved body text and the dead 'Request received' panel is gone", () => {
    mountPage(page);
    const msg = document.querySelector("#no-calendar-message");
    expect(msg.querySelector("p").textContent.trim()).toBe(
      "We couldn’t load walkthrough times just now. One of the team will call you shortly to book one in — free, no obligation."
    );
    // The only legitimate "Request received" is locations.html's JS-revealed area-request panel.
    const dead = [...document.querySelectorAll(".form-success")].filter(
      (el) => el.textContent.includes("Request received") && !el.closest("form[data-area-request]")
    );
    expect(dead).toHaveLength(0);
    expect(document.body.textContent).not.toContain("arrange your walkthrough");
  });
});
