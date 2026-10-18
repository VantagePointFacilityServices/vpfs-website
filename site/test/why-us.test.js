import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";

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
  it("keeps every pre-existing image file present and unchanged (D28)", () => {
    // Every file in site/assets/img at merge-base 53465ce, with the first 16 hex chars of its sha256.
    const EXISTING = {
  "broadbeach-podium-loading-dock-clean.svg": "df5fd4fac4ebc0b7",
  "bundall-serviced-office-kitchenette-clean.svg": "df5fd4fac4ebc0b7",
  "bundall-tower-lift-lobby-access.svg": "df5fd4fac4ebc0b7",
  "burleigh-james-street-retail-suite-clean.svg": "df5fd4fac4ebc0b7",
  "burleigh-west-business-estate-access.svg": "df5fd4fac4ebc0b7",
  "carrara-sports-precinct-amenities-clean.svg": "df5fd4fac4ebc0b7",
  "childcare-change-area-toilets-clean.svg": "df5fd4fac4ebc0b7",
  "childcare-cleaning-gold-coast-hero.svg": "07d68db10c32b607",
  "childcare-supervisor-session-checklist.svg": "df5fd4fac4ebc0b7",
  "commercial-cleaning-bundall-hero.svg": "07d68db10c32b607",
  "commercial-cleaning-burleigh-heads-hero.svg": "df5fd4fac4ebc0b7",
  "commercial-cleaning-helensvale-coomera-hero.svg": "df5fd4fac4ebc0b7",
  "commercial-cleaning-nerang-carrara-hero.svg": "df5fd4fac4ebc0b7",
  "commercial-cleaning-robina-varsity-lakes-hero.svg": "df5fd4fac4ebc0b7",
  "commercial-cleaning-southport-hero.svg": "07d68db10c32b607",
  "commercial-cleaning-surfers-paradise-broadbeach-hero.svg": "07d68db10c32b607",
  "coomera-business-park-access.svg": "df5fd4fac4ebc0b7",
  "facility-types/education-480.webp": "614635719008bb67",
  "facility-types/education-800.webp": "4eed09ced2db0242",
  "facility-types/industrial-480.webp": "ec82a260666f36ce",
  "facility-types/industrial-800.webp": "aa9ebb3bf3a64c5d",
  "facility-types/medical-480.webp": "42f3121eb28984ab",
  "facility-types/medical-800.webp": "4ef779262b5684d5",
  "facility-types/office-480.webp": "837fcfed94545e91",
  "facility-types/office-800.webp": "dd094039b9d62c06",
  "facility-types/strata-480.webp": "5403d7960e3bd3b5",
  "facility-types/strata-800.webp": "d23ee8649dbde596",
  "helensvale-transport-hub-office-clean.svg": "df5fd4fac4ebc0b7",
  "homepage-hero-offices-background.jpg": "a9f1a2c59abe030d",
  "homepage-office-image.png": "971f608a349050d0",
  "logo-navy.svg": "d10c2ffac300ccc2",
  "logo-white.svg": "fe37272edaaa11d0",
  "mark-navy.svg": "ccd926fe2f4e670e",
  "mark-white.svg": "a5a4538296baf273",
  "medical-centre-cleaning-gold-coast-hero.svg": "07d68db10c32b607",
  "medical-reception-desk-clean.svg": "df5fd4fac4ebc0b7",
  "medical-waiting-room-clean.svg": "df5fd4fac4ebc0b7",
  "nerang-industrial-unit-office-clean.svg": "df5fd4fac4ebc0b7",
  "office-cleaning-gold-coast-hero.svg": "07d68db10c32b607",
  "office-reception-meeting-room-clean.svg": "df5fd4fac4ebc0b7",
  "office-workstation-desk-cleaning.svg": "df5fd4fac4ebc0b7",
  "offices-slide-show-1.jpg": "d5268498ef56565c",
  "offices-slide-show-2.jpg": "02488e62255d91ae",
  "offices-slide-show-3.jpg": "a9f1a2c59abe030d",
  "robina-town-centre-suite-clean.svg": "df5fd4fac4ebc0b7",
  "school-classroom-toilet-block-clean.svg": "df5fd4fac4ebc0b7",
  "school-cleaning-gold-coast-hero.svg": "07d68db10c32b607",
  "school-holiday-deep-clean-planning.svg": "df5fd4fac4ebc0b7",
  "site-walkthrough-480.webp": "df9c7621fa82543a",
  "site-walkthrough-930.webp": "c6bf80e207b591cc",
  "southport-clinic-reception-clean.svg": "df5fd4fac4ebc0b7",
  "southport-tower-basement-access.svg": "df5fd4fac4ebc0b7",
  "strata-bin-room-clean.svg": "df5fd4fac4ebc0b7",
  "strata-cleaning-gold-coast-hero.svg": "07d68db10c32b607",
  "strata-entry-glass-amenities.svg": "df5fd4fac4ebc0b7",
  "strata-lobby-cleaning.svg": "df5fd4fac4ebc0b7",
  "supervisor-inspection-office-checklist.svg": "df5fd4fac4ebc0b7",
  "surfers-paradise-tower-car-park-clean.svg": "df5fd4fac4ebc0b7",
  "varsity-lakes-business-park-access.svg": "df5fd4fac4ebc0b7",
  "warehouse-industrial-cleaning-gold-coast-hero.svg": "07d68db10c32b607",
  "warehouse-industrial-floor-zone-cleaning.svg": "df5fd4fac4ebc0b7",
  "warehouse-industrial-shift-changeover-clean.svg": "df5fd4fac4ebc0b7",
  "warehouse-industrial-site-induction-ppe.svg": "df5fd4fac4ebc0b7"
    };
    expect(Object.keys(EXISTING)).toHaveLength(63);
    for (const [f, hash] of Object.entries(EXISTING)) {
      const path = resolve(SITE, "assets/img", f);
      expect(existsSync(path), f).toBe(true);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16), f).toBe(hash);
    }
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
  it("orders sections: hero, trust strip, commitments, W2, W3, W4, W4b, W5, W6, reviews, next step", () => {
    const fol = (a, b) => expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fol(doc.querySelector(".hero-inverse"), doc.querySelector(".trust-strip"));
    fol(doc.querySelector(".trust-strip"), doc.querySelector(".commitments-section"));
    const ids = ["how-we-start", "proof", "proof-of-work", "straight-answers", "reach-us", "reviews"];
    for (let i = 1; i < ids.length; i++) after(ids[i - 1], ids[i]);
    fol(doc.getElementById("case-studies"), doc.querySelector(".testimonials-section"));
    const first = doc.querySelector(".commitments-section");
    expect(first.compareDocumentPosition(doc.getElementById("how-we-start")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("how we get started has 5 steps, with the check-in after the first two cleans as step 4 (C-OPS-01 step 8)", () => {
    const sec = doc.getElementById("how-we-start");
    expect(sec.querySelector("h2").textContent).toBe("How we get started");
    const steps = Array.from(sec.querySelectorAll("ol > li"), (li) => li.textContent);
    expect(steps).toHaveLength(5);
    expect(steps[3]).toMatch(/first two cleans/);
    expect(steps[4]).toMatch(/5th business day/);
    // C-OPS-01 promises a follow-up after the first two cleans, nothing faster or more frequent.
    expect(sec.textContent).not.toMatch(/first clean\b|within \d+ (business )?(hours|days)|every week|weekly/i);
  });
  it("straight answers wording, no details or FAQPage", () => {
    const sec = doc.getElementById("straight-answers");
    for (const w of ["12-month", "Flexible", "signature", "Most sites start from $1,500 a month + GST. We quote after a walkthrough, in writing, with the cleaning plan attached, so you know exactly what you\u2019re paying for."]) expect(sec.textContent).toContain(w);
    expect(Array.from(sec.querySelectorAll("h3"), (h) => h.textContent)).toHaveLength(4);
    expect(sec.querySelector("details")).toBeNull();
    expect(read("why-us.html")).not.toContain("<details");
    expect(read("why-us.html")).not.toContain("FAQPage");
  });
  it("price signal appears once in the hero and once in straight answers", () => {
    const html = read("why-us.html");
    expect(html.split("from $1,500 a month + GST").length - 1).toBe(2);
    expect(doc.querySelector(".hero-inner").textContent).toContain("Free, no-obligation walkthrough. Most sites start from $1,500 a month + GST.");
    expect(doc.getElementById("straight-answers").textContent).toContain("from $1,500 a month + GST");
    // The hero is dark; only classed hero paragraphs get light text (style.css .hero-inverse .hero-response).
    const heroPrice = Array.from(doc.querySelectorAll(".hero-inner p")).find((p) => p.textContent.includes("from $1,500 a month + GST"));
    expect(heroPrice.classList.contains("hero-response")).toBe(true);
    expect(html.split("Price signal = Phase 1 lead-gate floor").length - 1).toBe(2);
  });
  it("price signal matches the Worker lead-gate floor", () => {
    const worker = readFileSync(resolve(SITE, "..", "worker", "worker.js"), "utf8");
    const m = worker.match(/const MIN_MONTHLY_SPEND = (\d+)/);
    expect(m).not.toBeNull();
    const figure = "$" + Number(m[1]).toLocaleString("en-US");
    expect(text).toContain(`from ${figure} a month + GST`);
  });
  it("reach block has tel and mailto links and hours, no response time", () => {
    const sec = doc.getElementById("reach-us");
    expect(sec.querySelector('a[href="tel:0756512257"]')).not.toBeNull();
    expect(sec.querySelector('a[href="mailto:booking@vantagepointfacilityservices.com.au"]')).not.toBeNull();
    expect(sec.textContent).toContain("Mon\u2013Sun 7am\u20139pm");
    expect(sec.textContent).not.toMatch(/within|minutes|response/i);
  });
});

describe("why-us.html switch-reasons cards", () => {
  const sec = doc.querySelector(".commitments-section");
  const cards = Array.from(sec.querySelectorAll(".commitment-card"));
  it("has eyebrow and H2", () => {
    expect(sec.querySelector(".eyebrow").textContent).toBe("Why businesses switch to us");
    expect(sec.querySelector("h2").textContent).toBe("What usually goes wrong with cleaners, and what we do instead");
  });
  it("has 4 cards with H4s in order", () => {
    expect(cards).toHaveLength(4);
    expect(cards.map((c) => c.querySelector("h4").textContent)).toEqual(["Every room, written down", "The same faces on site", "A monthly report card", "Covered when someone\u2019s away"]);
  });
  it("each card has a non-empty problem line above its H4", () => {
    for (const c of cards) {
      const p = c.querySelector("p.commitment-problem");
      expect(p.textContent.trim().length).toBeGreaterThan(0);
      expect(p.compareDocumentPosition(c.querySelector("h4")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
  it("drops 'Products that suit' and keeps proof row 3", () => {
    for (const c of cards) expect(c.textContent).not.toContain("Products that suit");
    expect(text).toContain("The right cloth and the right chemical");
  });
  it("card 2 says aim to keep the same team", () => {
    expect(cards[1].textContent).toContain("aim to keep the same team");
  });
});

describe("why-us.html trust strip and mid-page CTA", () => {
  const strip = doc.querySelector("ul.trust-strip");
  it("sits between hero and commitments", () => {
    expect(strip).not.toBeNull();
    const hero = doc.querySelector(".hero-inverse"), com = doc.querySelector(".commitments-section");
    expect(hero.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(com) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("has six items in order", () => {
    expect(Array.from(strip.querySelectorAll("li"), (li) => li.textContent.trim())).toEqual([
      "Police-checked team", "Written cleaning plan before you sign", "Next-business-day re-clean guarantee",
      "Monthly report card", "Gold Coast & Tweed", "ABN 89 700 018 775"]);
  });
  it("links the ABN to ABN Lookup", () => {
    const a = strip.querySelector("a");
    expect(a.textContent).toBe("89 700 018 775");
    expect(a.getAttribute("href")).toBe("https://abr.business.gov.au/ABN/View?abn=89700018775");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(a.getAttribute("target")).toBe("_blank");
  });
  it("makes no insurance or price claims", () => {
    expect(strip.textContent).not.toMatch(/insur|public liability|\$/i);
  });
  it("hero form is #top-booking and the CTA links to it", () => {
    expect(doc.getElementById("top-booking")).not.toBeNull();
    const sec = doc.getElementById("how-we-start");
    const a = sec.querySelector('a[href="#top-booking"]');
    expect(a.textContent).toBe("Book a walkthrough");
    expect(a.classList.contains("btn-primary")).toBe(true);
    expect(sec.querySelector("ol").contains(a)).toBe(false);
    expect(sec.textContent).toContain("Free, no obligation.");
  });
});
