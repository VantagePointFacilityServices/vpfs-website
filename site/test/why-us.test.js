import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const SITE = resolve(__dirname, "..");
const read = (page) => readFileSync(resolve(SITE, page), "utf8");
const doc = new DOMParser().parseFromString(read("why-us.html"), "text/html");
const text = doc.body.textContent;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name === "test" ? [] : e.isDirectory() ? walk(resolve(dir, e.name)) : /\.(html|js|json|xml)$/.test(e.name) ? [resolve(dir, e.name)] : []);

const FABRICATED = ["Three years in", "84-lot complex", "Nobody mentions cleaning", "What property managers say"];

describe("why-us.html only makes true claims", () => {
  it("has no fabricated testimonials", () => {
    const html = read("why-us.html");
    for (const q of FABRICATED) expect(html).not.toContain(q);
  });
  it("no other page carries those quotes", () => {
    for (const f of walk(SITE)) {
      const c = readFileSync(f, "utf8");
      for (const q of FABRICATED) expect(c, `${f}: ${q}`).not.toContain(q);
    }
  });
  it("never calls the report card an audit report", () => {
    expect(text).not.toMatch(/audit report/i);
  });
  it("has no 'scored' or 'named supervisor'", () => {
    expect(text).not.toMatch(/scored/i);
    expect(text).not.toMatch(/named supervisor/i);
  });
  it("report card mentions recap, photos and 5th business day", () => {
    const card = Array.from(doc.querySelectorAll(".commitment-card")).find((c) => c.querySelector("h4")?.textContent === "A monthly report card");
    expect(card).toBeDefined();
    expect(card.textContent).toMatch(/schedule recap/i);
    expect(card.textContent).toMatch(/before-and-after photos/i);
    expect(card.textContent).toMatch(/5th business day/i);
  });
  it("JSON-LD has no Review or AggregateRating", () => {
    const blocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'), (s) => s.textContent).join("\n");
    expect(blocks).not.toMatch(/"(Review|AggregateRating)"/);
  });
});

describe("why-us.html proof and reviews", () => {
  const proof = doc.querySelector("#proof");
  const items = Array.from(proof.querySelectorAll(".proof-item"));
  it("has exactly three proof items; report card and scope show Sample", () => {
    expect(items).toHaveLength(3);
    for (const id of ["proof-report-card", "proof-scope"]) {
      expect(doc.getElementById(id).textContent).toMatch(/\bSample\b/);
    }
  });
  it("guarantee wording", () => {
    const g = doc.getElementById("proof-guarantee").textContent;
    expect(g).toContain("24 hours");
    expect(g).toContain("next business day");
    expect(g).toContain("Australian Consumer Law");
    expect(g).not.toContain("100%");
    expect(g).not.toMatch(/refund/i);
    expect(text).not.toContain("100%");
    expect(text).not.toMatch(/refund/i);
  });
  it("reviews section is hidden iff it has zero review entries", () => {
    const r = doc.querySelector("#reviews");
    expect(r).not.toBeNull();
    const n = r.querySelectorAll(".review-entry").length;
    expect(r.hasAttribute("hidden")).toBe(n === 0);
  });
  it("samples use only 'Example office' as the business name", () => {
    expect(proof.textContent).toMatch(/Example office/);
    const samples = ["proof-report-card", "proof-scope"].map((id) => doc.getElementById(id).textContent).join(" ");
    expect(samples).not.toMatch(/\b(Pty|Ltd|Corp|Holdings|Group|Law|Realty)\b/);
  });
  it("has no Review schema markup", () => {
    expect(read("why-us.html")).not.toMatch(/itemtype=["'][^"']*Review/);
  });
});
