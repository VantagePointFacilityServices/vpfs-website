import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// SEO + claims guard rails for the vertical/precinct landing pages
// (.scratch/vertical-landing-pages/PRD.md, "Testing Decisions"). Landing pages
// are discovered by <body data-page-type="landing">, so adding a page never
// means editing a list here.
const SITE = resolve(__dirname, "..");
const ORIGIN = "https://www.vantagepointfacilityservices.com.au";
const ALL_PAGES = readdirSync(SITE).filter((f) => f.endsWith(".html"));
const read = (page) => readFileSync(resolve(SITE, page), "utf8");
const parse = (page) => new DOMParser().parseFromString(read(page), "text/html");

const LANDING_PAGES = ALL_PAGES.filter((p) => parse(p).body.dataset.pageType === "landing");
// services.html is the hub: held to the same SEO checks, but it carries no
// landing marker or Service schema.
const SEO_PAGES = [...LANDING_PAGES, "services.html"];

// Legacy page checks that issue 06 (services.html hub rewrite, D16) will make
// pass: reported with a warning, not failed, until then. Shrink-only.
const LEGACY_SEO_EXEMPT = {
  "services.html": ["h1", "images"], // issue 06: JS-filled <h1>, CSS-background carousel, logos without width/height
};
const exempt = (page, check) => (LEGACY_SEO_EXEMPT[page] || []).includes(check);
const guard = (page, check, fn) => {
  if (!exempt(page, check)) return fn();
  try {
    fn();
  } catch (e) {
    console.warn(`[issue 06] ${page} fails "${check}" check: ${String(e.message).split("\n")[0]}`);
  }
};

const titleOf = (p) => parse(p).title.trim();
const descOf = (p) => (parse(p).querySelector('meta[name="description"]')?.content || "").trim();
const sitemap = readFileSync(resolve(SITE, "sitemap.xml"), "utf8");

const jsonLd = (page) =>
  Array.from(parse(page).querySelectorAll('script[type="application/ld+json"]'), (s) => JSON.parse(s.textContent));
const typesIn = (node) => {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      if (n["@type"]) out.push(...[].concat(n["@type"]));
      Object.values(n).forEach(walk);
    }
  };
  walk(node);
  return out;
};

describe("medical landing page", () => {
  const page = "medical-centre-cleaning-gold-coast.html";
  it("is discovered as a landing page keyed medical", () => {
    expect(LANDING_PAGES).toContain(page);
    expect(parse(page).body.dataset.pageKey).toBe("medical");
  });
  it("states the general-area scope and the treatment/procedure-room boundary", () => {
    const text = visibleText(page);
    expect(text).toMatch(/reception, waiting rooms, offices, staff rooms and bathrooms/);
    expect(text).toMatch(/treatment and procedure rooms are scoped once our clinical cleaning protocol is in place/i);
  });
  it("uses the medical channel, default facility type and CTA", () => {
    const doc = parse(page);
    expect(doc.querySelector("form.assessment-form").dataset.channel).toBe("website-lp-medical");
    expect(doc.querySelector("select[name=facility_type] option[selected]").value).toBe("medical");
    expect(doc.querySelector("form.assessment-form button[type=submit]").textContent.trim()).toBe("Request a Facility Consultation");
  });
});

describe("landing page discovery", () => {
  it("finds at least the office landing page", () => {
    expect(LANDING_PAGES).toContain("office-cleaning-gold-coast.html");
  });
});

