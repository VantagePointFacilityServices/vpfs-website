// Resource-silo builder: content/resources/**/*.md  ->  site/resources/**/index.html
//
// The marketing site is plain static HTML with no build step; this script is the one exception,
// and it only owns site/resources/ (wiped and rewritten every run — never hand-edit it) plus
// site/sitemap-resources.xml and one Sitemap line in robots.txt. Generated output is committed,
// and CI runs `--check` so a content change that was not rebuilt fails the deploy.
//
// Folder = URL = hierarchy. content/resources/index.md is the hub; every folder's index.md is that
// level's hub page, every other .md is a leaf page below it. Depth 0 = hub, 1 = pillar (silo),
// 2 = cluster, 3+ = spoke (max depth 4). See .claude/skills/seo-silo-pages in the vpos repo.
//
// Usage:  node scripts/build-resources.mjs [--check] [--lint] [--report] [--today YYYY-MM-DD]
//   (default)  lint, then write site/resources/
//   --lint     lint only, write nothing
//   --check    lint, then fail if the committed output differs from a fresh build
//   --report   inventory by silo/status plus pages overdue for review

import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";

const MAX_DEPTH = 4;
const SOURCE_PATTERN = /\d\s?%|\$\s?\d|per cent|\bAct\s\d{4}|AS\/NZS|\bISO\s?\d{3,}|\bAS\s?\d{3,}/i;
// Absolute environmental/safety claims the ACCC treats as greenwashing risks, plus unprovable superlatives.
const BANNED_CLAIMS = [
  /100\s?%\s?(safe|natural|green|eco|organic)/i,
  /\bchemical[- ]free\b/i,
  /\bnon[- ]toxic\b/i,
  /\bzero (waste|impact|emissions)\b/i,
  /\bguarantee[sd]?\b/i,
  /\bworld[- ]class\b/i,
  /\bbest in (the )?(world|australia|class)\b/i,
];

// ---------- frontmatter + markdown ----------

export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    if (kv[2] === "") { data[kv[1]] = []; listKey = kv[1]; } else { data[kv[1]] = unquote(kv[2]); listKey = null; }
  }
  return { data, body: m[2] };
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const external = /^https?:\/\//.test(href);
    return `<a href="${href}"${external ? ' rel="noopener" target="_blank"' : ""}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return s;
}

// Markdown subset: ##/### headings, paragraphs, ul/ol, pipe tables, blockquotes, hr. Returns html + h2 list.
export function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [], headings = [];
  let i = 0;
  const startsBlock = (l) => /^(#{2,3} |>|\s*[-*] |\s*\d+\. |\||---+\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const h = line.match(/^(#{2,3}) (.*)$/);
    if (h) {
      const text = h[2].trim(), id = slugify(text), level = h[1].length;
      if (level === 2) headings.push({ id, text });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`); i++; continue;
    }
    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (line.startsWith(">")) {
      const q = []; while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`); continue;
    }
    if (/^\s*[-*] /.test(line) || /^\s*\d+\. /.test(line)) {
      const ordered = /^\s*\d+\. /.test(line), items = [];
      while (i < lines.length && (ordered ? /^\s*\d+\. /.test(lines[i]) : /^\s*[-*] /.test(lines[i]))) items.push(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`); continue;
    }
    if (line.startsWith("|")) {
      const rows = []; while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim());
      const head = cells(rows[0]), body = rows.slice(/^\|[\s:|-]+\|?\s*$/.test(rows[1] || "") ? 2 : 1).map(cells);
      out.push(`<div class="res-table-wrap"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`); continue;
    }
    const p = []; while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) p.push(lines[i++].trim());
    out.push(`<p>${inline(p.join(" "))}</p>`);
  }
  return { html: out.join("\n"), headings };
}

// ---------- content model ----------

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : []);
}

const TYPES = ["hub", "pillar", "cluster", "spoke"];

