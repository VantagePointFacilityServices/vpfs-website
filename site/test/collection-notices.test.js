import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, join, relative } from "path";
import { NOTICES, noticeTypeFor } from "./helpers/collection-notices.js";

const SITE_DIR = resolve(__dirname, "..");
function discoverPages(dir = SITE_DIR) {
  const pages = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) pages.push(...discoverPages(full));
    else if (name.endsWith(".html")) pages.push(relative(SITE_DIR, full));
  }
  return pages.sort();
}
const PAGES = discoverPages().filter((p) => /<form[^>]*assessment-form/.test(readFileSync(resolve(SITE_DIR, p), "utf8")));

describe.each(PAGES)("%s collection notices", (page) => {
  const doc = new DOMParser().parseFromString(readFileSync(resolve(SITE_DIR, page), "utf8"), "text/html");
  const forms = Array.from(doc.querySelectorAll("form.assessment-form"));

  it("gives every form exactly one notice, matching its type, before the Step 1 submit", () => {
    for (const form of forms) {
      const notices = form.querySelectorAll(".form-privacy-notice");
      expect(notices.length).toBe(1);
      const n = notices[0];
      expect(n.tagName).toBe("P");
      expect(n.innerHTML.trim()).toBe(NOTICES[noticeTypeFor(form)]);
      expect(n.querySelector('a[href="/privacy.html#collection-notice"]')).not.toBeNull();
      expect(n.querySelector('a[href="/privacy.html"]')).not.toBeNull();
      const submit = form.querySelector('button[type="submit"]');
      expect(n.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(n.closest(".booking-step-2")).toBeNull();
      expect(n.querySelector("input")).toBeNull();
    }
  });
});

describe("privacy.html collection notice section", () => {
  const html = readFileSync(resolve(SITE_DIR, "privacy.html"), "utf8");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const sec = () => doc.getElementById("collection-notice");

  it("has the standard notice, three-row table, screening line, countries and email", () => {
    expect(sec()).not.toBeNull();
    const rows = [];
    for (let el = sec().nextElementSibling; el && el.tagName !== "H2"; el = el.nextElementSibling) rows.push(el);
    const body = rows.map((e) => e.textContent).join(" ");
    expect(rows.map((e) => e.querySelectorAll("tbody tr").length).reduce((a, b) => a + b, 0)).toBe(3);
    expect(body).toContain("Some client sites, such as schools, childcare and NDIS services, require police, Blue Card or NDIS worker screening. We'll ask for your consent before any check.");
    expect(body).toContain("the USA, the United Kingdom, Germany and the Netherlands");
    expect(body).toContain("blake@vantagepointfacilityservices.com");
    expect(body).toContain("Vantage Point Facility Services Pty Ltd collects these details to {purpose}. If you don't provide them, {consequence}.");
    expect(body).toContain("We share them only with the service providers that run our booking, phone, payment and scheduling systems");
    expect(body).toContain("Privacy Policy explains how to access or correct your information, how to complain, and how we handle it.");
    for (const cell of [
      "assess your site and offer a walkthrough or quote", "we can't assess your site or book a walkthrough",
      "assess your application, check your right to work and, where a client site requires it, run screening checks", "we can't consider your application",
      "tell you when we can service your area", "we can't let you know when we cover your area",
    ]) expect(body).toContain(cell);
  });
});
