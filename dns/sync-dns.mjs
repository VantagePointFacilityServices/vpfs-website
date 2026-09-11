#!/usr/bin/env node
// Syncs dns/records.yaml (desired state) to a Cloudflare zone's DNS records
// (actual state) via the Cloudflare API. See dns/README.md for setup.
//
// Usage:
//   node --env-file=dns/.env dns/sync-dns.mjs            # dry run (default) — prints the plan, changes nothing
//   node --env-file=dns/.env dns/sync-dns.mjs --apply     # actually create/update records
//   node --env-file=dns/.env dns/sync-dns.mjs --apply --prune   # also delete records not in records.yaml
//
// --prune is dangerous: it deletes ANY record in the zone that isn't listed
// in records.yaml (including ones set up by hand, e.g. Google Workspace MX
// before they're added here). It always prints what it would delete first,
// even in dry-run mode, so review that list carefully before adding --apply.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = "https://api.cloudflare.com/client/v4";
const SINGLE_VALUE_TYPES = new Set(["CNAME"]); // only one record allowed per name; everything else can coexist

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PRUNE = args.includes("--prune");

const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME || "vantagepointcommercial.com.au";
let ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;

if (!API_TOKEN) {
  console.error(
    "Missing CLOUDFLARE_API_TOKEN. Copy dns/.env.example to dns/.env, fill it in, and run with --env-file=dns/.env."
  );
  process.exit(1);
}

async function cf(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    throw new Error(`Cloudflare API error on ${options.method || "GET"} ${path}: ${JSON.stringify(body.errors)}`);
  }
  return body;
}

async function resolveZoneId() {
  if (ZONE_ID) return ZONE_ID;
  const body = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!body.result.length) {
    throw new Error(`No Cloudflare zone found for "${ZONE_NAME}" — check CLOUDFLARE_ZONE_NAME, or set CLOUDFLARE_ZONE_ID directly.`);
  }
  return body.result[0].id;
}

async function fetchExistingRecords(zoneId) {
  const records = [];
  let page = 1;
  for (;;) {
    const body = await cf(`/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
    records.push(...body.result);
    if (page >= body.result_info.total_pages) break;
    page += 1;
  }
  return records;
}

function loadDesiredRecords() {
  const text = readFileSync(join(__dirname, "records.yaml"), "utf8");
  const parsed = parseYaml(text) || [];
  return parsed.map((r) => ({
    type: r.type,
    name: r.name,
    content: String(r.content),
    ttl: r.ttl ?? 1,
    proxied: r.proxied ?? false,
    priority: r.priority,
  }));
}

function sameRecord(desired, existing) {
  if (desired.type !== existing.type || desired.name !== existing.name) return false;
  if (SINGLE_VALUE_TYPES.has(desired.type)) return true; // matched by type+name alone
  return desired.content === existing.content;
}

function needsUpdate(desired, existing) {
  if (desired.content !== existing.content) return true;
  if (desired.ttl !== existing.ttl) return true;
  if (Boolean(desired.proxied) !== Boolean(existing.proxied)) return true;
  if (desired.priority !== undefined && desired.priority !== existing.priority) return true;
  return false;
}

async function main() {
  const zoneId = await resolveZoneId();
  const [desired, existing] = await Promise.all([Promise.resolve(loadDesiredRecords()), fetchExistingRecords(zoneId)]);

  const toCreate = [];
  const toUpdate = [];
  const unchanged = [];
  const matchedExistingIds = new Set();

  for (const d of desired) {
    const match = existing.find((e) => !matchedExistingIds.has(e.id) && sameRecord(d, e));
    if (!match) {
      toCreate.push(d);
      continue;
    }
    matchedExistingIds.add(match.id);
    if (needsUpdate(d, match)) {
      toUpdate.push({ id: match.id, desired: d, existing: match });
    } else {
      unchanged.push(d);
    }
  }

  const toDelete = PRUNE ? existing.filter((e) => !matchedExistingIds.has(e.id)) : [];

  console.log(`Zone: ${ZONE_NAME} (${zoneId})`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN (pass --apply to make changes)"}${PRUNE ? " + PRUNE" : ""}\n`);

  console.log(`${unchanged.length} record(s) already correct.`);

  if (toCreate.length) {
    console.log(`\nCREATE (${toCreate.length}):`);
    for (const r of toCreate) console.log(`  + ${r.type} ${r.name} -> ${r.content}${r.priority ? ` (priority ${r.priority})` : ""}`);
  }

  if (toUpdate.length) {
    console.log(`\nUPDATE (${toUpdate.length}):`);
    for (const { desired: d, existing: e } of toUpdate) {
      console.log(`  ~ ${d.type} ${d.name}: ${e.content} -> ${d.content}`);
    }
  }

  if (PRUNE) {
    console.log(`\nDELETE (${toDelete.length})${toDelete.length ? " — review carefully:" : ""}`);
    for (const r of toDelete) console.log(`  - ${r.type} ${r.name} -> ${r.content}`);
  }

  if (!toCreate.length && !toUpdate.length && !toDelete.length) {
    console.log("\nNothing to do.");
    return;
  }

  if (!APPLY) {
    console.log("\nDry run only — no changes made. Re-run with --apply to execute the plan above.");
    return;
  }

  for (const r of toCreate) {
    await cf(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(r) });
    console.log(`Created ${r.type} ${r.name} -> ${r.content}`);
  }
  for (const { id, desired: r } of toUpdate) {
    await cf(`/zones/${zoneId}/dns_records/${id}`, { method: "PUT", body: JSON.stringify(r) });
    console.log(`Updated ${r.type} ${r.name} -> ${r.content}`);
  }
  for (const r of toDelete) {
    await cf(`/zones/${zoneId}/dns_records/${r.id}`, { method: "DELETE" });
    console.log(`Deleted ${r.type} ${r.name} -> ${r.content}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
