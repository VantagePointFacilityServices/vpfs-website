import { describe, it, expect, afterEach, vi } from "vitest";
import { initTwoStepGate } from "../assets/js/two-step-gate.js";

function q(name, n) {
  const opts = Array.from({ length: n }, (_, i) => `<label class="radio-option"><input type="radio" name="${name}" value="v${i}">Opt ${i}</label>`).join("");
  return `<fieldset class="step2-question"><legend>Question ${name}</legend><div class="radio-row">${opts}</div></fieldset>`;
}

function mount(stepper) {
  document.body.innerHTML = `
    <form>
      <div class="form-fields"><div class="booking-error"></div><input name="n" value="x"><button type="submit">Go</button></div>
      <dialog class="booking-dialog">
        <div class="booking-step-2">
          <div class="booking-step-2-questions"><div class="booking-error"></div>
            ${q("a", 2)}${q("b", 2)}${q("c", 2)}
            <button type="button" class="step2-submit">See my result</button>
          </div>
          <div class="booking-result"><div id="done"></div></div>
        </div>
      </dialog>
      <div class="booking-resume"><button type="button" class="booking-resume-btn">Continue application</button></div>
    </form>`;
  const dialog = document.querySelector("dialog");
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));
  const form = document.querySelector("form");
  initTwoStepGate(form, {
    workerBase: "https://w", step1Endpoint: "/s1", step2Endpoint: "/s2", stepper,
    buildStep1Payload: () => ({}), buildStep2Payload: () => ({}), isStep2Complete: () => true,
    handleStep2Result: () => {},
  });
  return form;
}

const visible = () => [...document.querySelectorAll(".step2-question")].filter((f) => !f.hidden);
const pick = (name, i, detail = 1) => {
  const input = document.querySelector(`[name="${name}"][value="v${i}"]`);
  input.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
  input.checked = true;
  input.dispatchEvent(new Event("change", { bubbles: true }));
};
const count = () => document.querySelector(".stepper-count").textContent;

describe("stepper (opt-in)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing without the stepper option", () => {
    mount(false);
    expect(document.querySelector(".stepper-nav")).toBeNull();
    expect(visible()).toHaveLength(3);
  });

  it("shows one question at a time with live progress", () => {
    mount(true);
    expect(visible()).toHaveLength(1);
    expect(count()).toBe("1 of 3");
    expect(document.querySelector(".stepper-count").getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector(".stepper-next").disabled).toBe(true);
  });

  it("advances on a pointer pick, and Back keeps the earlier answer", () => {
    mount(true);
    pick("a", 1);
    expect(count()).toBe("2 of 3");
    expect(document.activeElement.tagName).toBe("LEGEND");
    document.querySelector(".stepper-back").click();
    expect(count()).toBe("1 of 3");
    expect(document.querySelector('[name="a"][value="v1"]').checked).toBe(true);
    expect(document.querySelector(".stepper-next").disabled).toBe(false);
  });

  it("does not auto-advance on a keyboard pick; Next does", () => {
    mount(true);
    pick("a", 0, 0);
    expect(count()).toBe("1 of 3");
    document.querySelector(".stepper-next").click();
    expect(count()).toBe("2 of 3");
  });

  it("last screen shows See my result, disabled until answered", () => {
    mount(true);
    pick("a", 0); pick("b", 0);
    const submit = document.querySelector(".step2-submit");
    expect(count()).toBe("3 of 3");
    expect(submit.hidden).toBe(false);
    expect(submit.disabled).toBe(true);
    expect(document.querySelector(".stepper-next").hidden).toBe(true);
    pick("c", 0);
    expect(submit.disabled).toBe(false);
  });

  it("Continue application reopens at the first unanswered question", () => {
    mount(true);
    pick("a", 0);
    document.querySelector(".booking-resume-btn").click();
    expect(count()).toBe("2 of 3");
  });
});

describe("stepper on apply-question fieldsets (subcontractor)", () => {
  it("steps through fieldset.apply-question too", () => {
    mount(true);
    document.querySelectorAll(".step2-question").forEach((f) => f.classList.replace("step2-question", "apply-question"));
    // re-init is not needed in the page; here just verify selector via a fresh mount
    document.body.innerHTML = document.body.innerHTML.replace(/step2-question/g, "apply-question");
    const form = document.querySelector("form");
    const dialog = document.querySelector("dialog");
    dialog.showModal = vi.fn();
    initTwoStepGate(form, {
      workerBase: "https://w", step1Endpoint: "/s1", step2Endpoint: "/s2", stepper: true,
      buildStep1Payload: () => ({}), buildStep2Payload: () => ({}), isStep2Complete: () => true,
      handleStep2Result: () => {},
    });
    expect(document.querySelector(".stepper-count").textContent).toBe("1 of 3");
    expect([...document.querySelectorAll(".apply-question")].filter((f) => !f.hidden)).toHaveLength(1);
  });
});