describe.each(SEO_PAGES)("%s on-page SEO", (page) => {
  const isLanding = LANDING_PAGES.includes(page);

  it("has a title and meta description", () => {
    expect(titleOf(page)).not.toBe("");
    expect(descOf(page)).not.toBe("");
  });

  it("has a title and description no other page shares", () => {
    const others = ALL_PAGES.filter((p) => p !== page);
    const dupTitle = others.filter((p) => titleOf(p) === titleOf(page));
    const dupDesc = others.filter((p) => descOf(p) === descOf(page));
    // Legacy pages share copy until issue 06 rewrites them: report, don't fail.
    const offenders = (list) => (isLanding ? list : list.filter((p) => LANDING_PAGES.includes(p)));
    expect(offenders(dupTitle), "duplicate title").toEqual([]);
    expect(offenders(dupDesc), "duplicate description").toEqual([]);
    if (!isLanding && (dupTitle.length || dupDesc.length)) {
      console.warn(`[issue 06] ${page} shares title/description with: ${[...dupTitle, ...dupDesc].join(", ")}`);
    }
  });

  it("has a self-referencing canonical", () => {
    expect(parse(page).querySelector('link[rel="canonical"]')?.href).toBe(`${ORIGIN}/${page}`);
  });

  it("has exactly one non-empty hard-coded <h1>", () => {
    guard(page, "h1", () => {
      const h1s = parse(page).querySelectorAll("h1");
      expect(h1s.length).toBe(1);
      expect(h1s[0].textContent.trim()).not.toBe("");
    });
  });

  it("has JSON-LD that parses and uses no banned types", () => {
    const types = typesIn(jsonLd(page));
    for (const banned of ["FAQPage", "HowTo", "AggregateRating", "Review"]) {
      expect(types).not.toContain(banned);
    }
  });

  it("has an alt, width and height on every image, and no inline background-image", () => guard(page, "images", () => {
    const doc = parse(page);
    for (const img of doc.querySelectorAll("img")) {
      const id = img.getAttribute("src");
      expect((img.getAttribute("alt") || "").trim(), `alt: ${id}`).not.toBe("");
      expect(img.getAttribute("width"), `width: ${id}`).toBeTruthy();
      expect(img.getAttribute("height"), `height: ${id}`).toBeTruthy();
    }
    if (isLanding) {
      for (const el of doc.querySelectorAll("[style]")) {
        expect(el.getAttribute("style"), el.outerHTML.slice(0, 80)).not.toMatch(/background-image/i);
      }
    }
  }));

  it("is listed in sitemap.xml", () => {
    expect(sitemap).toContain(`<loc>${ORIGIN}/${page}</loc>`);
  });
});

describe.each(LANDING_PAGES)("%s landing markup", (page) => {
  it("carries a page key in its landing marker", () => {
    expect(parse(page).body.dataset.pageKey).toMatch(/^[a-z-]+$/);
  });

  it("has Service, BreadcrumbList and LocalBusiness JSON-LD", () => {
    const types = typesIn(jsonLd(page));
    for (const t of ["Service", "BreadcrumbList", "LocalBusiness"]) expect(types).toContain(t);
  });

  it("has visible breadcrumbs", () => {
    expect(parse(page).querySelector('nav[aria-label="Breadcrumb"] a')).not.toBeNull();
  });

  it("lazy-loads every image except the hero, which is high priority", () => {
    const imgs = Array.from(parse(page).querySelectorAll("main img, body > section img, body > nav img")).filter(
      (i) => !i.closest("header") && !i.closest("footer"),
    );
    const hero = imgs.find((i) => i.closest(".hero-grid"));
    expect(hero, "hero image").toBeTruthy();
    expect(hero.getAttribute("fetchpriority")).toBe("high");
    expect(hero.getAttribute("loading")).not.toBe("lazy");
    for (const img of imgs.filter((i) => i !== hero)) {
      expect(img.getAttribute("loading"), img.getAttribute("src")).toBe("lazy");
    }
  });

  it("loads the same booking assets as index.html", () => {
    const html = read(page);
    for (const s of ["assets/css/style.css", "assets/js/booking-gate.js", "assets/js/main.js", "challenges.cloudflare.com/turnstile/v0/api.js"]) {
      expect(html).toContain(s);
    }
  });
});

// ---- Banned claims (PRD D3/D4/D11/D19) ------------------------------------
// Visible text of every site page must avoid these. LEGACY_ALLOW lists the
// only legacy phrases tolerated; each entry names the issue that removes it,
// and later issues may only SHRINK this list.
const BANNED = [
  /eco-friendly/i, /eco products/i, /non-toxic/i, /chemical-free/i, /biodegradable/i,
  /hospital-grade/i, /clinical-grade/i, /sterile/i, /germ-free/i, /sharps/i,
  /\bno\.?\s?1\b/i, /\bbest\b/i,
  /\d+\s?%[^.]{0,60}(productiv|sick)/i, /(productiv|sick)[^.]{0,60}\d+\s?%/i,
];
const MEDICAL_EXTRA = [/infection[- ]control/i, /AGPAL|QIP|RACGP/, /TGA/, /clinical waste/i, /accredit/i];
// page -> banned patterns (as source strings) tolerated until issue 06.
const LEGACY_ALLOW = {
  "services.html": ["clinical-grade", "sharps", "eco products"], // issue 06 rewrites services.html (D16)
  "why-us.html": ["clinical-grade"], // issue 06 reviews legacy claims copy ("clinical-grade where the site requires it")
  "about.html": ["\\bbest\\b"], // issue 06 reviews legacy claims copy ("the best strata committees…")
};

