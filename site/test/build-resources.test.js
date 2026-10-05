import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parseFrontmatter, mdToHtml, loadPages, lint, buildOutputs, writeOutputs, diffOutputs, syncRobots,
} from "../scripts/build-resources.mjs";
import { bustHtml } from "../scripts/cache-bust.mjs";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filler = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
let seq = 0;
const page = (fm, body = "") => `---\n${Object.entries({ description: `Description ${++seq} that is comfortably long enough to satisfy the seventy character minimum rule.`, ...fm }).map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`).join("\n")}\n---\n${body}`;
const live = { status: "published", published: "2026-01-01", updated: "2026-01-01" };

let site, content;
function put(rel, text) { const f = join(content, "resources", rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "res-"));
  site = join(root, "site"); content = join(root, "content");
  mkdirSync(site); mkdirSync(content);
  writeFileSync(join(site, "why-us.html"), `<header class="site-header"><a href="index.html" class="active">Home</a></header><footer class="site-footer"><a href="about.html">About</a><a href="tel:0756512257">call</a></footer>`);
  writeFileSync(join(site, "robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: https://x.test/sitemap.xml\n");
  writeFileSync(join(content, "site.json"), JSON.stringify(JSON.parse(readFileSync(join(SITE, "..", "content", "site.json"), "utf8"))));
});

describe("parseFrontmatter / mdToHtml", () => {
  it("reads scalars and lists", () => {
    const { data, body } = parseFrontmatter(`---\ntitle: "Hi: there"\nsources:\n  - A | https://a.test\n---\nBody`);
    expect(data).toEqual({ title: "Hi: there", sources: ["A | https://a.test"] });
    expect(body).toBe("Body");
  });
  it("renders headings with anchors, lists, tables, links and escapes html", () => {
    const { html, headings } = mdToHtml("## Why <b>it</b> matters\n\nText with [a link](/x/) and **bold**.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n");
    expect(headings).toEqual([{ id: "why-it-matters", text: "Why <b>it</b> matters" }]);
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain('<a href="/x/">a link</a>');
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain('<th scope="col">A</th>');
  });
});

describe("loadPages", () => {
  it("derives url, depth, type and parent from the folder structure", () => {
    put("index.md", page({ title: "Hub" }));
    put("eco/index.md", page({ title: "Eco" }));
    put("eco/products/index.md", page({ title: "Products" }));
    put("eco/products/geca.md", page({ title: "GECA" }));
    const by = Object.fromEntries(loadPages(content).map((p) => [p.url, p]));
    expect(by["/resources/"]).toMatchObject({ depth: 0, type: "hub", parentUrl: null });
    expect(by["/resources/eco/"]).toMatchObject({ depth: 1, type: "pillar", parentUrl: "/resources/" });
    expect(by["/resources/eco/products/"]).toMatchObject({ depth: 2, type: "cluster", parentUrl: "/resources/eco/" });
    expect(by["/resources/eco/products/geca/"]).toMatchObject({ depth: 3, type: "spoke", parentUrl: "/resources/eco/products/" });
  });
});