export function loadPages(contentDir) {
  const root = join(contentDir, "resources");
  if (!existsSync(root)) return [];
  return walk(root).map((file) => {
    const rel = relative(root, file).split(sep).join("/");
    const parts = rel.replace(/\.md$/, "").split("/");
    const isIndex = parts[parts.length - 1] === "index";
    const dirParts = isIndex ? parts.slice(0, -1) : parts;
    const url = "/resources/" + (dirParts.length ? dirParts.join("/") + "/" : "");
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const depth = dirParts.length;
    const parentParts = isIndex ? dirParts.slice(0, -1) : dirParts.slice(0, -1);
    const parentUrl = depth === 0 ? null : "/resources/" + (parentParts.length ? parentParts.join("/") + "/" : "");
    return { file: rel, url, depth, parentUrl, type: TYPES[Math.min(depth, 3)], isIndex, data, body, status: data.status || "draft" };
  }).sort((a, b) => a.url.localeCompare(b.url));
}

export const wordCount = (md) => md.replace(/[#>|*`\-\[\]()]/g, " ").split(/\s+/).filter(Boolean).length;
const monthsBetween = (a, b) => (new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30.44);

export function lint(pages, { today, reviewMonths = 12 } = {}) {
  const errors = [], warnings = [];
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const seenTitle = new Map(), seenDesc = new Map();
  for (const p of pages) {
    const live = p.status === "published";
    const err = (m) => errors.push(`${p.file}: ${m}`);
    const softOnDraft = (m) => (live ? err(m) : warnings.push(`${p.file}: (draft) ${m}`));
    const { title, description, updated, published } = p.data;
    if (!["draft", "published"].includes(p.status)) err(`status must be draft or published (got "${p.status}")`);
    if (!title) err("missing title"); else if (title.length > 65) err(`title is ${title.length} chars (max 65)`);
    if (!description) err("missing description"); else if (description.length < 70 || description.length > 160) err(`description is ${description.length} chars (want 70-160)`);
    if (live && !/^\d{4}-\d{2}-\d{2}$/.test(updated || "")) err("updated must be YYYY-MM-DD");
    if (live && !/^\d{4}-\d{2}-\d{2}$/.test(published || "")) err("published must be YYYY-MM-DD");
    if (p.depth > MAX_DEPTH) err(`depth ${p.depth} exceeds the maximum of ${MAX_DEPTH}`);
    if (/^# /m.test(p.body)) err("body contains an H1 — the title is the H1; start body headings at ##");
    if (title) { const k = title.toLowerCase(); if (seenTitle.has(k)) err(`duplicate title (also ${seenTitle.get(k)})`); seenTitle.set(k, p.file); }
    if (description) { const k = description.toLowerCase(); if (seenDesc.has(k)) err(`duplicate description (also ${seenDesc.get(k)})`); seenDesc.set(k, p.file); }

    if (p.parentUrl) {
      const parent = byUrl.get(p.parentUrl);
      if (!parent) err(`no parent page — expected ${p.parentUrl.replace("/resources/", "content/resources/")}index.md`);
      else if (live && parent.status !== "published") err(`parent ${parent.file} is not published`);
    }

    const links = [...p.body.matchAll(/\]\((\/[^)\s#]*)(?:#[^)\s]*)?\)/g)].map((m) => m[1]);
    for (const l of links.filter((x) => x.startsWith("/resources/"))) {
      const target = byUrl.get(l.endsWith("/") ? l : l + "/");
      if (!target) err(`broken internal link ${l}`);
      else if (live && target.status !== "published") err(`links to unpublished page ${l}`);
    }
    const contextual = new Set(links.filter((l) => l.startsWith("/resources/") && l !== p.url));
    if (p.depth >= 1 && contextual.size < 2) softOnDraft(`needs at least 2 contextual links to other resource pages (has ${contextual.size})`);
    if (p.depth >= 2 && !links.some((l) => !l.startsWith("/resources/"))) softOnDraft("needs a link to a money page (e.g. /services.html or /contact.html)");

    const words = wordCount(p.body);
    if (p.depth >= 1 && !p.isIndex && words < 300) softOnDraft(`thin content: ${words} words (min 300)`);
    if (p.depth >= 1 && p.isIndex && words < 150) softOnDraft(`hub intro too thin: ${words} words (min 150)`);
    if (SOURCE_PATTERN.test(p.body) && !(Array.isArray(p.data.sources) && p.data.sources.length)) softOnDraft("states a figure, percentage, price or standard but has no `sources:` — cite an official source or remove the claim");
    // Quoted phrases are being discussed (e.g. warning readers off "chemical-free"), not claimed.
    const claimable = `${p.body}\n${description || ""}`.replace(/"[^"\n]*"/g, "");
    for (const re of BANNED_CLAIMS) { const m = claimable.match(re); if (m) err(`banned claim "${m[0]}" (greenwashing/overclaim risk)`); }
    for (const s of p.data.sources || []) if (!/^.+\|\s*https?:\/\/\S+$/.test(s)) err(`source "${s}" must be "Name | https://url"`);

    if (live && today && updated && monthsBetween(updated, today) > reviewMonths) warnings.push(`${p.file}: last updated ${updated} — overdue for review (${reviewMonths} months)`);
  }
  const kids = new Map();
  for (const p of pages) if (p.parentUrl) kids.set(p.parentUrl, (kids.get(p.parentUrl) || 0) + 1);
  for (const [u, n] of kids) if (n > 12) warnings.push(`${u} has ${n} children — split into sub-clusters (max 12)`);
  return { errors, warnings };
}

// ---------- rendering ----------

export function loadShell(siteDir) {
  const src = readFileSync(join(siteDir, "why-us.html"), "utf8");
  const abs = (h) => h.replace(/\b(href|src)="(?!https?:|mailto:|tel:|#|\/|data:)([^"]*)"/g, '$1="/$2"').replace(/\sclass="active"/g, "");
  return {
    header: abs(src.match(/<header class="site-header">[\s\S]*?<\/header>/)[0]),
    footer: abs(src.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0]),
    scripts: '<script type="module" src="/assets/js/utm.js"></script>\n<script src="/assets/js/main.js"></script>',
  };
}

const fmtDate = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const label = (p) => p.data.nav_title || p.data.title;

function trail(p, byUrl) {
  const chain = []; for (let c = p; c; c = c.parentUrl ? byUrl.get(c.parentUrl) : null) chain.unshift(c);
  return chain;
}

function card(p) {
  return `<a class="res-card" href="${p.url}"><span class="res-card-kind">${p.isIndex ? "Topic" : "Guide"}</span><h3>${esc(label(p))}</h3><p>${esc(p.data.description)}</p></a>`;
}

export function renderPage(p, pages, config, shell) {
  const live = pages.filter((x) => x.status === "published");
  const byUrl = new Map(live.map((x) => [x.url, x]));
  const children = live.filter((x) => x.parentUrl === p.url).sort((a, b) => (Number(a.data.order) || 99) - (Number(b.data.order) || 99) || label(a).localeCompare(label(b)));
  const siblings = p.parentUrl ? live.filter((x) => x.parentUrl === p.parentUrl && x.url !== p.url).slice(0, 4) : [];
  const extra = (Array.isArray(p.data.related) ? p.data.related : []).map((u) => byUrl.get(u)).filter(Boolean);
  const related = [...new Map([...extra, ...siblings].map((x) => [x.url, x])).values()].slice(0, 4);
  const { html, headings } = mdToHtml(p.body);
  const origin = config.origin, abs = (u) => origin + u;
  const chain = trail(p, byUrl);
  const crumbs = [{ name: "Home", url: "/" }, ...chain.map((c) => ({ name: label(c), url: c.url }))];
  const silo = chain[1] || chain[0];
  const author = p.data.author || config.authorName;

  const ld = [{
    "@context": "https://schema.org",
    "@type": p.depth >= 3 || !p.isIndex ? "Article" : "CollectionPage",
    headline: p.data.title, description: p.data.description, url: abs(p.url), mainEntityOfPage: abs(p.url),
    datePublished: p.data.published, dateModified: p.data.updated, inLanguage: "en-AU",
    author: { "@type": "Organization", name: author, url: origin + "/" },
    publisher: { "@type": "Organization", name: config.siteName, url: origin + "/", logo: { "@type": "ImageObject", url: abs("/assets/img/logo-navy.svg") } },
    image: abs(config.ogImage),
  }, {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: abs(c.url) })),
  }].map((o) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2).replace(/</g, "\\u003c")}\n</script>`).join("\n");

  const toc = headings.length >= 3
    ? `<nav class="res-toc" aria-label="On this page"><h2>On this page</h2><ol>${headings.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join("")}</ol></nav>` : "";
  const kids = children.length
    ? `<section class="res-children" aria-labelledby="in-this-section"><h2 id="in-this-section">${p.depth === 0 ? "Browse by topic" : p.depth === 1 ? "In this guide" : "Read next"}</h2><div class="res-cards">${children.map(card).join("")}</div></section>` : "";
  const rel = related.length
    ? `<section class="res-children res-related" aria-labelledby="related-guides"><h2 id="related-guides">Related guides</h2><div class="res-cards">${related.map(card).join("")}</div></section>` : "";
  const sources = (p.data.sources || []).length
    ? `<section class="res-sources"><h2>Sources</h2><ul>${p.data.sources.map((s) => { const [n, u] = s.split(/\s*\|\s*/); return `<li><a href="${esc(u)}" rel="noopener" target="_blank">${esc(n)}</a></li>`; }).join("")}</ul></section>` : "";
  const cta = p.data.cta === "none" ? "" : `<section class="res-cta"><div class="wrap"><h2>${esc(config.ctaHeading)}</h2><p>${esc(config.ctaText)}</p><a class="btn btn-white" href="${config.ctaHref}">${esc(config.ctaLabel)}</a> <a class="btn btn-outline-white" href="tel:${config.phoneHref}">Call ${esc(config.phoneDisplay)}</a></div></section>`;
  const title = `${p.data.title}${p.depth === 0 ? "" : ` | ${config.siteName}`}`;

  return `<!DOCTYPE html>
<!-- GENERATED by site/scripts/build-resources.mjs from content/resources/${p.file} — edit the source, not this file. -->
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(p.data.description)}">
<link rel="canonical" href="${abs(p.url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(p.data.title)}">
<meta property="og:description" content="${esc(p.data.description)}">
<meta property="og:url" content="${abs(p.url)}">
<meta property="og:image" content="${abs(config.ogImage)}">
<meta property="og:locale" content="en_AU">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(p.data.title)}">
<meta name="twitter:description" content="${esc(p.data.description)}">
<meta name="twitter:image" content="${abs(config.ogImage)}">
<link rel="icon" type="image/svg+xml" href="/assets/img/mark-navy.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/style.css">
<link rel="stylesheet" href="/assets/css/resources.css">
${ld}
</head>
<body>
${shell.header}

