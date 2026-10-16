import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const SITE = resolve(__dirname, "..");
const read = (page) => readFileSync(resolve(SITE, page), "utf8");
const parse = (html) => new DOMParser().parseFromString(html, "text/html");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name === "test" ? [] : e.isDirectory() ? walk(resolve(dir, e.name)) : /\.html$/.test(e.name) ? [resolve(dir, e.name)] : []);

const PAGES = walk(SITE);
const REGIONS = /Sunshine Coast|Brisbane|Northern Rivers/;

const visibleText = (doc) => {
  const body = doc.body.cloneNode(true);
  body.querySelectorAll("[hidden], script, style").forEach((n) => n.remove());
  return body.textContent.replace(/Brisbane time/g, "");
};

describe("launch service area: Gold Coast and the Tweed only", () => {
  it("walks a meaningful set of pages", () => {
    expect(PAGES.length).toBeGreaterThan(30);
  });

  it("no page shows Sunshine Coast, Brisbane or Northern Rivers (except Brisbane time)", () => {
    for (const f of PAGES) expect(visibleText(parse(readFileSync(f, "utf8"))), f).not.toMatch(REGIONS);
  });

  it("no meta/OG/Twitter description or areaServed names the hidden regions", () => {
    for (const f of PAGES) {
      const doc = parse(readFileSync(f, "utf8"));
      doc.querySelectorAll('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]').forEach((m) =>
        expect(m.getAttribute("content"), f).not.toMatch(REGIONS));
      doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        const data = JSON.parse(s.textContent);
        for (const item of [].concat(data)) {
          if (!item.areaServed) continue;
          const served = [].concat(item.areaServed);
          expect(JSON.stringify(served), f).not.toMatch(REGIONS);
          if (JSON.stringify(served).includes("Tweed")) expect(served.map((a) => a.name), f).toEqual(["Gold Coast", "Tweed Shire, NSW"]);
        }
      });
    }
  });

  it("locations.html hides the Sunshine Coast and Brisbane groups with the restore comment", () => {
    const html = read("locations.html");
    const doc = parse(html);
    for (const id of ["sunshine-coast", "brisbane"]) {
      const g = doc.getElementById(id);
      expect(g.classList.contains("region-group")).toBe(true);
      expect(g.hasAttribute("hidden")).toBe(true);
      expect(html).toMatch(new RegExp("<!-- Hidden until[^>]*-->\\s*<div class=\"region-group\" id=\"" + id + "\" hidden>"));
    }
    for (const id of ["gold-coast", "northern-rivers"]) expect(doc.getElementById(id).hasAttribute("hidden")).toBe(false);
    expect(doc.querySelector("#northern-rivers .region-group-title").textContent).toBe("Tweed");
  });

  it("every Locations nav shows Gold Coast and Tweed, with the other two hidden", () => {
    for (const f of PAGES) {
      const doc = parse(readFileSync(f, "utf8"));
      const links = Array.from(doc.querySelectorAll("#nav-locations a"));
      if (!links.length) continue;
      const visible = links.filter((a) => !a.hasAttribute("hidden")).map((a) => a.textContent);
      expect(visible, f).toEqual(["Gold Coast", "Tweed"]);
      for (const h of ["sunshine-coast", "brisbane"]) {
        const a = links.find((l) => l.getAttribute("href").endsWith("#" + h));
        expect(a?.hasAttribute("hidden"), f).toBe(true);
      }
    }
  });

  it("footer tagline names the Gold Coast and the Tweed on every page", () => {
    let n = 0;
    for (const f of PAGES) {
      const p = parse(readFileSync(f, "utf8")).querySelector("footer .footer-brand p, footer p");
      if (!p) continue;
      n++;
      expect(p.textContent, f).toBe("Commercial cleaning across the Gold Coast and the Tweed, delivered to a written standard with a report card every month.");
    }
    expect(n).toBeGreaterThan(30);
  });

  it("keeps Brisbane time wording and time zone", () => {
    expect(read("index.html")).toContain("Times are shown in Brisbane time.");
    expect(read("assets/js/two-step-gate.js")).toContain("Australia/Brisbane");
  });
});

describe("Locations h1 deep links", () => {
  const h1For = (hash) => {
    document.documentElement.innerHTML = parse(read("locations.html")).documentElement.innerHTML;
    window.location.hash = hash;
    // main.js is an IIFE run on load; evaluate it fresh against this document
    new Function(read("assets/js/main.js"))();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    return document.querySelector("[data-location-h1]").textContent;
  };
  it("hidden regions fall back to Gold Coast", () => {
    expect(h1For("#brisbane")).toContain("Gold Coast");
    expect(h1For("#sunshine-coast")).toContain("Gold Coast");
  });
  it("#northern-rivers reads Tweed", () => {
    expect(h1For("#northern-rivers")).toBe("Commercial Cleaning for Tweed Business");
  });
});
