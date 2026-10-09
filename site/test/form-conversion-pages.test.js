import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Every page that loads the booking gate must tag its form with a
// data-conversion-page, and no two pages may share one, so a GHL lead can be
// traced to the page it converted on.
const SITE = resolve(__dirname, "..");
const pages = readdirSync(SITE)
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ f, html: readFileSync(resolve(SITE, f), "utf8") }))
  .filter((p) => p.html.includes("assets/js/booking-gate.js"));
const conversionPageOf = (html) => {
  const m = html.match(/<form class="assessment-form"[^>]*data-conversion-page="([^"]+)"/);
  return m ? m[1] : null;
};

describe("booking form conversion pages", () => {
  it("finds the pages with the booking form", () => {
    expect(pages.length).toBeGreaterThan(15);
  });

  for (const { f, html } of pages) {
    it(`${f} tags its first form with a website-* conversion page`, () => {
      expect(conversionPageOf(html)).toMatch(/^website-[a-z0-9-]+$/);
    });
  }

  it("uses a different conversion page on every page", () => {
    const values = pages.map((p) => conversionPageOf(p.html));
    expect(new Set(values).size).toBe(values.length);
  });

  it("tags locations.html as website-locations", () => {
    expect(conversionPageOf(readFileSync(resolve(SITE, "locations.html"), "utf8"))).toBe("website-locations");
  });
});
