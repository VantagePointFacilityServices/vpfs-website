import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTwoStepGate } from "../assets/js/two-step-gate.js";

function mount() {
  document.body.innerHTML = `
    <form class="assessment-form">
      <div class="form-fields">
        <div class="booking-error"></div>
        <input name="applicant_name" value="Sam">
        <button type="submit">Go</button>
      </div>
      <div class="booking-step-2">
        <div class="booking-step-2-questions">
          <div class="booking-error"></div>
          <input name="answer" value="yes">
          <button type="button" class="step2-submit">Next</button>
        </div>
        <div class="booking-result"><div id="custom-done"></div></div>
      </div>
    </form>`;
  return document.querySelector("form");
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("initTwoStepGate with a fake configuration", () => {
  let calls;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      const data = url.endsWith("/step-one") ? { contact_id: "c1" } : { ok: true };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the configured endpoints, payload builders and result handler", async () => {
    const form = mount();
    const handleStep2Result = vi.fn((data, ctx) => {
      ctx.setLoading(ctx.submitBtn, false);
      ctx.revealResult(ctx.step2, "#custom-done");
    });
    initTwoStepGate(form, {
      workerBase: "https://example.test",
      step1Endpoint: "/step-one",
      step2Endpoint: "/step-two",
      buildStep1Payload: (f, h) => ({ name: h.fieldGetter(f)("applicant_name") }),
      buildStep2Payload: (f, step2, h) => ({ id: step2.dataset.contactId, answer: h.fieldGetter(step2)("answer") }),
      isStep2Complete: (p) => Boolean(p.answer),
      handleStep2Result,
    });

    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(calls[0]).toEqual({ url: "https://example.test/step-one", body: { name: "Sam" } });
    expect(form.querySelector(".booking-step-2").dataset.contactId).toBe("c1");

    form.querySelector(".step2-submit").click();
    await flush();
    expect(calls[1]).toEqual({ url: "https://example.test/step-two", body: { id: "c1", answer: "yes" } });
    expect(handleStep2Result).toHaveBeenCalledOnce();
    expect(form.querySelector("#custom-done").classList.contains("show")).toBe(true);
  });

  it("shows the validation message and sends nothing when Step 2 is incomplete", async () => {
    const form = mount();
    initTwoStepGate(form, {
      workerBase: "https://example.test",
      step1Endpoint: "/step-one",
      step2Endpoint: "/step-two",
      buildStep1Payload: () => ({}),
      buildStep2Payload: () => ({}),
      isStep2Complete: () => false,
      handleStep2Result: vi.fn(),
      messages: { validation: "Fill it in." },
    });
    form.querySelector(".step2-submit").click();
    await flush();
    expect(calls).toHaveLength(0);
    expect(form.querySelector(".booking-step-2-questions .booking-error").textContent).toBe("Fill it in.");
  });
});
