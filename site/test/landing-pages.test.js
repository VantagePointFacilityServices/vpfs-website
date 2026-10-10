import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// SEO + claims guard rails for the vertical/precinct landing pages
// (.scratch/vertical-landing-pages/PRD.md, "Testing Decisions"). Landing pages
// are discovered by <body data-page-type="landing">, so adding a page never
// means editing a list here.
const SITE = resolve(__dirname, "..");
const ORIGIN = "https://www.vantagepointfacilityservices.com.au";
const isRedirect = (html) => /<meta http-equiv="refresh"/.test(html); // moved-page stubs carry no header/footer
const ALL_PAGES = readdirSync(SITE).filter((f) => f.endsWith(".html") && !isRedirect(readFileSync(resolve(SITE, f), "utf8")));
const read = (page) => readFileSync(resolve(SITE, page), "utf8");
const parse = (page) => new DOMParser().parseFromString(read(page), "text/html");

const LANDING_PAGES = ALL_PAGES.filter((p) => parse(p).body.dataset.pageType === "landing");
// cleaning-by-site-type.html is the hub for the landing pages (in the sitemap; no longer linked from services.html):
// held to the same SEO checks, but it carries no landing marker or Service schema.
// services.html is the original tabbed scope page and is not part of this set.
const SEO_PAGES = [...LANDING_PAGES, "cleaning-by-site-type.html"];


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
  it("uses the medical conversion page, default facility type and CTA", () => {
    const doc = parse(page);
    expect(doc.querySelector("form.assessment-form").dataset.conversionPage).toBe("website-lp-medical");
    expect(doc.querySelector("select[name=facility_type] option[selected]").value).toBe("medical");
    expect(doc.querySelector("form.assessment-form button[type=submit]").textContent.trim()).toBe("Request a Facility Consultation");
  });
});

describe("landing page discovery", () => {
  it("finds at least the office landing page", () => {
    expect(LANDING_PAGES).toContain("office-cleaning-gold-coast.html");
  });
});

describe.each(ALL_PAGES)("%s title/description uniqueness", (page) => {
  it("has a title and description no other site/*.html page shares", () => {
    const others = ALL_PAGES.filter((p) => p !== page);
    expect(others.filter((p) => titleOf(p) === titleOf(page)), "duplicate title").toEqual([]);
    expect(others.filter((p) => descOf(p) === descOf(page)), "duplicate description").toEqual([]);
  });
});