<section class="res-hero">
  <div class="wrap">
    <nav class="res-breadcrumb" aria-label="Breadcrumb"><ol>${crumbs.map((c, i) => i === crumbs.length - 1 ? `<li aria-current="page">${esc(c.name)}</li>` : `<li><a href="${c.url}">${esc(c.name)}</a></li>`).join("")}</ol></nav>
    <span class="eyebrow">${esc(p.depth === 0 ? "Resources" : label(silo))}</span>
    <h1>${esc(p.data.title)}</h1>
    <p class="lead">${esc(p.data.description)}</p>
    ${p.data.published ? `<p class="res-meta">By ${esc(author)} &middot; Updated <time datetime="${p.data.updated}">${fmtDate(p.data.updated)}</time></p>` : ""}
  </div>
</section>

<section class="res-body">
  <div class="wrap res-layout">
    ${toc}
    <article class="res-prose">
${html}
    </article>
  </div>
  <div class="wrap res-after">
    ${kids}
    ${sources}
    ${rel}
  </div>
</section>

${cta}
${shell.footer}

${shell.scripts}
</body>
</html>
`;
}

export function renderSitemap(pages, config) {
  const urls = pages.filter((p) => p.status === "published").map((p) =>
    `  <url>\n    <loc>${config.origin}${p.url}</loc>\n    <lastmod>${p.data.updated}</lastmod>\n    <priority>${p.depth <= 1 ? "0.7" : "0.5"}</priority>\n  </url>`);
  return urls.length ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n` : null;
}

