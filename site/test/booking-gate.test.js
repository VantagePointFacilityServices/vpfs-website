import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
      <dialog class="booking-dialog" aria-label="Book your walkthrough">
      <button type="button" class="booking-dialog-close" aria-label="Close">x</button>
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
          <label><input type="radio" name="cleaning_frequency" value="three_days_week" checked>3 days a week</label>
          <label><input type="radio" name="cleaning_frequency" value="five_days_week">5 days a week</label>
          <label><input type="radio" name="cleaning_frequency" value="weekly">Weekly</label>
          <label><input type="radio" name="cleaning_frequency" value="fortnightly">Fortnightly</label>
          <button type="button" class="step2-submit">See availability</button>
        </div>
        <div class="booking-result">
          <div id="walkthrough-picker">
            <span class="picker-week-label"></span>
            <button type="button" class="picker-prev-week">Prev</button>
            <button type="button" class="picker-next-week">Next</button>
            <div class="picker-days" role="radiogroup"></div>
            <div class="picker-times" role="radiogroup"></div>
            <div class="booking-error"></div>
            <button type="button" class="picker-book" disabled>Book</button>
          </div>
          <div id="booking-confirmed"></div>
          <div id="no-calendar-message"></div>
          <div id="budget-nurture-message"></div>
        </div>
      </div>
      </dialog>
      <div class="booking-resume">
        <button type="button" class="booking-resume-btn">Continue booking</button>
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
  // jsdom doesn't implement <dialog>'s showModal()/close(); mimic the browser.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

  it("includes utm params from the page URL in the /lead payload", async () => {
    window.history.replaceState(null, "", "/?utm_source=google&utm_campaign=office-gc");
    const form = mountHomepageForm();
    global.fetch = mockLeadOk("contact-789");
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.utm_source).toBe("google");
    expect(body.utm_campaign).toBe("office-gc");
    expect(body).not.toHaveProperty("utm_medium");

    window.history.replaceState(null, "", "/");
    window.sessionStorage.clear();
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

const SLOTS = {
  timezone: "Australia/Brisbane",
  window_days: 30,
  days: [
    { date: "2026-03-04", slots: ["2026-03-04T09:00:00+10:00", "2026-03-04T13:30:00+10:00"] },
    { date: "2026-03-06", slots: ["2026-03-06T10:00:00+10:00"] },
    { date: "2026-03-12", slots: ["2026-03-12T10:00:00+10:00"] },
  ],
};

function respond(body, ok = true) {
  return { ok, status: ok ? 200 : 502, json: () => Promise.resolve(body) };
}

// /gate answers first; the next call (/slots) answers `slots` (or fails).
function mockGateOk(tier, dqFlag, { slots = SLOTS, slotsFail = false, token = "tok-1" } = {}) {
  const gate = { tier: tier, dq_flag: dqFlag || (tier === "nurture" ? "nurture-budget" : "none") };
  if (tier !== "nurture" && token) gate.booking_token = token;
  const fn = vi.fn();
  fn.mockResolvedValueOnce(respond(gate));
  if (slotsFail) fn.mockRejectedValue(new Error("down"));
  else fn.mockResolvedValue(respond(slots));
  return fn;
}

async function submitStep2(form, step2, fetchMock) {
  step2.dataset.contactId = "contact-abc";
  initBookingGate(form);
  global.fetch = fetchMock;
  step2.querySelector(".step2-submit").click();
  await flush();
  await flush();
}

describe("Step 2 overlay", () => {
  it("opens Step 2 in a modal dialog once Step 1 succeeds", async () => {
    const form = mountHomepageForm();
    const dialog = form.querySelector(".booking-dialog");
    const showModal = vi.spyOn(dialog, "showModal");
    global.fetch = mockLeadOk("contact-123");
    initBookingGate(form);

    expect(dialog.hasAttribute("open")).toBe(false);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.contains(form.querySelector(".booking-step-2-questions"))).toBe(true);
  });

  it("does not open the dialog when Step 1 fails", async () => {
    const form = mountHomepageForm();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(form.querySelector(".booking-dialog").hasAttribute("open")).toBe(false);
  });

  it("closes from the close button and offers a way back in", async () => {
    const form = mountHomepageForm();
    const dialog = form.querySelector(".booking-dialog");
    global.fetch = mockLeadOk("contact-123");
    initBookingGate(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    const resume = form.querySelector(".booking-resume");
    expect(resume.classList.contains("show")).toBe(false);

    form.querySelector(".booking-dialog-close").click();
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(resume.classList.contains("show")).toBe(true);

    form.querySelector(".booking-resume-btn").click();
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(resume.classList.contains("show")).toBe(false);
  });

  it("shows the way back in after an Esc-key close too", async () => {
    const form = mountHomepageForm();
    const dialog = form.querySelector(".booking-dialog");
    global.fetch = mockLeadOk("contact-123");
    initBookingGate(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    dialog.close(); // what the browser does on Esc / back gesture
    expect(form.querySelector(".booking-resume").classList.contains("show")).toBe(true);
  });

  it("keeps the picker inside the open dialog and moves focus to it", async () => {
    const form = mountHomepageForm();
    const dialog = form.querySelector(".booking-dialog");
    const step2 = form.querySelector(".booking-step-2");
    global.fetch = mockLeadOk("contact-123");
    initBookingGate(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    global.fetch = mockGateOk("priority");
    step2.querySelector(".step2-submit").click();
    await flush();
    await flush();

    const priority = dialog.querySelector("#walkthrough-picker");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(priority.classList.contains("show")).toBe(true);
    expect(document.activeElement).toBe(priority);
  });

  it("still works on a form without a dialog", async () => {
    const form = mountContactPageForm();
    global.fetch = mockLeadOk("contact-456");
    initBookingGate(form);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(form.querySelector(".booking-step-2").classList.contains("show")).toBe(true);
  });
});

describe("Step 2 submit", () => {
  it("posts contact_id + DQ fields to /gate", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("/gate");
    const body = JSON.parse(options.body);
    expect(body.contact_id).toBe("contact-abc");
    expect(body.customFields.facility_type).toBe("office");
    expect(body.customFields.postcode).toBe("4211");
    expect(body.customFields.monthly_budget).toBe("3000");
    expect(body.customFields.cleaning_frequency).toBe("three_days_week");
  });

  it.each(["priority", "standard", "standard-flagged"])(
    "posts the booking_token to /slots and draws the picker on a %s tier",
    async (tier) => {
      const form = mountHomepageForm();
      const step2 = form.querySelector(".booking-step-2");
      await submitStep2(form, step2, mockGateOk(tier));

      expect(global.fetch).toHaveBeenCalledTimes(2);
      const [url, options] = global.fetch.mock.calls[1];
      expect(url).toContain("/slots");
      expect(JSON.parse(options.body)).toEqual({ booking_token: "tok-1" });
      expect(step2.dataset.bookingToken).toBe("tok-1");

      const picker = step2.querySelector("#walkthrough-picker");
      expect(step2.querySelector(".booking-result").classList.contains("show")).toBe(true);
      expect(picker.classList.contains("show")).toBe(true);
      expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(false);
      expect(step2.querySelector(".booking-step-2-questions").classList.contains("hide-after-step2")).toBe(true);
      expect(document.activeElement).toBe(picker);
    }
  );

  it("draws the first open week, disabling days with no times", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));

    const days = Array.from(step2.querySelectorAll(".picker-day"));
    expect(days.map((d) => d.dataset.date)).toEqual([
      "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08",
    ]);
    expect(days.filter((d) => !d.disabled).map((d) => d.dataset.date)).toEqual(["2026-03-04", "2026-03-06"]);
    expect(step2.querySelector(".picker-week-label").textContent).toMatch(/2 Mar.*8 Mar/);
    expect(step2.querySelector(".picker-book").disabled).toBe(true);
  });

  it("lists a chosen day's times in Brisbane time and marks a chosen time selected", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));

    step2.querySelector('.picker-day[data-date="2026-03-04"]').click();
    const day = step2.querySelector('.picker-day[data-date="2026-03-04"]');
    expect(day.getAttribute("aria-checked")).toBe("true");
    const times = Array.from(step2.querySelectorAll(".picker-time"));
    expect(times.map((t) => t.textContent.replace(/\s/g, " ").toLowerCase())).toEqual(["9:00 am", "1:30 pm"]);

    times[1].click();
    const chosen = step2.querySelectorAll('.picker-time[aria-checked="true"]');
    expect(chosen.length).toBe(1);
    expect(chosen[0].dataset.start).toBe("2026-03-04T13:30:00+10:00");
    expect(step2.querySelector("#walkthrough-picker").dataset.startTime).toBe("2026-03-04T13:30:00+10:00");
  });

  it("pages a week at a time and disables Previous/Next at the limits", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));
    const prev = step2.querySelector(".picker-prev-week");
    const next = step2.querySelector(".picker-next-week");
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    next.click();
    expect(step2.querySelector(".picker-week-label").textContent).toMatch(/9 Mar.*15 Mar/);
    const days = Array.from(step2.querySelectorAll(".picker-day"));
    expect(days.filter((d) => !d.disabled).map((d) => d.dataset.date)).toEqual(["2026-03-12"]);
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);

    prev.click();
    expect(step2.querySelector(".picker-week-label").textContent).toMatch(/2 Mar.*8 Mar/);
    expect(prev.disabled).toBe(true);
  });

  it("clears a choice that is no longer shown when the week changes", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));
    step2.querySelector('.picker-day[data-date="2026-03-04"]').click();
    step2.querySelector(".picker-time").click();
    const book = step2.querySelector(".picker-book");
    expect(book.disabled).toBe(false);

    step2.querySelector(".picker-next-week").click();
    const picker = step2.querySelector("#walkthrough-picker");
    expect(picker.dataset.date).toBe("");
    expect(picker.dataset.startTime).toBe("");
    expect(step2.querySelectorAll(".picker-time").length).toBe(0);
    expect(book.disabled).toBe(true);
  });

  it("moves focus and selection between enabled days with the keyboard", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));
    const press = (key) => {
      const el = document.activeElement.classList.contains("picker-day")
        ? document.activeElement
        : step2.querySelector(".picker-day[tabindex='0']");
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    const tabbable = () => Array.from(step2.querySelectorAll(".picker-day")).filter((d) => d.tabIndex === 0);
    expect(tabbable().map((d) => d.dataset.date)).toEqual(["2026-03-04"]);

    press("ArrowRight");
    expect(document.activeElement.dataset.date).toBe("2026-03-06");
    expect(document.activeElement.getAttribute("aria-checked")).toBe("true");
    expect(tabbable().map((d) => d.dataset.date)).toEqual(["2026-03-06"]);
    press("ArrowLeft");
    expect(document.activeElement.dataset.date).toBe("2026-03-04");
    press("End");
    expect(document.activeElement.dataset.date).toBe("2026-03-06");
    press("Home");
    expect(document.activeElement.dataset.date).toBe("2026-03-04");
  });

  it("keeps focus on a day chosen with Space/Enter", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));
    const day = step2.querySelector('.picker-day[data-date="2026-03-06"]');
    day.focus();
    day.click(); // Space/Enter on a button fires click

    expect(document.activeElement.classList.contains("picker-day")).toBe(true);
    expect(document.activeElement.dataset.date).toBe("2026-03-06");
  });

  it("moves focus to the other week button when Next or Previous disables itself", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));
    const prev = step2.querySelector(".picker-prev-week");
    const next = step2.querySelector(".picker-next-week");

    next.focus();
    next.click(); // last week of the window — Next disables
    expect(next.disabled).toBe(true);
    expect(document.activeElement).toBe(prev);

    prev.click(); // first week — Previous disables
    expect(prev.disabled).toBe(true);
    expect(document.activeElement).toBe(next);
  });

  it("keeps the picker state when the dialog is closed and reopened", async () => {
    const form = mountHomepageForm();
    const dialog = form.querySelector(".booking-dialog");
    const step2 = form.querySelector(".booking-step-2");
    global.fetch = mockLeadOk("contact-123");
    initBookingGate(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    global.fetch = mockGateOk("priority");
    step2.querySelector(".step2-submit").click();
    await flush();
    await flush();
    step2.querySelector('.picker-day[data-date="2026-03-06"]').click();
    step2.querySelector(".picker-time").click();

    dialog.close();
    form.querySelector(".booking-resume-btn").click();

    expect(dialog.hasAttribute("open")).toBe(true);
    expect(step2.querySelector("#walkthrough-picker").classList.contains("show")).toBe(true);
    expect(step2.querySelector('.picker-time[aria-checked="true"]').dataset.start).toBe("2026-03-06T10:00:00+10:00");
  });

  it.each([
    ["no token", { token: "" }],
    ["a /slots failure", { slotsFail: true }],
    ["zero open days", { slots: { timezone: "Australia/Brisbane", window_days: 30, days: [] } }],
  ])("shows the no-calendar message and hides the picker on %s", async (_label, opts) => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority", undefined, opts));

    expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(true);
    expect(step2.querySelector("#walkthrough-picker").classList.contains("show")).toBe(false);
    expect(document.activeElement).toBe(step2.querySelector("#no-calendar-message"));
  });

  it("reveals the budget message on a budget nurture — no picker is ever shown", async () => {
    const form = mountHomepageForm();
    const step2 = form.querySelector(".booking-step-2");
    step2.dataset.contactId = "contact-abc";
    initBookingGate(form);

    global.fetch = mockGateOk("nurture", "nurture-budget");
    step2.querySelector(".step2-submit").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(step2.querySelector("#budget-nurture-message").classList.contains("show")).toBe(true);
    expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(false);
    expect(step2.querySelector("#walkthrough-picker").classList.contains("show")).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["nurture-frequency", "nurture-capability-gap", "nurture-out-of-area"])(
    "reveals the general no-calendar message on a %s nurture, not the budget one",
    async (dqFlag) => {
      const form = mountHomepageForm();
      const step2 = form.querySelector(".booking-step-2");
      step2.dataset.contactId = "contact-abc";
      initBookingGate(form);

      global.fetch = mockGateOk("nurture", dqFlag);
      step2.querySelector(".step2-submit").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(true);
      expect(step2.querySelector("#budget-nurture-message").classList.contains("show")).toBe(false);
    }
  );

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

describe("Turnstile bot check", () => {
  function addWidget(form, sitekey = "site-key-1") {
    const el = document.createElement("div");
    el.className = "turnstile-widget";
    el.dataset.sitekey = sitekey;
    form.querySelector(".form-fields").insertBefore(el, form.querySelector('button[type="submit"]'));
    return el;
  }

  function mockTurnstile(token) {
    window.turnstile = {
      render: vi.fn(() => "widget-1"),
      getResponse: vi.fn(() => token),
      reset: vi.fn(),
    };
    return window.turnstile;
  }

  function submit(form) {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  afterEach(() => {
    delete window.turnstile;
  });

  it("renders the widget with the page's site key", () => {
    const form = mountHomepageForm();
    const el = addWidget(form);
    const ts = mockTurnstile("tok");
    initBookingGate(form);

    expect(ts.render).toHaveBeenCalledWith(el, expect.objectContaining({ sitekey: "site-key-1", action: "lead" }));
  });

  it("sends the token to /lead", async () => {
    const form = mountHomepageForm();
    addWidget(form);
    mockTurnstile("tok-abc");
    global.fetch = mockLeadOk("contact-1");
    initBookingGate(form);

    submit(form);
    await flush();

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.turnstile_token).toBe("tok-abc");
  });

  it("holds the submit and explains why while the check hasn't finished", async () => {
    const form = mountHomepageForm();
    addWidget(form);
    mockTurnstile("");
    global.fetch = vi.fn();
    initBookingGate(form);

    submit(form);
    await flush();

    expect(global.fetch).not.toHaveBeenCalled();
    const errorBox = form.querySelector(".form-fields .booking-error");
    expect(errorBox.classList.contains("show")).toBe(true);
    expect(errorBox.textContent).toMatch(/moment/i);
  });

  it("gets a fresh token after a failed submit, since each token works once", async () => {
    const form = mountHomepageForm();
    addWidget(form);
    const ts = mockTurnstile("tok");
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) });
    initBookingGate(form);

    submit(form);
    await flush();

    expect(ts.reset).toHaveBeenCalledWith("widget-1");
  });

  it("does nothing Turnstile-related when no site key is set", async () => {
    const form = mountHomepageForm();
    addWidget(form, "");
    const ts = mockTurnstile("tok");
    global.fetch = mockLeadOk("contact-1");
    initBookingGate(form);

    submit(form);
    await flush();

    expect(ts.render).not.toHaveBeenCalled();
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.turnstile_token).toBe("");
  });

  it("still submits when the Turnstile script failed to load", async () => {
    const form = mountHomepageForm();
    addWidget(form);
    global.fetch = mockLeadOk("contact-1");
    initBookingGate(form);

    submit(form);
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Book walkthrough", () => {
  let form, step2, picker, book;
  const err = (status, body) => ({ ok: false, status, json: () => Promise.resolve(body) });

  async function openPicker() {
    form = mountHomepageForm();
    step2 = form.querySelector(".booking-step-2");
    await submitStep2(form, step2, mockGateOk("priority"));
    picker = step2.querySelector("#walkthrough-picker");
    book = picker.querySelector(".picker-book");
  }
  function choose(date, start) {
    step2.querySelector(`.picker-day[data-date="${date}"]`).click();
    step2.querySelector(`.picker-time[data-start="${start}"]`).click();
  }
  const T = "2026-03-04T13:30:00+10:00";

  it("disables Book until a time is chosen, then labels it with day and time", async () => {
    await openPicker();
    expect(book.disabled).toBe(true);
    step2.querySelector('.picker-day[data-date="2026-03-04"]').click();
    expect(book.disabled).toBe(true);
    step2.querySelector(`.picker-time[data-start="${T}"]`).click();
    expect(book.disabled).toBe(false);
    expect(book.textContent).toMatch(/^Book Wed,? 4 Mar,? 1:30\s?pm$/i);
  });

  it("posts token and start_time once, even on a double click, then shows the confirmation", async () => {
    await openPicker();
    choose("2026-03-04", T);
    const fn = vi.fn().mockResolvedValue(respond({ booked: true, start_time: T, end_time: "x" }));
    global.fetch = fn;
    book.click();
    book.click();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, opts] = fn.mock.calls[0];
    expect(url).toMatch(/\/book$/);
    expect(JSON.parse(opts.body)).toEqual({ booking_token: "tok-1", start_time: T });
    const confirmed = step2.querySelector("#booking-confirmed");
    expect(confirmed.classList.contains("show")).toBe(true);
    expect(confirmed.textContent).toMatch(/You.re booked for .*4 Mar.*1:30.*confirmation by SMS and email/i);
    expect(picker.classList.contains("show")).toBe(false);
    expect(document.activeElement).toBe(confirmed);
  });

  it("slot_unavailable shows a message, re-fetches /slots and stays on the day", async () => {
    await openPicker();
    choose("2026-03-04", T);
    const fn = vi.fn()
      .mockResolvedValueOnce(err(409, { error: "slot_unavailable" }))
      .mockResolvedValueOnce(respond({ timezone: "Australia/Brisbane", days: [{ date: "2026-03-04", slots: ["2026-03-04T09:00:00+10:00"] }] }));
    global.fetch = fn;
    book.click();
    await flush();
    expect(fn.mock.calls[1][0]).toMatch(/\/slots$/);
    expect(picker.querySelector(".booking-error").textContent).toMatch(/just taken/);
    expect(picker.dataset.date).toBe("2026-03-04");
    expect(picker.dataset.startTime).toBe("");
    expect(picker.querySelectorAll(".picker-time").length).toBe(1);
    expect(book.disabled).toBe(true);
    // Book is disabled again, so focus moves to the day row's tab stop.
    expect(document.activeElement.classList.contains("picker-day")).toBe(true);
    expect(document.activeElement.dataset.date).toBe("2026-03-04");
  });

  it("slot_unavailable moves off the day when it has no times left", async () => {
    await openPicker();
    choose("2026-03-04", T);
    global.fetch = vi.fn()
      .mockResolvedValueOnce(err(409, { error: "slot_unavailable" }))
      .mockResolvedValueOnce(respond({ days: [{ date: "2026-03-06", slots: ["2026-03-06T10:00:00+10:00"] }] }));
    book.click();
    await flush();
    expect(picker.dataset.date).toBe("");
    expect(picker.querySelectorAll(".picker-time").length).toBe(0);
  });

  it("slot_unavailable with the re-fetch failing still shows the message; no days left shows no-calendar", async () => {
    await openPicker();
    choose("2026-03-04", T);
    global.fetch = vi.fn()
      .mockResolvedValueOnce(err(409, { error: "slot_unavailable" }))
      .mockRejectedValueOnce(new Error("down"));
    book.click();
    await flush();
    expect(picker.querySelector(".booking-error").textContent).toMatch(/just taken/);

    await openPicker();
    choose("2026-03-04", T);
    global.fetch = vi.fn()
      .mockResolvedValueOnce(err(409, { error: "slot_unavailable" }))
      .mockResolvedValueOnce(respond({ days: [] }));
    book.click();
    await flush();
    expect(step2.querySelector("#no-calendar-message").classList.contains("show")).toBe(true);
  });

  it("already_booked shows the confirmation panel with the existing time", async () => {
    await openPicker();
    choose("2026-03-04", T);
    global.fetch = vi.fn().mockResolvedValue(err(409, { error: "already_booked", start_time: "2026-03-10T09:00:00+10:00" }));
    book.click();
    await flush();
    const confirmed = step2.querySelector("#booking-confirmed");
    expect(confirmed.textContent).toMatch(/You already have a walkthrough booked for .*10 Mar.*9:00/i);
    expect(document.activeElement).toBe(confirmed);
  });

  it("a generic error keeps the choice and lets the visitor retry", async () => {
    await openPicker();
    choose("2026-03-04", T);
    global.fetch = vi.fn().mockResolvedValueOnce(err(502, { error: "booking_failed" }));
    book.click();
    await flush();
    expect(picker.querySelector(".booking-error").textContent).toMatch(/went wrong/);
    expect(picker.dataset.startTime).toBe(T);
    expect(book.disabled).toBe(false);
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("net"));
    book.click();
    await flush();
    expect(picker.querySelector(".booking-error").textContent).toMatch(/went wrong/);
    expect(book.disabled).toBe(false);
  });

  it("does nothing when clicked with no time chosen", async () => {
    await openPicker();
    global.fetch = vi.fn();
    book.disabled = false;
    book.click();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
