import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// About page: founder story guard rails (.scratch/about-and-why-us-rebuild/sources/founder-facts.md).
const html = readFileSync(resolve(__dirname, "..", "about.html"), "utf8");
const doc = new DOMParser().parseFromString(html, "text/html");
const text = doc.body.textContent.replace(/\s+/g, " ");

describe("about.html founder story", () => {
  it.each(["Currumbin", "Palm Beach", "nippers", "Aboriginal", "amaysim", "two boys"])("mentions %s", (w) => {
    expect(text).toContain(w);
  });

  it.each([
    "sign the cheques", "personally reads", "Indigenous-owned", "Aboriginal-owned", "Supply Nation",
    "Japanese", "sister", "award-winning", "award winning", "full-time", "part-time",
  ])("never says %s", (w) => {
    expect(html.toLowerCase()).not.toContain(w.toLowerCase());
  });

  it("has three photo placeholders in the founder area, (b) protecting the boys' faces", () => {
    const slots = Array.from(doc.querySelectorAll(".founder-section .image-slot .slot-caption"), (c) => c.textContent);
    expect(slots).toHaveLength(3);
    expect(slots[1]).toMatch(/faces must not be identifiable/i);
  });

  it("attributes two quotes to Blake Warton, Founder", () => {
    expect(doc.querySelectorAll("blockquote").length).toBe(2);
    expect(text).toContain("Blake Warton, Founder");
  });

  it("JSON-LD parses, names Blake Warton as founder, no reviews", () => {
    const blocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'), (s) => JSON.parse(s.textContent));
    const withFounder = blocks.find((b) => b.founder);
    expect(withFounder.founder.name).toBe("Blake Warton");
    expect(withFounder.founder["@type"]).toBe("Person");
    const raw = JSON.stringify(blocks);
    expect(raw).not.toMatch(/Review|AggregateRating/);
  });

  it("stays noindex", () => {
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});
