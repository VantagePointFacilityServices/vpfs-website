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
        <input name="url" value="">
        <button type="submit">Start Walkthrough Booking</button>
      </div>
      <div class="booking-step-2"></div>
    </form>
  `;
  return document.querySelector(".assessment-form");
}

function mountContactPageForm() {
  document.body.innerHTML = `
    <form class="assessment-form" data-channel="website-contact">
      <div class="form-fields">
        <div class="booking-error" role="alert"></div>
        <input name="contact_name" value="Jamie Lee">
        <input name="email" value="jamie@example.com">
        <input name="phone" value="0411111111">
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
    expect(body.channel).toBe("website-homepage");

    const step2 = form.querySelector(".booking-step-2");
    expect(step2.classList.contains("show")).toBe(true);
    expect(step2.dataset.contactId).toBe("contact-123");
  });

  it("splits contact.html's single contact_name field into first/last name", async () => {
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