function visibleText(page) {
  const doc = parse(page);
  doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
  return doc.body.textContent.replace(/\s+/g, " ");
}

describe.each(ALL_PAGES)("%s banned claims", (page) => {
  const allowed = LEGACY_ALLOW[page] || [];
  const isMedical = parse(page).body.dataset.pageKey === "medical";
  const patterns = [...BANNED, ...(isMedical ? MEDICAL_EXTRA : [])];

  it("makes none of the banned claims", () => {
    const text = visibleText(page);
    const hits = patterns.filter((re) => re.test(text) && !allowed.some((a) => re.source.includes(a)));
    expect(hits.map(String)).toEqual([]);
  });

  it("only allow-lists phrases that are actually still present (shrink-only)", () => {
    const text = visibleText(page);
    for (const a of allowed) expect(new RegExp(a, "i").test(text), `stale allow-list entry "${a}" (issue 06)`).toBe(true);
  });
});

describe("landing page shot lists", () => {
  const shotLists = readFileSync(resolve(SITE, "..", "docs/landing-pages/shot-lists.md"), "utf8");
  for (const page of LANDING_PAGES) {
    it(`${page}: every <img> src is in docs/landing-pages/shot-lists.md`, () => {
      for (const img of parse(page).querySelectorAll("img")) {
        const src = img.getAttribute("src");
        // Shared chrome (logos) is not a shot-list slot.
        if (/assets\/img\/logo-/.test(src)) continue;
        expect(shotLists, src).toContain(src);
      }
    });
  }
});

describe("facility_type construction option label (D14)", () => {
  it.each(ALL_PAGES)("%s labels every construction option 'Warehouse / industrial'", (page) => {
    for (const opt of parse(page).querySelectorAll('select[name="facility_type"] option[value="construction"]')) {
      expect(opt.textContent.trim()).toBe("Warehouse / industrial");
    }
  });
});

describe("warehouse landing page", () => {
  const doc = parse("warehouse-industrial-cleaning-gold-coast.html");
  it("has the warehouse channel, construction default and Industrial in title", () => {
    expect(doc.body.dataset.pageKey).toBe("warehouse");
    expect(doc.querySelector("form.assessment-form").dataset.channel).toBe("website-lp-warehouse");
    expect(doc.querySelector('option[value="construction"]').selected).toBe(true);
    expect(doc.title).toMatch(/Industrial/);
    expect(doc.querySelector("h1").textContent.trim()).toBe("Warehouse Cleaning Gold Coast");
    expect(doc.body.textContent).not.toMatch(/post-construction|construction site/i);
  });
});

describe("Services dropdown links each vertical to its own page", () => {
  const TARGETS = {
    Office: "office-cleaning-gold-coast.html",
    "Strata & body corporate": "strata-cleaning-gold-coast.html",
    School: "school-cleaning-gold-coast.html",
    Childcare: "childcare-cleaning-gold-coast.html",
    "Medical centre": "medical-centre-cleaning-gold-coast.html",
    "Warehouse & industrial": "warehouse-industrial-cleaning-gold-coast.html",
  };
  it.each(LANDING_PAGES)("%s", (page) => {
    for (const a of parse(page).querySelectorAll("#nav-services a")) {
      const label = a.textContent.trim();
      if (TARGETS[label]) expect(a.getAttribute("href"), label).toBe(TARGETS[label]);
    }
  });
});

describe("services dropdown links each vertical to its own page", () => {
  const EXPECTED = {
    Office: "office-cleaning-gold-coast.html",
    "Strata & body corporate": "strata-cleaning-gold-coast.html",
    School: "school-cleaning-gold-coast.html",
    Childcare: "childcare-cleaning-gold-coast.html",
    "Medical centre": "medical-centre-cleaning-gold-coast.html",
    "Warehouse & industrial": "warehouse-industrial-cleaning-gold-coast.html",
  };
  for (const page of LANDING_PAGES) {
    it(`${page} dropdown labels point at their own pages`, () => {
      const links = [...parse(page).querySelectorAll("#nav-services a")];
      const got = Object.fromEntries(links.map((a) => [a.textContent.trim(), a.getAttribute("href")]));
      for (const [label, href] of Object.entries(EXPECTED)) {
        if (ALL_PAGES.includes(href)) expect(got[label], `${label} link on ${page}`).toBe(href);
      }
    });
  }
});
