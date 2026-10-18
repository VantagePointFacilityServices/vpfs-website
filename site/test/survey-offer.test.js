import { describe, it, expect, afterEach } from "vitest";
import { createSurveyOffer } from "../assets/js/survey-offer.js";

const hook = createSurveyOffer({
  getUrl: (form) => form.dataset.surveyUrl,
  panelIds: ["custom-panel"],
  nowLabel: "Tell us now",
  laterLabel: "Maybe later",
  closeLabel: "Done",
  heading: "Facility details",
  subHeading: "one minute",
  frameTitle: "Facility survey",
});

function mount(url) {
  document.body.innerHTML = `<form data-survey-url="${url}"><input name="email" value="a@b.co"><input name="phone" value="0400">
    <dialog class="booking-dialog"><div id="custom-panel">hi</div><div id="other"></div></dialog></form>`;
  const form = document.querySelector("form");
  document.querySelector("dialog").close = () => {};
  return form;
}
const scripts = () => document.querySelectorAll('script[src*="form_embed.js"]');

describe("shared survey offer (non-applicant config)", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  it("offers custom labels only on configured panels, loading nothing", () => {
    const form = mount("https://x.test/s");
    hook(form.querySelector("#other"), form);
    expect(form.querySelector(".enrich-cta")).toBeNull();
    hook(form.querySelector("#custom-panel"), form);
    const btns = [...form.querySelectorAll(".enrich-cta button")].map((b) => b.textContent);
    expect(btns).toEqual(["Tell us now", "Maybe later"]);
    expect(form.querySelector("iframe")).toBeNull();
    expect(scripts().length).toBe(0);
  });

  it("does nothing without a survey URL", () => {
    const form = mount("");
    hook(form.querySelector("#custom-panel"), form);
    expect(form.querySelector(".enrich-cta")).toBeNull();
  });

  it("opens the configured screen, focuses heading, injects embed script once", () => {
    const form = mount("https://x.test/s");
    const panel = form.querySelector("#custom-panel");
    hook(panel, form);
    panel.querySelector(".enrich-now").click();
    const h = panel.querySelector("h3");
    expect(h.textContent).toBe("Facility details");
    expect(document.activeElement).toBe(h);
    expect(panel.querySelector(".enrich-screen p").textContent).toBe("one minute");
    expect(panel.querySelector("iframe").title).toBe("Facility survey");
    expect(panel.querySelector("iframe").src).toContain("email=a%40b.co");
    expect(panel.querySelector(".enrich-newtab").target).toBe("_blank");
    expect(panel.querySelector(".enrich-screen .enrich-skip").textContent).toBe("Done");
    hook(panel, form);
    expect(scripts().length).toBe(1);
  });
});