export function syncRobots(robots, config, hasSitemap) {
  const line = `Sitemap: ${config.origin}/sitemap-resources.xml`;
  const stripped = robots.split("\n").filter((l) => l.trim() !== line).join("\n").replace(/\n+$/, "\n");
  return hasSitemap ? stripped + line + "\n" : stripped;
}

// Everything the build writes, as { relativePath: contents } — shared by write and --check.
export function buildOutputs(siteDir, contentDir) {
  const config = JSON.parse(readFileSync(join(contentDir, "site.json"), "utf8"));
  const pages = loadPages(contentDir);
  const shell = loadShell(siteDir);
  const files = {};
  for (const p of pages.filter((x) => x.status === "published")) files[`${p.url.slice(1)}index.html`] = renderPage(p, pages, config, shell);
  const sitemap = renderSitemap(pages, config);
  if (sitemap) files["sitemap-resources.xml"] = sitemap;
  files["robots.txt"] = syncRobots(readFileSync(join(siteDir, "robots.txt"), "utf8"), config, !!sitemap);
  return { files, pages, config };
}

export function writeOutputs(siteDir, files) {
  rmSync(join(siteDir, "resources"), { recursive: true, force: true });
  rmSync(join(siteDir, "sitemap-resources.xml"), { force: true });
  for (const [rel, text] of Object.entries(files)) {
    const dest = join(siteDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}

export function diffOutputs(siteDir, files) {
  const stale = [];
  for (const [rel, text] of Object.entries(files)) {
    const f = join(siteDir, rel);
    if (!existsSync(f) || readFileSync(f, "utf8") !== text) stale.push(rel);
  }
  const root = join(siteDir, "resources");
  if (existsSync(root)) for (const f of walkAll(root)) { const rel = relative(siteDir, f).split(sep).join("/"); if (!(rel in files)) stale.push(`${rel} (no source)`); }
  if (!("sitemap-resources.xml" in files) && existsSync(join(siteDir, "sitemap-resources.xml"))) stale.push("sitemap-resources.xml (no source)");
  return stale;
}

function walkAll(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(join(dir, e.name)) : [join(dir, e.name)]));
}

