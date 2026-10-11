import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
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

describe("no page overclaims the monthly report card", () => {
  // The report card is a schedule recap and photos, not a scored or independent audit.
  const OVERCLAIMS = [/audited every month/i, /monthly audit/i, /independent quality audit/i, /scored against the scope/i];
  it("no page calls it an audit or a score", () => {
    for (const f of walk(SITE)) {
      const c = readFileSync(f, "utf8");
      for (const re of OVERCLAIMS) expect(c, `${f}: ${re}`).not.toMatch(re);
    }
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
  it("case studies hidden iff zero entries, after reviews", () => {
    const c = doc.querySelector("#case-studies");
    expect(c).not.toBeNull();
    expect(doc.getElementById("reviews").compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const n = c.querySelectorAll(".case-study-entry").length;
    expect(c.hasAttribute("hidden")).toBe(n === 0);
    expect(c.querySelector("h2").textContent).toBe("Buildings we look after");
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

describe("why-us.html tone pass, scope card and sample images", () => {
  it("has the 'Every room, written down' card linking to the sample", () => {
    expect(text).not.toContain("A scope you can hold us to");
    const card = Array.from(doc.querySelectorAll(".commitment-card")).find((c) => c.querySelector("h4")?.textContent === "Every room, written down");
    expect(card).toBeDefined();
    expect(card.textContent).toContain("Restrooms");
    expect(card.querySelector('a[href="#proof-scope"]')).not.toBeNull();
    expect(doc.getElementById("proof-scope").querySelector("h3").textContent).toBe("Written scope: office cleaning plan");
  });
  it("has no banned phrases", () => {
    const BANNED = ["premier", "best", "#1", "second to none", "exceptional", "100%", "refund", "inspection records", "named supervisor", "get back to you within", "call back within"];
    const lower = read("why-us.html").toLowerCase();
    for (const b of BANNED) expect(lower, b).not.toContain(b);
  });
  it("does not carry About-only claims (D9)", () => {
    expect(text).not.toMatch(/public liability/i);
    expect(text).not.toContain("$20");
  });
  it("temp images exist and are named -temp.svg", () => {
    const imgs = Array.from(doc.querySelectorAll("#proof img[data-temp-image]"));
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      "assets/img/whyus-sample-before-temp.svg",
      "assets/img/whyus-sample-after-desk-temp.svg",
      "assets/img/whyus-sample-after-restroom-temp.svg",
    ]);
    for (const i of imgs) {
      const src = i.getAttribute("src");
      expect(src).toMatch(/-temp\.svg$/);
      expect(existsSync(resolve(SITE, src)), src).toBe(true);
      expect(i.getAttribute("alt")).toBeTruthy();
    }
  });
  it("keeps the pre-existing image files", () => {
    const EXISTING = ["broadbeach-podium-loading-dock-clean.svg","homepage-hero-offices-background.jpg","homepage-office-image.png","logo-navy.svg","offices-slide-show-1.jpg","site-walkthrough-480.webp","office-cleaning-gold-coast-hero.svg","facility-types"];
    const files = readdirSync(resolve(SITE, "assets/img"));
    for (const f of EXISTING) expect(files).toContain(f);
  });
});

describe("why-us.html proof of work", () => {
  const sec = doc.getElementById("proof-of-work");
  const rows = Array.from(sec.querySelectorAll(".work-row"));
  const IMGS = ["checked", "walkthrough", "cloths", "checklist", null, "uniform"];
  it("sits after #proof and before #reviews", () => {
    expect(doc.getElementById("proof").compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sec.compareDocumentPosition(doc.getElementById("reviews")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("has six rows in order", () => {
    expect(rows.map((r) => r.querySelector("h3").textContent)).toEqual([
      "Checked before they set foot on your site",
      "Your building, recorded on day one",
      "The right cloth and the right chemical",
      "Every shift opens and closes the same way",
      "We\u2019re careful with what we photograph",
      "Presented like professionals",
    ]);
  });
  it("has one temp image with alt per row, except row 5", () => {
    rows.forEach((r, i) => {
      const imgs = r.querySelectorAll("img[data-temp-image]");
      if (IMGS[i] === null) return expect(imgs).toHaveLength(0);
      expect(imgs).toHaveLength(1);
      expect(imgs[0].getAttribute("src")).toBe(`assets/img/whyus-pow-${IMGS[i]}-temp.svg`);
      expect(existsSync(resolve(SITE, imgs[0].getAttribute("src")))).toBe(true);
      expect(imgs[0].getAttribute("alt")).toBeTruthy();
    });
  });
  it("row 1 names the insurance certificate but no cover amount", () => {
    expect(rows[0].textContent).toContain("insurance certificate");
    expect(rows[0].textContent).not.toMatch(/\$|million|public liability/i);
  });
  it("avoids banned terms and response times", () => {
    expect(sec.textContent).not.toMatch(/GPS|Connecteam|inspect|audit|score/i);
    expect(sec.textContent).not.toMatch(/within \d+|response time|minutes|hours/i);
  });
});

describe("why-us.html how we start, straight answers, real person", () => {
  const after = (a, b) => expect(doc.getElementById(a).compareDocumentPosition(doc.getElementById(b)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  it("orders sections W2, W3, W4, W4b, W5, W6, reviews, next step", () => {
    const ids = ["how-we-start", "proof", "proof-of-work", "straight-answers", "reach-us", "reviews"];
    for (let i = 1; i < ids.length; i++) after(ids[i - 1], ids[i]);
    const first = doc.querySelector(".commitments-section");
    expect(first.compareDocumentPosition(doc.getElementById("how-we-start")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("how we get started has exactly 4 steps, no check-in", () => {
    const sec = doc.getElementById("how-we-start");
    expect(sec.querySelector("h2").textContent).toBe("How we get started");
    expect(sec.querySelectorAll("ol > li")).toHaveLength(4);
    expect(sec.textContent).toMatch(/5th business day/);
    expect(sec.textContent).not.toMatch(/check-in|first clean/i);
  });
  it("straight answers wording, no details or FAQPage", () => {
    const sec = doc.getElementById("straight-answers");
    for (const w of ["12-month", "Flexible", "signature"]) expect(sec.textContent).toContain(w);
    expect(Array.from(sec.querySelectorAll("h3"), (h) => h.textContent)).toHaveLength(4);
    expect(sec.querySelector("details")).toBeNull();
    expect(read("why-us.html")).not.toContain("<details");
    expect(read("why-us.html")).not.toContain("FAQPage");
  });
  it("reach block has tel and mailto links and hours, no response time", () => {
    const sec = doc.getElementById("reach-us");
    expect(sec.querySelector('a[href="tel:0756512257"]')).not.toBeNull();
    expect(sec.querySelector('a[href="mailto:booking@vantagepointfacilityservices.com.au"]')).not.toBeNull();
    expect(sec.textContent).toContain("Mon\u2013Sun 7am\u20139pm");
    expect(sec.textContent).not.toMatch(/within|minutes|response/i);
  });
});
