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

  it("has four founder-area photo slots, each a temp image; boys' alt says from behind", () => {
    const slots = Array.from(doc.querySelectorAll(".founder-section .image-slot"));
    expect(slots).toHaveLength(4);
    for (const s of slots) {
      const img = s.querySelector("img[data-temp-image]");
      expect(img).not.toBeNull();
      expect(img.getAttribute("src")).toMatch(/-temp\.svg$/);
      expect(img.getAttribute("alt").trim()).not.toBe("");
      expect(s.textContent).not.toMatch(/to be added/i);
    }
    expect(slots[1].querySelector("img").getAttribute("alt")).toMatch(/from behind/i);
  });

  it("Local families slot holds a temp image with alt text", () => {
    const img = doc.querySelector(".people-section .image-slot img[data-temp-image]");
    expect(img.getAttribute("src")).toMatch(/-temp\.svg$/);
    expect(img.getAttribute("alt").trim()).not.toBe("");
    expect(doc.body.textContent).not.toMatch(/to be added/i);
  });

  it("hero details line has Pty Ltd, the ABN linked to ABN Lookup, Reedy Creek and a tel: link", () => {
    const details = doc.querySelector(".page-hero .hero-details");
    expect(details.textContent).toContain("Pty Ltd");
    expect(details.textContent).toContain("ABN 89 700 018 775");
    expect(details.querySelector('a[href="https://abr.business.gov.au/ABN/View?abn=89700018775"]')).not.toBeNull();
    expect(details.textContent).toContain("Reedy Creek");
    expect(details.querySelector('a[href^="tel:"]')).not.toBeNull();
  });

  it("hero sectors line links each service anchor", () => {
    const links = Array.from(doc.querySelectorAll(".page-hero .hero-sectors a"), (a) => a.getAttribute("href"));
    expect(links).toEqual(["offices", "strata", "education", "medical", "industrial"].map((k) => `services.html#${k}`));
  });

  it("every About image is a photo-needed card that names its shot-list code", () => {
    const imgs = Array.from(doc.querySelectorAll("img[data-temp-image]"));
    expect(imgs).toHaveLength(6);
    const codes = imgs.map((img) => {
      expect(img.getAttribute("alt")).toMatch(/^Photo placeholder: /);
      const svg = readFileSync(resolve(__dirname, "..", img.getAttribute("src")), "utf8");
      expect(svg).toContain("PHOTO NEEDED");
      return svg.match(/PHOTO NEEDED · ([AB]\d)/)[1];
    });
    expect(codes).toEqual(["A1", "A2", "B1", "A3", "B2", "B3"]);
    const shots = readFileSync(resolve(__dirname, "..", "..", "docs/about-why-us/shot-list.md"), "utf8");
    for (const c of codes) expect(shots).toContain(`| ${c} |`);
  });

  it("How we work section mentions amaysim", () => {
    const s = Array.from(doc.querySelectorAll("section")).find((x) => x.querySelector(".eyebrow")?.textContent === "How we work");
    expect(s.textContent).toContain("amaysim");
  });

  it("has no police checked, inspection records or culture-scheme words", () => {
    expect(text).not.toMatch(/police checked/i);
    expect(text).not.toMatch(/inspection records/i);
    expect(text).not.toMatch(/bonus|leaderboard|championship|ranked|scored/i);
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

describe("about.html lower half", () => {
  it("keeps section order (D5): hero, story sections in order, founder CTA last", () => {
    const sections = Array.from(doc.querySelectorAll("body > section"));
    expect(sections[0].classList.contains("page-hero")).toBe(true);
    expect(sections.at(-1).classList.contains("final-cta")).toBe(true);
    expect(sections.at(-1).textContent).toContain("Talk to the Founder");
    const eyebrows = Array.from(doc.querySelectorAll("body > section:not(.page-hero):not([hidden]) .eyebrow"), (e) => e.textContent.trim());
    expect(eyebrows).toEqual(["Founder", "In Blake's words", "How we work", "Our standard", "What we stand for", "Local families", "Paperwork", "Partner with us"]);
  });

  it("keeps the Local families text out of the photo placeholder", () => {
    const slot = doc.querySelector(".people-section .image-slot");
    expect(slot.querySelector("h2, a[href='career.html']")).toBeNull();
  });

  it("lays the single Our standard image in one column, not half of a two-column grid", () => {
    const css = readFileSync(resolve(__dirname, "..", "assets/css/style.css"), "utf8");
    expect(css).toMatch(/\.standard-section \.process-wrap\s*\{[^}]*grid-template-columns:\s*1fr/);
    const slots = doc.querySelectorAll(".standard-section .process-wrap > *");
    expect(slots).toHaveLength(1);
  });

  it("styles the founder pull quotes and eyebrow (not browser defaults)", () => {
    const css = readFileSync(resolve(__dirname, "..", "assets/css/style.css"), "utf8");
    expect(css).toMatch(/\.founder-section blockquote\s*\{/);
    expect(css).toMatch(/\.founder-section \.eyebrow\s*\{/);
  });

  const section = (eyebrow) =>
    Array.from(doc.querySelectorAll("section")).find((s) => s.querySelector(".eyebrow")?.textContent === eyebrow);

  it("local families links careers and mentions award rates", () => {
    const s = section("Local families");
    expect(s.querySelector('a[href="career.html"]')).not.toBeNull();
    expect(s.textContent).toMatch(/award-equivalent rates/i);
  });

  it("Paperwork copy: $20M cover and certificate, ABN with lookup link, guarantee link; no insurer or memberships", () => {
    const s = section("Paperwork");
    expect(s.textContent).toContain("$20 million public liability");
    expect(s.textContent).toContain("certificate of currency");
    expect(s.textContent).toContain("ABN 89 700 018 775");
    expect(s.querySelector('a[href="https://abr.business.gov.au/ABN/View?abn=89700018775"]')).not.toBeNull();
    expect(s.querySelector('a[href="why-us.html#proof-guarantee"]')).not.toBeNull();
    expect(s.textContent).not.toMatch(/re-clean|credit/i);
    expect(s.textContent).not.toMatch(/member|insurer|QBE|Allianz|CGU|WHS/i);
  });

  it("people, then hidden Team and Clients, then Paperwork and Partner", () => {
    const team = doc.querySelector("section#team");
    expect(team.hasAttribute("hidden")).toBe(team.querySelectorAll(".team-entry").length === 0);
    const clients = doc.querySelector("section#clients");
    expect(clients.hasAttribute("hidden")).toBe(clients.querySelectorAll(".client-entry").length === 0);
    const order = Array.from(doc.querySelectorAll("body > section")).map((x) => x.id === "team" ? "Team" : x.id === "clients" ? "Clients" : x.querySelector(".eyebrow")?.textContent);
    expect(order.indexOf("Team")).toBe(order.indexOf("Local families") + 1);
    expect(order.indexOf("Clients")).toBe(order.indexOf("Team") + 1);
    expect(order.indexOf("Paperwork")).toBe(order.indexOf("Clients") + 1);
    expect(order.indexOf("Partner with us")).toBe(order.indexOf("Paperwork") + 1);
  });

  it("final CTA states the same-day call-back", () => {
    expect(doc.querySelector(".final-cta .cta-callback").textContent).toBe("Enquire by 5pm on a business day and we'll call you back the same day.");
  });

  it("partner block links contact, names audiences, no money", () => {
    const s = section("Partner with us");
    expect(s.querySelector('a[href="contact.html"]')).not.toBeNull();
    expect(s.textContent).toMatch(/strata managers/i);
    expect(s.textContent).toMatch(/real estate agents/i);
    expect(s.textContent).not.toMatch(/\$|reward/i);
  });

  it("Our standard section: copy, no figures, own section with one temp image", () => {
    const s = section("Our standard");
    expect(s.querySelector("h2").textContent).toContain("done properly");
    expect(s.textContent).toContain("young, local business");
    expect(s.textContent).not.toMatch(/\d/);
    expect(s.textContent).not.toMatch(/personally (read|check)/i);
    expect(s.classList.contains("founder-section")).toBe(false);
    const imgs = s.querySelectorAll("img[data-temp-image]");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("alt")).toBeTruthy();
  });

  it("drops the old boutique heading", () => {
    expect(html).not.toContain("Fewer clients, not less care");
  });
});
