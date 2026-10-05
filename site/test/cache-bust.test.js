import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { bustHtml, bustJs, bustSite } from "../scripts/cache-bust.mjs";

describe("bustHtml", () => {
  it("adds the version to local stylesheet and script URLs", () => {
    const html = `<link rel="stylesheet" href="assets/css/style.css">
<script type="module" src="assets/js/booking-gate.js"></script>`;
    expect(bustHtml(html, "abc123")).toBe(`<link rel="stylesheet" href="assets/css/style.css?v=abc123">
<script type="module" src="assets/js/booking-gate.js?v=abc123"></script>`);
  });

  it("leaves external scripts, links and images alone", () => {
    const html = `<script src="https://link.msgsndr.com/js/form_embed.js"></script>
<a href="contact.html">Contact</a><img src="assets/img/logo.svg">`;
    expect(bustHtml(html, "abc123")).toBe(html);
  });

  it("replaces an existing version instead of stacking a second one", () => {
    expect(bustHtml(`<script src="assets/js/main.js?v=old"></script>`, "new")).toBe(
      `<script src="assets/js/main.js?v=new"></script>`
    );
  });
});

describe("bustJs", () => {
  it("versions relative module imports so they match the page's version", () => {
    expect(bustJs(`import { readUtms } from "./utm.js";`, "abc123")).toBe(
      `import { readUtms } from "./utm.js?v=abc123";`
    );
  });

  it("leaves bare and absolute imports alone", () => {
    const js = `import x from "https://cdn.example.com/x.js";\nimport y from "y";`;
    expect(bustJs(js, "abc123")).toBe(js);
  });
});

describe("bustSite on the real site", () => {
  const copies = [];
  afterAll(() => copies.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function copyOfSite() {
    const dir = mkdtempSync(join(tmpdir(), "cache-bust-"));
    copies.push(dir);
    cpSync(resolve(__dirname, ".."), dir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules") && !src.includes("/branding"), // branding holds large client PDFs the test does not need
    });
    return dir;
  }

  it("versions every local CSS/JS reference on every page", () => {
    const dir = copyOfSite();
    bustSite(dir, "deadbeef");
    const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) {
      const html = readFileSync(join(dir, page), "utf8");
      const refs = html.match(/(?:href|src)="assets\/[^"]+\.(?:css|js)[^"]*"/g) || [];
      for (const ref of refs) expect(ref, `${page}: ${ref}`).toMatch(/\?v=deadbeef"$/);
    }
  });

  it("versions booking-gate.js's import of utm.js", () => {
    const dir = copyOfSite();
    bustSite(dir, "deadbeef");
    expect(readFileSync(join(dir, "assets/js/booking-gate.js"), "utf8")).toContain(`from "./utm.js?v=deadbeef"`);
  });

  it("refuses to run without a version", () => {
    expect(() => bustSite(copyOfSite(), "")).toThrow(/version/);
  });
});