describe.each(SEO_PAGES)("%s on-page SEO", (page) => {
  const isLanding = LANDING_PAGES.includes(page);

  it("has a title and meta description", () => {
    expect(titleOf(page)).not.toBe("");
    expect(descOf(page)).not.toBe("");
  });

  it("has a self-referencing canonical", () => {
    expect(parse(page).querySelector('link[rel="canonical"]')?.href).toBe(`${ORIGIN}/${page}`);
  });

  it("has exactly one non-empty hard-coded <h1>", () => {
    {
      const h1s = parse(page).querySelectorAll("h1");
      expect(h1s.length).toBe(1);
      expect(h1s[0].textContent.trim()).not.toBe("");
    }
  });

  it("has JSON-LD that parses and uses no banned types", () => {
    const types = typesIn(jsonLd(page));
    for (const banned of ["FAQPage", "HowTo", "AggregateRating", "Review"]) {
      expect(types).not.toContain(banned);
    }
  });

  it("has an alt, width and height on every image, and no inline background-image", () => {
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
  });

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

  it("keeps the hero text-and-form only (same height as the homepage hero) and lazy-loads every image", () => {
    const imgs = Array.from(parse(page).querySelectorAll("main img, body > section img, body > nav img")).filter(
      (i) => !i.closest("header") && !i.closest("footer"),
    );
    expect(imgs.find((i) => i.closest(".hero-grid")), "hero image").toBeUndefined();
    for (const img of imgs) {
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
// page -> banned patterns (as source strings) tolerated. services.html is the restored
// tabbed scope page, which still carries the clinical lines the landing pages dropped (its Eco products badge is gone).
const LEGACY_ALLOW = { "services.html": ["clinical-grade", "sharps"] };

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
  it("has the warehouse conversion page, construction default and Industrial in title", () => {
    expect(doc.body.dataset.pageKey).toBe("warehouse");
    expect(doc.querySelector("form.assessment-form").dataset.conversionPage).toBe("website-lp-warehouse");
    expect(doc.querySelector('option[value="construction"]').selected).toBe(true);
    expect(doc.title).toMatch(/Industrial/);
    expect(doc.querySelector("h1").textContent.trim()).toBe("Warehouse Cleaning Gold Coast");
    expect(doc.body.textContent).not.toMatch(/post-construction|construction site/i);
  });
});

describe("site-wide navigation", () => {
  const VERTICALS = [
    "office-cleaning-gold-coast.html", "strata-cleaning-gold-coast.html", "school-cleaning-gold-coast.html",
    "childcare-cleaning-gold-coast.html", "medical-centre-cleaning-gold-coast.html", "warehouse-industrial-cleaning-gold-coast.html",
  ];
  const ANCHORS = ["offices", "strata", "education", "medical", "industrial"].map((a) => "services.html#" + a);
  const hrefs = (nodes) => Array.from(nodes, (a) => a.getAttribute("href"));
  describe.each(ALL_PAGES)("%s", (page) => {
    const doc = parse(page);
    it("header dropdown links the five services.html anchors", () => {
      expect(hrefs(doc.querySelectorAll("#nav-services a"))).toEqual(ANCHORS);
    });
    it("header nav does not link Resources", () => {
      expect(hrefs(doc.querySelectorAll("header a"))).not.toContain("/resources/");
    });
    it("footer keeps Resources, disabled and hidden until the pages are refined", () => {
      expect(hrefs(doc.querySelectorAll("footer a"))).not.toContain("/resources/");
      const a = doc.querySelector('footer a[data-href="/resources/"]');
      expect(a).not.toBeNull();
      expect(a.closest("li").hasAttribute("hidden")).toBe(true);
    });
    it("footer Company lists Why us, About us, Locations, Contact, Careers, Resources, with Why us, About us and Resources hidden and unlinked", () => {
      const items = Array.from(doc.querySelectorAll("footer h4 + ul")).find((ul) => ul.previousElementSibling.textContent === "Company").querySelectorAll("li");
      expect(Array.from(items, (li) => li.textContent.trim())).toEqual(["Why us", "About us", "Locations", "Contact", "Careers", "Resources"]);
      const hidden = Array.from(items).filter((li) => li.hasAttribute("hidden"));
      expect(hidden.map((li) => li.textContent.trim())).toEqual(["Why us", "About us", "Resources"]);
      expect(hidden.every((li) => !li.querySelector("a").hasAttribute("href"))).toBe(true);
    });
    it("header nav hides the About link and does not link about.html", () => {
      const about = Array.from(doc.querySelectorAll("header a")).find((a) => a.textContent.trim() === "About");
      expect(about.hasAttribute("hidden")).toBe(true);
      expect(about.hasAttribute("href")).toBe(false);
      expect(hrefs(doc.querySelectorAll("header a, footer a"))).not.toContain("about.html");
    });
    it("header nav is Home, Services, About (hidden), Contact; no Locations dropdown", () => {
      const top = Array.from(doc.querySelectorAll(".main-nav > a, .main-nav > .nav-item > a"), (a) => a.textContent.trim());
      expect(top).toEqual(["Home", "Services", "About", "Contact"]);
      expect(doc.querySelector("#nav-locations")).toBeNull();
    });
  });
  it("about.html is noindex and out of the sitemap until the page is complete", () => {
    expect(read("about.html")).toContain('<meta name="robots" content="noindex">');
    expect(sitemap).not.toContain(`${ORIGIN}/about.html`);
  });
  it("cleaning-by-site-type.html stays in the sitemap (no page body links it since the Services link was removed)", () => {
    expect(readFileSync(resolve(SITE, "sitemap.xml"), "utf8")).toContain(ORIGIN + "/cleaning-by-site-type.html");
  });
  it("services.html heads the scope tabs with the Services eyebrow", () => {
    const head = parse("services.html").querySelector(".scope-detail-section .section-head");
    expect(head.querySelector(".eyebrow").textContent).toBe("Services");
    expect(head.nextElementSibling.matches(".tabs-nav")).toBe(true);
  });
  it("services.html has one sector image per scope tab, office shown by default", () => {
    const doc = parse("services.html");
    const tabs = Array.from(doc.querySelectorAll(".tabs-nav button"), (b) => b.dataset.tab);
    const imgs = Array.from(doc.querySelectorAll(".scope-image img[data-tab-image]"));
    expect(imgs.map((i) => i.dataset.tabImage)).toEqual(tabs);
    expect(imgs.filter((i) => !i.hasAttribute("hidden")).map((i) => i.dataset.tabImage)).toEqual(["offices"]);
    expect(imgs.every((i) => i.getAttribute("alt"))).toBe(true);
  });
  it("locations.html h1 defaults to Gold Coast and its default names a region group", () => {
    const doc = parse("locations.html");
    const h1 = doc.querySelector("h1[data-location-h1]");
    expect(h1.textContent).toBe("Commercial Cleaning for Gold Coast Business");
    const group = doc.getElementById(h1.dataset.locationH1);
    expect(group.classList.contains("region-group")).toBe(true);
    expect(group.querySelector(".region-group-title").textContent).toBe("Gold Coast");
  });
  it("services.html places How we clean directly above the FAQ", () => {
    const section = parse("services.html").querySelector(".how-we-clean-section");
    expect(section.querySelectorAll(".commitment-card").length).toBe(4);
    expect(section.nextElementSibling.matches(".faq-section")).toBe(true);
  });
  it("cleaning-by-site-type.html links every vertical page from its body", () => {
    expect(hrefs(parse("cleaning-by-site-type.html").querySelectorAll("main a, body > section a"))).toEqual(expect.arrayContaining(VERTICALS));
  });
  it("cleaning-by-site-type.html has no eco badge or clinical claims", () => {
    expect(visibleText("cleaning-by-site-type.html")).not.toMatch(/eco products|clinical-grade|sharps/i);
  });
});

describe("JSON-LD string values", () => {
  const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
  it.each(LANDING_PAGES)("%s has no HTML-escaped &amp; in JSON-LD", (page) => {
    for (const s of strings(jsonLd(page))) expect(s).not.toContain("&amp;");
  });
});

// ---- Precinct pages (PRD D5) ----------------------------------------------
// Precinct pages are discovered by filename so issue 08 can add its pages
// without editing this block.
const PRECINCT_PAGES = LANDING_PAGES.filter((p) => p.startsWith("commercial-cleaning-"));
const VERTICAL_PAGES = [
  "office-cleaning-gold-coast.html", "strata-cleaning-gold-coast.html", "school-cleaning-gold-coast.html",
  "childcare-cleaning-gold-coast.html", "medical-centre-cleaning-gold-coast.html", "warehouse-industrial-cleaning-gold-coast.html",
];

// Main-content sentences of a precinct page, minus the shared chrome, the form,
// and the quality/trust block marked data-boilerplate.
function precinctSentences(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, header, footer, form, nav, [data-boilerplate]").forEach((n) => n.remove());
  const text = doc.body.textContent.replace(/\s+/g, " ");
  return new Set(text.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 25));
}
function sharedRatio(a, b) {
  const shared = [...a].filter((s) => b.has(s)).length;
  return shared / Math.min(a.size, b.size);
}
const SIMILARITY_LIMIT = 0.25;

describe("precinct pages", () => {
  it("discovers the central precinct pages", () => {
    for (const p of ["commercial-cleaning-southport.html", "commercial-cleaning-bundall.html", "commercial-cleaning-surfers-paradise-broadbeach.html"]) {
      expect(PRECINCT_PAGES).toContain(p);
    }
  });

  describe.each(PRECINCT_PAGES)("%s", (page) => {
    const doc = parse(page);
    it("has a precinct H1, website-lp conversion page and no pre-selected facility type", () => {
      expect(doc.querySelector("h1").textContent.trim()).toMatch(/^Commercial Cleaning /);
      expect(doc.querySelector("form.assessment-form").dataset.conversionPage).toBe(`website-lp-${doc.body.dataset.pageKey}`);
      expect(doc.querySelector("select[name=facility_type] option[selected]")).toBeNull();
    });
    it("links all six vertical pages and locations.html from the page body", () => {
      const body = Array.from(doc.querySelectorAll("body > section a, main a"), (a) => a.getAttribute("href"));
      for (const v of [...VERTICAL_PAGES, "locations.html"]) expect(body, v).toContain(v);
    });
    it("records at least four sourced facts as URLs in a foot comment", () => {
      const html = read(page);
      const comment = html.slice(html.lastIndexOf("<!--"), html.lastIndexOf("</body>"));
      const facts = comment.match(/^Fact \d+ .*https?:\/\/\S+/gm) || [];
      expect(facts.length).toBeGreaterThanOrEqual(4);
    });
    it("makes no response-time promises", () => {
      expect(visibleText(page)).not.toMatch(/within \d+ ?(minutes?|hours?)|same[- ]day|24\/7|\bASAP\b|within the hour|next[- ]day/i);
    });
    it("has Breadcrumb Home > Locations > precinct and Service areaServed", () => {
      const ld = jsonLd(page);
      const crumbs = ld.find((b) => b["@type"] === "BreadcrumbList").itemListElement.map((i) => i.name);
      expect(crumbs[0]).toBe("Home");
      expect(crumbs[1]).toBe("Locations");
      const svc = ld.find((b) => b["@type"] === "Service");
      expect([].concat(svc.areaServed).length).toBeGreaterThan(0);
    });
  });

  describe("distinctness (no suburb-swap pages)", () => {
    it("keeps shared main-content sentences between any two precinct pages below the limit", () => {
      for (let i = 0; i < PRECINCT_PAGES.length; i++) {
        for (let j = i + 1; j < PRECINCT_PAGES.length; j++) {
          const r = sharedRatio(precinctSentences(read(PRECINCT_PAGES[i])), precinctSentences(read(PRECINCT_PAGES[j])));
          expect(r, `${PRECINCT_PAGES[i]} vs ${PRECINCT_PAGES[j]}`).toBeLessThan(SIMILARITY_LIMIT);
        }
      }
    });
    it("fails a suburb-swap copy of a precinct page", () => {
      const [first] = PRECINCT_PAGES;
      const html = read(first);
      const swapped = html.replace(/Southport|Bundall/g, "Elsewhere");
      expect(sharedRatio(precinctSentences(html), precinctSentences(swapped))).toBeGreaterThanOrEqual(SIMILARITY_LIMIT);
    });
  });
});

describe("service-areas.html (moved to locations.html)", () => {
  const html = readFileSync(resolve(SITE, "service-areas.html"), "utf8");
  it("redirects to locations.html, keeping the hash, and is not indexed", () => {
    expect(html).toContain('<meta http-equiv="refresh" content="0; url=locations.html">');
    expect(html).toContain('location.replace("locations.html" + location.search + location.hash)');
    expect(html).toContain('<link rel="canonical" href="https://www.vantagepointfacilityservices.com.au/locations.html">');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});
