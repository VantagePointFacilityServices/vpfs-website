import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initApply } from "../assets/js/apply.js";

const URL0 = "https://api.leadconnectorhq.com/widget/survey/abc";
const ANSWERS = ["cleaning_experience", "residential_experience", "right_to_work", "police_check_status",
  "availability", "reliable_transport"];
const T = "2026-03-04T13:30:00+10:00";
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const flush = () => new Promise((r) => setTimeout(r, 0));

function mount(surveyUrl) {
  document.body.innerHTML = `
    <form data-apply data-engagement-track="employee" ${surveyUrl === null ? "" : `data-enrich-survey-url="${surveyUrl}"`}>
      <div class="form-fields"><div class="booking-error"></div>
        <input name="email" value="sam+x@example.com"><input name="phone" value="0400 000 000">
        <input name="postcode" value="4211"><input name="first_name" value="S"><button type="submit">Go</button></div>
      <dialog class="booking-dialog">
        <div class="booking-step-2"><div class="booking-step-2-questions"><div class="booking-error"></div>
          ${ANSWERS.map((n) => `<input name="${n}" value="x">`).join("")}<button type="button" class="step2-submit">Next</button></div>
          <div class="booking-result">
            <div id="no-calendar-message"></div><div id="shortlist-message"></div>
            <div id="unsuccessful-message"></div><div id="unsuccessful-no-abn-message"></div>
            <div id="walkthrough-picker"><span class="picker-week-label"></span>
              <button type="button" class="picker-prev-week"></button><button type="button" class="picker-next-week"></button>
              <div class="picker-days"></div><div class="picker-times"></div><div class="booking-error"></div>
              <button type="button" class="picker-book" disabled>Book</button></div>
            <div id="booking-confirmed"></div></div></div>
      </dialog></form>`;
  const d = document.querySelector("dialog");
  d.showModal = vi.fn(() => d.setAttribute("open", ""));
  d.close = vi.fn(() => d.removeAttribute("open"));
  return document.querySelector("form");
}

async function run(surveyUrl, screen, { book } = {}) {
  vi.stubGlobal("fetch", vi.fn((url) => {
    if (url.endsWith("/apply")) return json({ contact_id: "c1" });
    if (url.endsWith("/apply-screen")) return json(screen);
    if (url.endsWith("/slots")) return json({ timezone: "Australia/Brisbane", days: [{ date: "2026-03-04", slots: [T] }] });
    return json({ booked: true, start_time: T });
  }));
  const form = mount(surveyUrl);
  initApply(form);
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(document.querySelector(".enrich-cta, iframe, script")).toBeNull();
  form.querySelector(".step2-submit").click();
  await flush(); await flush();
  if (book) {
    form.querySelector('.picker-day[data-date="2026-03-04"]').click();
    form.querySelector(`.picker-time[data-start="${T}"]`).click();
    form.querySelector(".picker-book").click();
    await flush();
  }
  return form;
}

const scripts = () => document.querySelectorAll('script[src*="form_embed.js"]');

describe("embedded experience survey", () => {
  afterEach(() => { vi.unstubAllGlobals(); document.head.innerHTML = ""; });

  it.each([
    ["shortlist", { result: "shortlist" }, "shortlist-message", false],
    ["no-calendar", { result: "book" }, "no-calendar-message", false],
    ["booking", { result: "book", booking_token: "tok" }, "booking-confirmed", true],
  ])("offers the survey for %s without loading it", async (_n, screen, id, book) => {
    const form = await run(URL0, screen, { book });
    const cta = form.querySelector(`#${id} .enrich-cta`);
    expect(cta).not.toBeNull();
    expect(cta.querySelectorAll("button").length).toBe(2);
    expect(form.querySelector("iframe")).toBeNull();
    expect(scripts().length).toBe(0);
  });

  it("opens the survey screen on 'Add your experience now'", async () => {
    const form = await run(URL0, { result: "book", booking_token: "tok" }, { book: true });
    const panel = form.querySelector("#booking-confirmed");
    panel.querySelector(".enrich-now").click();
    const frame = panel.querySelector("iframe");
    expect(frame.src).toBe(`${URL0}?email=sam%2Bx%40example.com&phone=0400%20000%20000`);
    expect(frame.title).toBeTruthy();
    expect(panel.querySelector(".enrich-cta").closest("[hidden]")).not.toBeNull();
    expect(panel.textContent).toMatch(/booked/i);
    // every node other than the survey screen (incl. bare text) is hidden
    Array.from(panel.childNodes).forEach((n) => {
      if (n.nodeType === 1 && n.classList.contains("enrich-screen")) return;
      expect(n.nodeType).toBe(1);
      expect(n.hidden).toBe(true);
    });
    const a = panel.querySelector("a.enrich-newtab");
    expect(a.getAttribute("href")).toBe(frame.src);
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener");
    expect(scripts().length).toBe(1);
  });

  it("moves focus to the survey screen's heading, since the pressed button is now hidden", async () => {
    const form = await run(URL0, { result: "book", booking_token: "tok" }, { book: true });
    const panel = form.querySelector("#booking-confirmed");
    const now = panel.querySelector(".enrich-now");
    now.focus();
    now.click();
    const heading = panel.querySelector(".enrich-screen h3");
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
  });

  it("closes the dialog on 'I'll do it later'", async () => {
    const form = await run(URL0, { result: "shortlist" });
    form.querySelector(".enrich-skip").click();
    expect(form.querySelector("dialog").close).toHaveBeenCalled();
    expect(form.querySelector("iframe")).toBeNull();
    expect(scripts().length).toBe(0);
  });

  it("loads the script once when two panels open the survey", async () => {
    const form = await run(URL0, { result: "shortlist" });
    form.querySelector("#shortlist-message .enrich-now").click();
    vi.stubGlobal("fetch", vi.fn(() => json({ result: "book" })));
    form.querySelector(".step2-submit").click();
    await flush(); await flush();
    form.querySelector("#no-calendar-message .enrich-now").click();
    expect(scripts().length).toBe(1);
  });

  it.each([["unsuccessful", {}], ["no-abn", { dq_flag: "unsuccessful-no-abn-redirect-careers" }]])(
    "never renders for %s", async (_n, extra) => {
      const form = await run(URL0, { result: "unsuccessful", ...extra });
      expect(form.querySelector(".enrich-cta")).toBeNull();
      expect(scripts().length).toBe(0);
    });

  it.each([[""], [null]])("renders nothing with an empty URL (%s)", async (u) => {
    const form = await run(u, { result: "shortlist" });
    expect(form.querySelector(".enrich-cta, iframe")).toBeNull();
    expect(scripts().length).toBe(0);
  });

  it("careers.html embeds the employee experience survey", () => {
    const html = readFileSync(resolve(__dirname, "..", "careers.html"), "utf8");
    expect(html).toMatch(
      /<form[^>]*data-apply[^>]*data-enrich-survey-url="https:\/\/api\.leadconnectorhq\.com\/widget\/survey\/6gOaBSjTzQ2jceJGvCbG"/
    );
  });

  it("subcontractor.html embeds the subcontractor experience survey", () => {
    const html = readFileSync(resolve(__dirname, "..", "subcontractor.html"), "utf8");
    expect(html).toMatch(
      /<form[^>]*data-apply[^>]*data-enrich-survey-url="https:\/\/api\.leadconnectorhq\.com\/widget\/survey\/IlXvQJyxOJH2JnmfqsmD"/
    );
  });
});