export function report(pages, today, reviewMonths = 12) {
  const rows = new Map();
  for (const p of pages) {
    const silo = p.depth === 0 ? "(hub)" : p.url.split("/")[2];
    const r = rows.get(silo) || { published: 0, draft: 0, words: 0 };
    r[p.status === "published" ? "published" : "draft"]++; r.words += wordCount(p.body); rows.set(silo, r);
  }
  const lines = ["silo | published | draft | words", "--- | --- | --- | ---", ...[...rows].map(([s, r]) => `${s} | ${r.published} | ${r.draft} | ${r.words}`)];
  const overdue = pages.filter((p) => p.status === "published" && monthsBetween(p.data.updated, today) > reviewMonths);
  if (overdue.length) lines.push("", `Overdue for review (> ${reviewMonths} months):`, ...overdue.map((p) => `  ${p.file} (updated ${p.data.updated})`));
  return lines.join("\n");
}

// ---------- CLI ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const contentDir = join(siteDir, "..", "content");
  const ti = args.indexOf("--today");
  const today = ti >= 0 ? args[ti + 1] : new Date().toISOString().slice(0, 10);
  const { files, pages, config } = buildOutputs(siteDir, contentDir);
  const { errors, warnings } = lint(pages, { today, reviewMonths: config.reviewMonths });
  warnings.forEach((w) => console.warn(`warn  ${w}`));
  errors.forEach((e) => console.error(`error ${e}`));
  if (args.includes("--report")) console.log(report(pages, today, config.reviewMonths));
  if (errors.length) { console.error(`\n${errors.length} error(s) — nothing written.`); process.exit(1); }
  if (args.includes("--lint") || args.includes("--report")) { console.log(`lint ok: ${pages.length} page(s), ${warnings.length} warning(s)`); process.exit(0); }
  if (args.includes("--check")) {
    const stale = diffOutputs(siteDir, files);
    if (stale.length) { console.error(`site/resources is out of date — run: node site/scripts/build-resources.mjs\n  ${stale.join("\n  ")}`); process.exit(1); }
    console.log("resources up to date"); process.exit(0);
  }
  writeOutputs(siteDir, files);
  console.log(`built ${Object.keys(files).filter((f) => f.endsWith("index.html")).length} page(s) into site/resources (${pages.length - Object.keys(files).filter((f) => f.endsWith("index.html")).length} draft)`);
}
