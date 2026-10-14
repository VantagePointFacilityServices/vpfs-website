import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initApply } from "../assets/js/apply.js";

const ANSWERS = [
  ["cleaning_experience", "1_to_3_years"], ["residential_experience", "1_to_3_years"], ["right_to_work", "yes"], ["police_check_status", "current_check_held"],
  ["blue_card_status", "not_applicable"], ["availability", "flexible"], ["start_availability", "immediately"],
  ["reliable_transport", "yes"], ["physical_capability", "yes"], ["passion_rating", "take_pride"],
];
const SUB_ANSWERS = [["has_own_insurance_and_abn", "yes"], ["own_equipment", "yes"], ["works_for_other_clients", "no"]];

function mount(track = "employee") {
  document.body.innerHTML = `
    <form data-apply data-engagement-track="${track}">
      <div class="form-fields">
        <div class="booking-error" role="alert"></div>
        <input name="first_name" value="Sam">
        <input name="last_name" value="Lee">
        <input name="email" value="sam@example.com">
        <input name="phone" value="0400000000">
        <input name="postcode" value="4211">
        <input name="url" value="">
        <button type="submit">Apply</button>
      </div>
      <dialog class="booking-dialog">
        <div class="booking-step-2">
          <div class="booking-step-2-questions"><div class="booking-error"></div>
            ${ANSWERS.map(([n, v]) => `<input name="${n}" value="${v}">`).join("")}
            ${track === "subcontractor" ? SUB_ANSWERS.map(([n, v]) => `<input name="${n}" value="${v}">`).join("") : ""}
            <button type="button" class="step2-submit">Next</button></div>
          <div class="booking-result">
            <div id="no-calendar-message"></div><div id="shortlist-message"></div>
            <div id="unsuccessful-message"></div><div id="unsuccessful-no-abn-message"></div>
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
          </div>
        </div>
      </dialog>
    </form>`;
  const dialog = document.querySelector("dialog");
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  return document.querySelector("form");
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const submit = (form) => form.dispatchEvent(new Event("submit", { cancelable: true }));

describe("applicant Step 1 (apply.js)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts JSON with the track to /apply, hides the Step 1 fields and opens the dialog", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ contact_id: "c1" }) })
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = mount("subcontractor");
    initApply(form);

    submit(form);
    expect(form.querySelector('button[type="submit"]').disabled).toBe(true);
    await flush();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://worker.vantagepointfacilityservices.com.au/apply");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      first_name: "Sam",
      last_name: "Lee",
      email: "sam@example.com",
      phone: "0400000000",
      postcode: "4211",
      engagement_track: "subcontractor",
    });
    expect(form.querySelector(".form-fields").classList.contains("hide-after-step1")).toBe(true);
    expect(form.querySelector(".booking-step-2").dataset.contactId).toBe("c1");
    expect(document.querySelector("dialog").showModal).toHaveBeenCalled();
    expect(form.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  it.each([
    ["a network failure", () => Promise.reject(new Error("net"))],
    ["a non-OK response", () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })],
    ["a response without contact_id", () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })],
  ])("shows the error box, keeps Step 1 and re-enables the button on %s", async (_n, impl) => {
    vi.stubGlobal("fetch", vi.fn(impl));
    const form = mount();
    initApply(form);

    submit(form);
    await flush();

    expect(form.querySelector(".form-fields .booking-error").classList.contains("show")).toBe(true);
    expect(form.querySelector(".form-fields").classList.contains("hide-after-step1")).toBe(false);
    expect(document.querySelector("dialog").showModal).not.toHaveBeenCalled();
    expect(form.querySelector('button[type="submit"]').disabled).toBe(false);
  });

  it("ignores a second submit while the first is in flight", async () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const form = mount();
    initApply(form);

    submit(form);
    submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("applicant Step 2 (apply.js)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  // Runs Step 1 (contact c1) then clicks Step 2 with the given /apply-screen reply.
  async function runStep2(track, screenReply, { edit } = {}) {
    const fetchMock = vi.fn((url) =>
      url.endsWith("/apply") ? ok({ contact_id: "c1" })() : screenReply(url)
    );
    vi.stubGlobal("fetch", fetchMock);
    const form = mount(track);
    initApply(form);
    submit(form);
    await flush();
    if (edit) edit(form);
    form.querySelector(".step2-submit").click();
    await flush();
    return { form, fetchMock };
  }
  const shown = (form) => [...form.querySelectorAll(".booking-result > div.show")].map((e) => e.id);

  it("posts the employee answers with contact_id, track and the Step 1 postcode", async () => {
    const { fetchMock } = await runStep2("employee", ok({ result: "shortlist", tier: "standard" }));
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://worker.vantagepointfacilityservices.com.au/apply-screen");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      contact_id: "c1", engagement_track: "employee", postcode: "4211", cleaning_experience: "1_to_3_years",
      residential_experience: "1_to_3_years",
    });
    expect(body.own_equipment).toBeUndefined();
  });

  it("sends the subcontractor-only answers on that track", async () => {
    const { fetchMock } = await runStep2("subcontractor", ok({ result: "shortlist" }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      has_own_insurance_and_abn: "yes", own_equipment: "yes", works_for_other_clients: "no",
    });
  });

  it("shows the validation message and sends nothing when Step 2 is incomplete", async () => {
    const { form, fetchMock } = await runStep2("subcontractor", ok({}), {
      edit: (f) => { f.querySelector('[name="own_equipment"]').value = ""; },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const box = form.querySelector(".booking-step-2-questions .booking-error");
    expect(box.classList.contains("show")).toBe(true);
    expect(box.textContent).not.toBe("");
  });

  it.each(["employee", "subcontractor"])("is incomplete and sends nothing when residential_experience is missing (%s)", async (track) => {
    const { form, fetchMock } = await runStep2(track, ok({}), {
      edit: (f) => { f.querySelectorAll('[name="residential_experience"]').forEach((e) => { e.checked = false; e.value = ""; }); },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form.querySelector(".booking-step-2-questions .booking-error").classList.contains("show")).toBe(true);
  });

  it.each([
    ["shortlist", { result: "shortlist", dq_flag: "none" }, "shortlist-message"],
    ["unsuccessful", { result: "unsuccessful", dq_flag: "unsuccessful-out-of-area" }, "unsuccessful-message"],
    ["unsuccessful no-ABN", { result: "unsuccessful", dq_flag: "unsuccessful-no-abn-redirect-careers" }, "unsuccessful-no-abn-message"],
  ])("%s result shows only its panel", async (_n, reply, id) => {
    const { form } = await runStep2("subcontractor", ok(reply));
    expect(shown(form)).toEqual([id]);
    expect(form.querySelector(".step2-submit").disabled).toBe(false);
  });

  it("book result calls /slots with the token and falls back to no-calendar when it fails", async () => {
    const { form, fetchMock } = await runStep2("subcontractor", (url) =>
      url.endsWith("/slots")
        ? Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })
        : ok({ result: "book", booking_token: "tok" })()
    );
    const slotsCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/slots"));
    expect(JSON.parse(slotsCall[1].body)).toEqual({ booking_token: "tok" });
    expect(shown(form)).toEqual(["no-calendar-message"]);
  });

  it("book result without a token shows the no-calendar message", async () => {
    const { form } = await runStep2("employee", ok({ result: "book" }));
    expect(shown(form)).toEqual(["no-calendar-message"]);
  });

  it("shows the error and re-enables the button on a 400 or a malformed reply", async () => {
    for (const reply of [
      () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) }),
      ok({}),
    ]) {
      const { form } = await runStep2("employee", reply);
      expect(form.querySelector(".booking-step-2-questions .booking-error").classList.contains("show")).toBe(true);
      expect(form.querySelector(".step2-submit").disabled).toBe(false);
      expect(shown(form)).toEqual([]);
    }
  });
});

