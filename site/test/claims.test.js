import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// Claim only what VPFS can back: "Fully insured" stays in the markup but hidden until public liability is bought.
const dir = resolve(__dirname, "..");
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));
const parse = (f) => new DOMParser().parseFromString(readFileSync(resolve(dir, f), "utf8"), "text/html");

describe("insured claim", () => {
  it("keeps every 'Fully insured' element in the markup, hidden", () => {
    let total = 0;
    for (const f of pages) {
      const doc = parse(f);
      const els = Array.from(doc.body.querySelectorAll("li, span")).filter(
        (e) => e.textContent.trim() === "Fully insured" && !e.querySelector("li, span:not(svg *)")
      );
      for (const e of els) {
        total++;
        expect(e.closest("[hidden]"), `${f} has a visible "Fully insured"`).not.toBeNull();
      }
    }
    expect(total).toBe(7);
  });
});

describe("guarantee wording", () => {
  it("no page contains '100% Satisfaction Guarantee'", () => {
    for (const f of pages) expect(readFileSync(resolve(dir, f), "utf8")).not.toMatch(/100% Satisfaction Guarantee/i);
  });
  it("home page shows the re-clean/credit wording", () => {
    expect(parse("index.html").body.textContent.replace(/\s+/g, " ")).toContain(
      "Not right? We re-clean by the next business day — or credit the visit."
    );
  });
});

describe("site-wide insurance claim guard", () => {
  const exempt = ["subcontractor.html", "privacy.html", "terms.html"];
  const checked = pages.filter((f) => !exempt.includes(f));
  const claim = /\$20M|20 million|Insured for|public liability insurance\./i;
  it("no visible element states the insurance claim", () => {
    for (const f of checked) {
      const doc = parse(f);
      for (const el of doc.body.querySelectorAll("*")) {
        if (el.closest("[hidden]") || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
        expect(own, `${f} <${el.tagName.toLowerCase()}> shows an insurance claim`).not.toMatch(claim);
      }
    }
  });
  it("no meta description mentions the $20M claim", () => {
    for (const f of checked) {
      const doc = parse(f);
      for (const m of doc.querySelectorAll('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]'))
        expect(m.getAttribute("content"), `${f} meta`).not.toMatch(/\$20M|20 million/i);
    }
  });
});
