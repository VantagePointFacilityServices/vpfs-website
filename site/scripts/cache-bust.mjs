// Deploy-time cache busting for the static site.
//
// GitHub Pages serves every file with Cache-Control: max-age=600, so for up
// to 10 minutes after a deploy a browser can pair the new HTML with the old
// CSS/JS it already cached — e.g. new booking-form markup driven by the
// previous booking-gate.js, which breaks the form. Run against the deploy
// copy of site/ just before upload (see .github/workflows/deploy-website.yml),
// this appends ?v=<commit> to every local stylesheet/script URL in the pages,
// and to relative module imports inside the JS so a module loaded both ways
// resolves to one URL. The source files in the repo are never changed.
//
// Usage: node site/scripts/cache-bust.mjs <site-dir> <version>

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const HTML_ASSET = /((?:href|src)=")(assets\/[^"?#]+\.(?:css|js))(?:\?v=[^"]*)?(")/g;
const JS_RELATIVE_IMPORT = /(from\s+")(\.{1,2}\/[^"?#]+\.js)(?:\?v=[^"]*)?(")/g;

export function bustHtml(html, version) {
  return html.replace(HTML_ASSET, `$1$2?v=${version}$3`);
}

export function bustJs(js, version) {
  return js.replace(JS_RELATIVE_IMPORT, `$1$2?v=${version}$3`);
}

function rewrite(file, transform, version) {
  const before = readFileSync(file, "utf8");
  const after = transform(before, version);
  if (after !== before) writeFileSync(file, after);
}

export function bustSite(siteDir, version) {
  if (!version) throw new Error("cache-bust: a version (e.g. the commit SHA) is required");

  for (const name of readdirSync(siteDir)) {
    if (name.endsWith(".html")) rewrite(join(siteDir, name), bustHtml, version);
  }

  const jsDir = join(siteDir, "assets", "js");
  for (const name of readdirSync(jsDir)) {
    if (name.endsWith(".js")) rewrite(join(jsDir, name), bustJs, version);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [siteDir, version] = process.argv.slice(2);
  bustSite(siteDir, version);
  console.log(`cache-bust: versioned ${siteDir} assets as ?v=${version}`);
}
