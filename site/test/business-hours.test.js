import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Business hours are Mon–Sun, 7am–7pm (decided 2026-09-29). Every page must
// say the same thing in both the visible footer and the JSON-LD schema that
// search engines read — a mismatch is exactly the bug this replaced (footer
// Mon–Fri 7–5 vs. the contact card's "24/7").
const SITE = resolve(__dirname, "..");
const pages = readdirSync(SITE).filter((f) => f.endsWith(".html"));
const read = (page) => readFileSync(resolve(SITE, page), "utf8");

describe.each(pages)("%s business hours", (page) => {
  it("shows Mon–Sun 7am–7pm wherever it shows hours", () => {
    const html = read(page);
    const shown = html.match(/Mon&ndash;(?:Fri|Sat|Sun)[^<]*/g) || [];
    for (const text of shown) expect(text.replace(/,/g, "").trim()).toBe("Mon&ndash;Sun 7am&ndash;7pm");
  });

  it("never claims 24/7 business hours or the old 5pm close", () => {
    const html = read(page);
    expect(html).not.toMatch(/24\/7/);
    expect(html).not.toMatch(/7am&ndash;5pm|"closes": "17:00"/);
  });

  it("publishes matching opening hours in its schema, if it has any", () => {
    const html = read(page);
    const m = html.match(/"openingHoursSpecification":\s*(\{[^}]*\})/);
    if (!m) return;
    const spec = JSON.parse(m[1]);
    expect(spec.dayOfWeek).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(spec.opens).toBe("07:00");
    expect(spec.closes).toBe("19:00");
  });
});
