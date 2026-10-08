import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { resolve, join, relative } from "path";

const SITE_DIR = resolve(__dirname, "..");
const read = (rel) => readFileSync(resolve(SITE_DIR, rel), "utf8");

// Every .html page under site/ (including generated resources/**), discovered
// from the directory so a new page is covered without editing this file.
// Later legal-page issues extend this helper.
export function discoverPages(dir = SITE_DIR) {
  const pages = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) pages.push(...discoverPages(full));
    else if (name.endsWith(".html")) pages.push(relative(SITE_DIR, full));
  }
  return pages.sort();
}

const PAGES = discoverPages();

function footerLink(html, label) {
  const footer = html.match(/<footer class="site-footer">[\s\S]*?<\/footer>/);
  if (!footer) return null;
  const m = footer[0].match(new RegExp(`<a href="([^"]*)">${label}</a>`));
  return m && m[1];
}

describe("privacy page", () => {
  it("exists", () => {
    expect(existsSync(resolve(SITE_DIR, "privacy.html"))).toBe(true);
  });

  it("shows the company details, contact and version line", () => {
    const html = read("privacy.html");
    for (const s of [
      "Vantage Point Facility Services Pty Ltd",
      "ACN 700 018 775",
      "ABN 89 700 018 775",
      "blake@vantagepointfacilityservices.com",
      "Last updated:</strong> 8 October 2026 · Version 1.0",
    ].map((x) => x.replace("</strong>", ""))) {
      expect(html.replace(/<\/?strong>/g, "")).toContain(s);
    }
  });

  it("carries no draft banner or review notes", () => {
    const html = read("privacy.html");
    expect(html).not.toMatch(/pending review|Lawpath|DRAFT|interim/i);
  });

  it("has title, description, canonical URL and an id anchor per section", () => {
    const html = read("privacy.html");
    expect(html).toMatch(/<title>Privacy Policy \|/);
    expect(html).toMatch(/<meta name="description" content="[^"]+"/);
    expect(html).toContain('<link rel="canonical" href="https://www.vantagepointfacilityservices.com.au/privacy.html">');
    expect(html.match(/<h2 id="[a-z0-9-]+">/g)).toHaveLength(11);
  });

  it("is listed in the sitemap", () => {
    expect(read("sitemap.xml")).toContain("<loc>https://www.vantagepointfacilityservices.com.au/privacy.html</loc>");
  });
});

describe.each(PAGES)("%s footer", (page) => {
  it("links Privacy to the privacy page, not #", () => {
    const href = footerLink(read(page), "Privacy");
    expect(href, "Privacy link").not.toBeNull();
    expect(href).not.toBe("#");
    expect(href).toMatch(/^\/?privacy\.html$/);
  });
});

describe("terms page", () => {
  const html = () => read("terms.html");
  const text = () => html().replace(/<\/?strong>/g, "");

  it("exists and shows the company details and version line", () => {
    expect(existsSync(resolve(SITE_DIR, "terms.html"))).toBe(true);
    for (const s of [
      "Vantage Point Facility Services Pty Ltd",
      "ACN 700 018 775",
      "ABN 89 700 018 775",
      "Last updated: 8 October 2026 · Version 1.0",
    ]) {
      expect(text()).toContain(s);
    }
  });

  it("carries no draft banner or review notes", () => {
    expect(html()).not.toMatch(/pending review|Lawpath|DRAFT|interim/i);
  });

  it("links to the privacy page and ends with the service terms section", () => {
    expect(html()).toContain('<a href="/privacy.html">Privacy Policy</a>');
    expect(html()).toContain('<h2 id="service-terms">Service terms</h2>');
    const headings = html().match(/<h2 id="[a-z0-9-]+">/g);
    expect(headings.at(-1)).toBe('<h2 id="service-terms">');
  });

  it("has title, description and canonical URL", () => {
    expect(html()).toMatch(/<title>Website Terms of Use \|/);
    expect(html()).toMatch(/<meta name="description" content="[^"]+"/);
    expect(html()).toContain('<link rel="canonical" href="https://www.vantagepointfacilityservices.com.au/terms.html">');
  });

  it("is listed in the sitemap", () => {
    expect(read("sitemap.xml")).toContain("<loc>https://www.vantagepointfacilityservices.com.au/terms.html</loc>");
  });
});

describe.each(PAGES)("%s terms footer", (page) => {
  it("links Terms to the terms page, not #", () => {
    const href = footerLink(read(page), "Terms");
    expect(href, "Terms link").not.toBeNull();
    expect(href).not.toBe("#");
    expect(href).toMatch(/^\/?terms\.html$/);
  });
});