describe("lint", () => {
  const run = () => lint(loadPages(content), { today: "2026-06-01" });
  it("accepts a well-formed published tree", () => {
    put("index.md", page({ title: "Hub", ...live }, filler(200)));
    put("eco/index.md", page({ title: "Eco", ...live }, `${filler(200)} [a](/resources/eco/a/) [b](/resources/eco/b/) [c](/services.html)`));
    put("eco/a.md", page({ title: "A", ...live }, `${filler(320)} [b](/resources/eco/b/) [eco](/resources/eco/) [c](/contact.html)`));
    put("eco/b.md", page({ title: "B", ...live }, `${filler(320)} [a](/resources/eco/a/) [eco](/resources/eco/) [c](/contact.html)`));
    expect(run().errors).toEqual([]);
  });
  it("flags a missing parent, broken link, H1, unsourced figure, banned claim and thin leaf", () => {
    put("index.md", page({ title: "Hub", ...live }, filler(200)));
    put("eco/orphan/leaf.md", page({ title: "Leaf", ...live }, `# H1\n\nSaves 40% and is chemical-free (and "guaranteed" in quotes is fine). [x](/resources/nope/)`));
    const errors = run().errors.join("\n");
    expect(errors).toMatch(/no parent page/);
    expect(errors).toMatch(/broken internal link \/resources\/nope\//);
    expect(errors).toMatch(/body contains an H1/);
    expect(errors).toMatch(/no `sources:`/);
    expect(errors).toMatch(/banned claim "chemical-free"/);
    expect(errors).toMatch(/thin content/);
  });
  it("only warns about quality gaps on drafts, but still errors on structure", () => {
    put("index.md", page({ title: "Hub", status: "draft" }, "short"));
    const r = run();
    expect(r.errors).toEqual([]);
  });
  it("blocks a published page under an unpublished parent or linking to a draft", () => {
    put("index.md", page({ title: "Hub", ...live }, filler(200)));
    put("eco/index.md", page({ title: "Eco", status: "draft" }, filler(200)));
    put("eco/a.md", page({ title: "A", ...live }, `${filler(320)} [h](/resources/eco/) [x](/resources/) [c](/contact.html)`));
    const errors = run().errors.join("\n");
    expect(errors).toMatch(/parent .* is not published/);
    expect(errors).toMatch(/links to unpublished page \/resources\/eco\//);
  });
  it("warns when a published page is overdue for review", () => {
    put("index.md", page({ title: "Hub", ...live, updated: "2024-01-01" }, filler(200)));
    expect(run().warnings.join("\n")).toMatch(/overdue for review/);
  });
});

describe("build", () => {
  function tree() {
    put("index.md", page({ title: "Resources hub", ...live }, filler(200)));
    put("eco/index.md", page({ title: "Eco-friendly cleaning", ...live }, filler(200)));
    put("eco/a.md", page({ title: "Guide A", ...live, sources: ["ABC | https://abc.test/x"] }, `## One\n\ntext\n\n## Two\n\ntext\n\n## Three\n\ntext`));
    put("draft.md", page({ title: "Not yet", status: "draft" }, "x"));
  }
  it("emits nested pages with canonical, breadcrumbs, absolute assets and no drafts", () => {
    tree();
    const { files } = buildOutputs(site, content);
    expect(Object.keys(files).sort()).toEqual(["resources/eco/a/index.html", "resources/eco/index.html", "resources/index.html", "robots.txt", "sitemap-resources.xml"]);
    const html = files["resources/eco/a/index.html"];
    expect(html).toContain('<link rel="canonical" href="https://www.vantagepointfacilityservices.com.au/resources/eco/a/">');
    expect(html).toContain('"@type": "BreadcrumbList"');
    expect(html).toContain('href="/assets/css/style.css"');
    expect(html).toContain('<a href="/index.html">Home</a>');
    expect(html).not.toContain('class="active"');
    expect(html).toContain('href="https://abc.test/x"');
    expect(html).toContain('class="res-toc"');
    expect(files["sitemap-resources.xml"]).not.toContain("draft");
    expect(files["robots.txt"]).toContain("Sitemap: https://www.vantagepointfacilityservices.com.au/sitemap-resources.xml");
  });
  it("--check detects stale output and is clean after a write", () => {
    tree();
    const { files } = buildOutputs(site, content);
    expect(diffOutputs(site, files).length).toBeGreaterThan(0);
    writeOutputs(site, files);
    expect(diffOutputs(site, files)).toEqual([]);
    put("eco/a.md", page({ title: "Guide A", status: "draft" }, "x"));
    const next = buildOutputs(site, content).files;
    expect(diffOutputs(site, next)).toContain("resources/eco/a/index.html (no source)");
  });
  it("adds the sitemap line to robots.txt only while there are published pages", () => {
    const cfg = { origin: "https://o.test" };
    expect(syncRobots("a\n", cfg, true)).toBe("a\nSitemap: https://o.test/sitemap-resources.xml\n");
    expect(syncRobots("a\nSitemap: https://o.test/sitemap-resources.xml\n", cfg, false)).toBe("a\n");
  });
});

describe("real content", () => {
  it("lints clean and is already built into site/resources", () => {
    const { files, pages, config } = buildOutputs(SITE, resolve(SITE, "..", "content"));
    expect(lint(pages, { reviewMonths: config.reviewMonths }).errors).toEqual([]);
    expect(diffOutputs(SITE, files)).toEqual([]);
  });
});

describe("cache busting nested pages", () => {
  it("versions root-absolute asset URLs used by /resources/ pages", () => {
    expect(bustHtml(`<link href="/assets/css/resources.css">`, "v1")).toBe(`<link href="/assets/css/resources.css?v=v1">`);
  });
});
