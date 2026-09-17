import { describe, it, expect, beforeEach, vi } from "vitest";
import { initBookingGate } from "../assets/js/booking-gate.js";

function mountHomepageForm() {
  document.body.innerHTML = `
    <form class="assessment-form" data-channel="website-homepage">
      <div class="form-fields">
        <div class="booking-error" role="alert"></div>
        <input name="first_name" value="Alex">
        <input name="last_name" value="Rowe">
        <input name="email" value="alex@example.com">
        <input name="phone" value="0400000000">
        <input name="postcode" value="4211">
        <input name="url" value="">
        <button type="submit">Start Walkthrough Booking</button>
      </div>
      <div class="booking-step-2">
        <div class="booking-step-2-questions">
          <div class="booking-error" role="alert"></div>
          <select name="facility_type">
            <option value="">Select</option>
            <option value="office" selected>Office</option>
            <option value="strata">Strata</option>
            <option value="education">Education</option>
            <option value="medical">Medical</option>
            <option value="construction">Construction</option>
          </select>
          <input name="monthly_budget" value="3000">
          <label><input type="radio" name="cleaning_frequency" value="daily">Daily</label>
          <label><input type="radio" name="cleaning_frequency" value="few_times_week" checked>Few times a week</label>
          <label><input type="radio" name="cleaning_frequency" value="weekly">Weekly</label>
          <label><input type="radio" name="cleaning_frequency" value="fortnightly">Fortnightly</label>
          <button type="button" class="step2-submit">See availability</button>
        </div>
        <div class="booking-result">
          <div id="calendar-priority"></div>
          <div id="calendar-standard"></div>
          <div id="no-calendar-message"></div>
        </div>
      </div>
    </form>
  `;
  return document.querySelector(".assessment-form");
}

function mountContactPageForm() {
  document.body.innerHTML = `
    <form class="assessment-form" data-channel="website-contact">
      <div class="form-fields">
        <div class="booking-error" role="alert"></div>
        <input name="first_name" value="Jamie">
        <input name="last_name" value="Lee">
        <input name="email" value="jamie@example.com">
        <input name="phone" value="0411111111">
        <input name="postcode" value="4215">
        <input name="url" value="">
        <button type="submit">Send request</button>
      </div>
      <div class="booking-step-2"></div>
    </form>
  `;
  return document.querySelector(".assessment-form");
}

function mockLeadOk(contactId) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ contact_id: contactId }),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Step 1 submit", () => {
  it("posts to /lead and reveals Step 2 with the returned contact_id", async () => {
    const form = mountHomepageForm();
    global.fetch = mockLeadOk("contact-123");
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("/lead");
    const body = JSON.parse(options.body);
    expect(body.first_name).toBe("Alex");
    expect(body.last_name).toBe("Rowe");
    expect(body.email).toBe("alex@example.com");
    expect(body.phone).toBe("0400000000");
    expect(body.postcode).toBe("4211");
    expect(body.channel).toBe("website-homepage");

    const step2 = form.querySelector(".booking-step-2");
    expect(step2.classList.contains("show")).toBe(true);
    expect(step2.dataset.contactId).toBe("contact-123");

    // Step 1's own fields hide once Step 2 is revealed — otherwise both
    // steps would be visible stacked on the page at once.
    expect(form.querySelector(".form-fields").classList.contains("hide-after-step1")).toBe(true);
  });

  it("posts contact.html's fields to /lead tagged with its own channel", async () => {
    const form = mountContactPageForm();
    global.fetch = mockLeadOk("contact-456");
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.first_name).toBe("Jamie");
    expect(body.last_name).toBe("Lee");
    expect(body.postcode).toBe("4215");
    expect(body.channel).toBe("website-contact");
  });

  it("shows a retry-capable error and preserves entered values on a failed request", async () => {
    const form = mountHomepageForm();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const errorBox = form.querySelector(".booking-error");
    expect(errorBox.classList.contains("show")).toBe(true);
    expect(errorBox.textContent.length).toBeGreaterThan(0);

    // Entered values are untouched — nothing was cleared on failure.
    expect(form.querySelector('[name="first_name"]').value).toBe("Alex");
    expect(form.querySelector('[name="email"]').value).toBe("alex@example.com");

    // Step 2 never reveals on a failed Step 1 submit.
    expect(form.querySelector(".booking-step-2").classList.contains("show")).toBe(false);

    // Submit button is re-enabled so the visitor can retry.
    expect(form.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  it("disables the submit button while the request is in flight and ignores a duplicate click", async () => {
    const form = mountHomepageForm();
    let resolveFetch;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );
    initBookingGate(form);

    const submitBtn = form.querySelector('button[type="submit"]');
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitBtn.disabled).toBe(true);

    // A second submit while in flight must not fire a second request.
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: () => Promise.resolve({ contact_id: "c-1" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitBtn.disabled).toBe(false);
  });

  it("includes the honeypot field value in the /lead payload", async () => {
    const form = mountHomepageForm();
    form.querySelector('[name="url"]').value = "http://spam.example.com";
    global.fetch = mockLeadOk("contact-789");
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.url).toBe("http://spam.example.com");
  });
});

