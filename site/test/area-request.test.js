import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { initAreaRequest } from "../assets/js/area-request.js";

function mountForm() {
  document.body.innerHTML = `
    <form class="assessment-form" data-area-request>
      <div class="form-fields contact-form">
        <div class="booking-error" role="alert"></div>
        <input name="first_name" value="Sam">
        <input name="last_name" value="Lee">
        <input name="email" value="sam@example.com">
        <input name="phone" value="0400000001">
        <input name="postcode" value="4870">
        <input type="hidden" name="enquiry_type" value="New Area Request">
        <input name="url" value="">
        <button type="submit">Request area</button>
      </div>
      <div class="form-success contact-form"><h3>Request received</h3></div>
    </form>`;
  return document.querySelector("form");
}

const submit = (form) => form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Request a new area form", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts the details as JSON to the Worker, never as a page reload", async () => {
    const form = mountForm();
    initAreaRequest(form);
    const ev = new Event("submit", { cancelable: true, bubbles: true });
    form.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://worker.vantagepointfacilityservices.com.au/area-request");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toMatchObject({
      first_name: "Sam", last_name: "Lee", email: "sam@example.com", phone: "0400000001", postcode: "4870", url: "",
    });
  });

  it("shows Request received and hides the fields on success", async () => {
    const form = mountForm();
    initAreaRequest(form);
    submit(form);
    await flush(); await flush();
    expect(form.querySelector(".form-success").classList.contains("show")).toBe(true);
    expect(form.querySelector(".form-fields").hidden).toBe(true);
  });

  it("shows an error and keeps the fields when the Worker fails", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 502 }));
    const form = mountForm();
    initAreaRequest(form);
    submit(form);
    await flush(); await flush();
    expect(form.querySelector(".booking-error").classList.contains("show")).toBe(true);
    expect(form.querySelector(".form-success").classList.contains("show")).toBe(false);
    expect(form.querySelector("button[type=submit]").disabled).toBe(false);
  });
});

describe("locations.html wiring", () => {
  const html = readFileSync(resolve(__dirname, "..", "locations.html"), "utf8");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const form = doc.querySelector("form[data-area-request]");

  it("marks the area form, with an error box and a Turnstile widget", () => {
    expect(form).not.toBeNull();
    expect(form.hasAttribute("data-conversion-page")).toBe(false);
    expect(form.querySelector(".booking-error")).not.toBeNull();
    expect(form.querySelector(".turnstile-widget[data-sitekey]")).not.toBeNull();
  });

  it("loads the area-request script", () => {
    expect(doc.querySelector('script[type="module"][src="assets/js/area-request.js"]')).not.toBeNull();
  });
});
