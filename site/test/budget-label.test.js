import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const SITE = resolve(__dirname, "..");

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" || e.name === "test" ? [] : e.isDirectory() ? walk(resolve(dir, e.name)) : /\.html$/.test(e.name) ? [resolve(dir, e.name)] : []);

const LABEL = "Approx. monthly cleaning budget (ex GST)";

describe("monthly_budget field label", () => {
  const files = walk(SITE).filter((f) => readFileSync(f, "utf8").includes('name="monthly_budget"'));
  it("finds the pages carrying the field", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  it("labels every monthly_budget input 'ex GST'", () => {
    for (const f of files) {
      const doc = new DOMParser().parseFromString(readFileSync(f, "utf8"), "text/html");
      for (const input of doc.querySelectorAll('input[name="monthly_budget"]')) {
        const label = doc.querySelector(`label[for="${input.id}"]`);
        expect(label?.textContent.trim(), f).toBe(LABEL);
      }
    }
  });
});
