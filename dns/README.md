# DNS sync (Cloudflare)

`records.yaml` is the desired-state list of DNS records for
`vantagepointcommercial.com.au`. `sync-dns.mjs` diffs it against the live
Cloudflare zone and applies the difference — plain REST API calls, no
Terraform install or state file.

## Setup

```bash
cd dns
npm install
cp .env.example .env   # fill in CLOUDFLARE_API_TOKEN — see .env.example for scopes
```

## Usage

```bash
node --env-file=.env sync-dns.mjs            # dry run — prints the plan, changes nothing
node --env-file=.env sync-dns.mjs --apply    # creates/updates records
node --env-file=.env sync-dns.mjs --apply --prune   # also deletes records not listed in records.yaml
```

Always run the dry run first and read the plan. `--prune` is the dangerous
one — it deletes anything in the live zone that isn't in `records.yaml`,
including records set up by hand outside this file (e.g. Google Workspace
MX before it's added here). It prints what it would delete even without
`--apply`, so you can catch a mistake before it does anything.

## Editing records

Add/edit/remove entries in `records.yaml` (it documents its own field
format), then re-run the sync. A/AAAA/MX/TXT records can have several
values at the same name (e.g. the four GitHub Pages apex IPs) — each is
tracked independently. CNAME can only have one value per name and is
updated in place.

## What's live vs. what's commented out

Only the website's GitHub Pages records (apex + `www`) are active — that's
the one system already built (`.github/workflows/deploy-website.yml`).
Google Workspace email and a GoHighLevel custom domain are commented out in
`records.yaml` because they need real values (DKIM key, verification
token, GHL target) from systems that aren't set up yet per the [MVP
execution
plan](../../vpos/commercial/docs/tech-stack-execution-plan-and-mvp-checklist.md) —
don't guess those values, uncomment once you have them from the source
system's own setup flow.

The Lead Scoring Worker's custom domain (if you ever want one, e.g.
`api.vantagepointcommercial.com.au`) is deliberately **not** managed here —
configure it as a `routes` custom-domain entry in `worker/wrangler.toml`
instead. Cloudflare provisions that DNS record itself when the Worker
deploys; having both this script and Wrangler try to own the same record
would fight.

## `site/CNAME`

GitHub Pages needs a `CNAME` file in the published directory to know which
custom domain to serve — that's `site/CNAME`, committed alongside the site
source so it survives every deploy. It has to match the DNS records above
exactly.

## CI

`.github/workflows/sync-dns.yml`: dry run automatically on any PR touching
`dns/records.yaml`; actual apply is manual only (`workflow_dispatch`, with
an `apply`/`prune` checkbox), never automatic on push — a bad DNS record
degrades email or the live site with nothing like a test suite to catch it
first, unlike the worker's deploy gate.