function mockGateOk(tier) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ tier: tier, dq_flag: tier === "nurture" ? "nurture-budget" : "none" }),
  });
}

describe("Step 2 submit", () => {
  it("posts contact_id + DQ fields to /gate and reveals the Priority calendar on a priority tier", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    global.fetch = mockGateOk("priority");
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("/gate");
    const body = JSON.parse(options.body);
    expect(body.contact_id).toBe("contact-abc");
    expect(body.customFields.facility_type).toBe("office");
    expect(body.customFields.postcode).toBe("4211");
    expect(body.customFields.monthly_budget).toBe("3000");
    expect(body.customFields.cleaning_frequency).toBe("few_times_week");

    expect(step2.querySelector(".booking-result").classList.contains("show")).toBe(true);
    expect(step2.querySelector("#calendar-priority").classList.contains("show")).toBe(true);
    expect(step2.querySelector("#calendar-standard").classList.contains("show")).toBe(false);
    expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(false);
    expect(step2.querySelector(".booking-step-2-questions").classList.contains("hide-after-step2")).toBe(true);
  });

  it("reveals the Standard calendar on a standard tier", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    global.fetch = mockGateOk("standard");
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(step2.querySelector("#calendar-standard").classList.contains("show")).toBe(true);
    expect(step2.querySelector("#calendar-priority").classList.contains("show")).toBe(false);
    expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(false);
  });

  it("reveals the Standard calendar on a standard-flagged tier", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    global.fetch = mockGateOk("standard-flagged");
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(step2.querySelector("#calendar-standard").classList.contains("show")).toBe(true);
  });

  it("reveals the no-calendar message on a nurture tier — no calendar is ever shown", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    global.fetch = mockGateOk("nurture");
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(true);
    expect(step2.querySelector("#calendar-priority").classList.contains("show")).toBe(false);
    expect(step2.querySelector("#calendar-standard").classList.contains("show")).toBe(false);
  });

  it("shows a retry-capable error and preserves entered values on a failed /gate request", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const errorBox = step2.querySelector(".booking-step-2-questions .booking-error");
    expect(errorBox.classList.contains("show")).toBe(true);

    // No result panel is shown, entered values untouched, retry is possible.
    expect(step2.querySelector(".booking-result").classList.contains("show")).toBe(false);
    expect(form.querySelector('[name="postcode"]').value).toBe("4211");
    expect(step2.querySelector(".step2-submit").disabled).toBe(false);
  });

  it("disables the Step 2 submit button while the request is in flight", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    let resolveFetch;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const submitBtn = step2.querySelector(".step2-submit");
    submitBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitBtn.disabled).toBe(true);

    submitBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    resolveFetch({ ok: true, json: () => Promise.resolve({ tier: "standard" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(submitBtn.disabled).toBe(false);
  });

  it("blocks submit and shows an error when a required DQ field is missing, without calling /gate", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    form.querySelector('[name="postcode"]').value = ""; // required field left blank
    initBookingGate(form);

    global.fetch = vi.fn();
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(global.fetch).not.toHaveBeenCalled();
    const errorBox = step2.querySelector(".booking-step-2-questions .booking-error");
    expect(errorBox.classList.contains("show")).toBe(true);
  });
});
