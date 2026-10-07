import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Every page that loads the booking gate must tag its form with a data-channel,
// and no two pages may share one, so a GHL lead can be traced to the page it
// came from.
const SITE = resolve(__dirname, "..");
const pages = readdirSync(SITE)
  .filter((f) => f.endsWith(".html"))
  .map((f) => ({ f, html: readFileSync(resolve(SITE, f), "utf8") }))
  .filter((p) => p.html.includes("assets/js/booking-gate.js"));
const channelOf = (html) => {
  const m = html.match(/<form class="assessment-form"[^>]*data-channel="([^"]+)"/);
  return m ? m[1] : null;
};

describe("booking form channels", () => {
  it("finds the pages with the booking form", () => {
    expect(pages.length).toBeGreaterThan(15);
  });

  for (const { f, html } of pages) {
    it(`${f} tags its first form with a website-* channel`, () => {
      expect(channelOf(html)).toMatch(/^website-[a-z0-9-]+$/);
    });
  }

  it("uses a different channel on every page", () => {
    const channels = pages.map((p) => channelOf(p.html));
    expect(new Set(channels).size).toBe(channels.length);
  });
});