describe("applicant interview booking (apply.js)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const T = "2026-03-04T13:30:00+10:00";
  const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  // Step 1 -> Step 2 "book" -> /slots with one open time; returns the picker.
  async function openInterviewPicker(bookReply) {
    const fetchMock = vi.fn((url) => {
      if (url.endsWith("/apply")) return json({ contact_id: "c1" });
      if (url.endsWith("/apply-screen")) return json({ result: "book", booking_token: "tok" });
      if (url.endsWith("/slots")) return json({ timezone: "Australia/Brisbane", days: [{ date: "2026-03-04", slots: [T] }] });
      return bookReply();
    });
    vi.stubGlobal("fetch", fetchMock);
    const form = mount("subcontractor");
    initApply(form);
    submit(form);
    await flush();
    form.querySelector(".step2-submit").click();
    await flush();
    await flush();
    const step2 = form.querySelector(".booking-step-2");
    return { form, step2, fetchMock, book: step2.querySelector(".picker-book") };
  }

  it("labels the idle button for an interview, not a walkthrough", async () => {
    const { book } = await openInterviewPicker(() => json({}));
    expect(book.textContent).toBe("Book interview");
  });

  it("books with only the token and start time, then confirms the interview", async () => {
    const { step2, fetchMock, book } = await openInterviewPicker(() => json({ booked: true, start_time: T }));
    step2.querySelector('.picker-day[data-date="2026-03-04"]').click();
    step2.querySelector(`.picker-time[data-start="${T}"]`).click();
    book.click();
    await flush();
    const bookCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/book"));
    expect(JSON.parse(bookCall[1].body)).toEqual({ booking_token: "tok", start_time: T });
    const confirmed = step2.querySelector("#booking-confirmed");
    expect(confirmed.classList.contains("show")).toBe(true);
    expect(confirmed.textContent).toMatch(/booked for .*4 Mar.*1:30/i);
  });

  it("already_booked says interview, not walkthrough", async () => {
    const { step2, book } = await openInterviewPicker(() =>
      json({ error: "already_booked", start_time: "2026-03-10T09:00:00+10:00" }, 409)
    );
    step2.querySelector('.picker-day[data-date="2026-03-04"]').click();
    step2.querySelector(`.picker-time[data-start="${T}"]`).click();
    book.click();
    await flush();
    const text = step2.querySelector("#booking-confirmed").textContent;
    expect(text).toMatch(/You already have an interview booked for .*10 Mar/i);
    expect(text).not.toMatch(/walkthrough/i);
  });
});
