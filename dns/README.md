# Cloudflare config (DNS + redirects)

`dns/zones/<domain>.yaml` is the desired state for one Cloudflare zone —
its DNS records and any whole-domain redirects. `sync-dns.mjs` diffs each
file against the live zone and applies the difference: plain REST API
calls, no Terraform install or state file.

## Setup

```bash
cd dns
npm install
cp .env.example .env   # fill in CLOUDFLARE_API_TOKEN — see .env.example for scopes
```

## Usage

```bash
node --env-file=.env sync-dns.mjs                    # dry run, ALL zones — prints the plan, changes nothing
node --env-file=.env sync-dns.mjs --zone vantagepointfacilityservices.com.au   # just one zone's file
node --env-file=.env sync-dns.mjs --apply             # creates/updates records + redirect rules
node --env-file=.env sync-dns.mjs --apply --prune     # also deletes DNS records not listed (redirects are always fully synced regardless of --prune — see below)
```

Always run the dry run first and read the plan. `--prune` is the dangerous
one — it deletes any **DNS record** in the live zone that isn't in that
zone's file, including records set up by hand outside this repo (e.g.
existing email records). It prints what it would delete even without
`--apply`, so you can catch a mistake before it does anything. Redirect
rules aren't affected by `--prune` — a zone's redirect-rules list is always
replaced wholesale to exactly match its `redirects:` block, since that's
how Cloudflare's API works for that phase (see below).

## Zone file format

```yaml
zone: example.com

records:
  - type: A          # A, AAAA, CNAME, TXT, MX, etc.
    name: example.com  # fully-qualified hostname — bare domain for the apex, not "@"
    content: 192.0.2.1
    ttl: 1             # seconds, or 1 for "Auto" (default: 1)
    proxied: false     # true = orange-cloud (Cloudflare proxy/CDN/WAF) (default: false)
    priority: 10       # MX/SRV only

redirects:
  - description: "Redirect to somewhere else"
    expression: 'http.host eq "example.com"'          # Cloudflare ruleset expression — what to match
    target_expression: 'concat("https://elsewhere.com", http.request.uri.path)'  # Cloudflare expression producing the destination URL
    status_code: 301          # default: 301
    preserve_query_string: true  # default: true
```

A/AAAA/MX/TXT/SRV can have several records at the same name (e.g. the four
GitHub Pages apex IPs in the `.com.au` zone) — each is tracked
independently by its exact content. CNAME can only have one value per
name and is updated in place.

**Redirects require a proxied DNS record to work** — Cloudflare only
evaluates redirect rules for traffic it's proxying. A domain that exists
purely to redirect elsewhere (no real website of its own) still needs an
apex A/CNAME record with `proxied: true`; since the redirect matches
everything, the record's actual content is never reached — see the
`vantagepointfacilityservices.com` zone file for the pattern (a
documentation-reserved placeholder IP, `192.0.2.1`).

## Current zones

- **`vantagepointfacilityservices.com.au`** — the live commercial site.
  Apex and `www` both point at GitHub Pages, but `www` is canonical —
  `site/CNAME` is `www.vantagepointfacilityservices.com.au`, matching
  every page's `<link rel="canonical">`/`og:url` and `sitemap.xml`, so
  GitHub redirects the bare apex to `www` rather than the other way
  round (deployed by `.github/workflows/deploy-website.yml`). Also lists
  the **live** Google Workspace email records and GoHighLevel's
  email-sending domain (`noreply.` — Mailgun MX/SPF/DKIM), pulled from the
  live zone 2026-09-29. A GoHighLevel custom domain for funnels is still
  commented out, pending its real target.
- **`vantagepointfacilityservices.com`** — redirects entirely to
  `https://www.vantagepointfacilityservices.com.au`, path and query
  string preserved — straight to `www.…com.au`, one hop. Its live Google
  Workspace mailbox records are listed too.

Both files are a **complete** picture of their live zone (checked
2026-09-29), so a dry run shows nothing to change and `--prune` only
removes records you've deliberately deleted from a file. Cloudflare's
read-only records — e.g. the Worker's `worker.` custom-domain record,
owned by Wrangler — are never pruned.

**Both zones' SPF record is currently broken** — it includes a GoDaddy
`dc-…._spfm` record that no longer exists (see the comment in each zone
file). Fixing it is a deliberate one-line change to `content`, then
`--apply`.

The Lead Scoring Worker's custom domain (if you ever want one, e.g.
`api.vantagepointfacilityservices.com.au`) is deliberately **not** managed
here — configure it as a `routes` custom-domain entry in
`worker/wrangler.toml` instead. Cloudflare provisions that DNS record
itself when the Worker deploys; having both this script and Wrangler try
to own the same record would fight.

## API reference used

Redirect rules are Cloudflare's "Single Redirects" (Rules > Redirect
Rules in the dashboard), managed via the zone's `http_request_dynamic_redirect`
phase entrypoint ruleset:
[create](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/),
[update](https://developers.cloudflare.com/ruleset-engine/rulesets-api/update/).
`GET`/`PUT /zones/{zone_id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`
— `PUT` always replaces the entire rule list, which is why `syncRedirects`
in `sync-dns.mjs` just recomputes the whole list from `redirects:` rather
than diffing individual rules.

## Testing

```bash
npm test   # runs test/sync-dns.test.js with coverage (see vitest.config.js)
```

`sync-dns.mjs`'s pure logic (`sameRecord`, `needsUpdate`, `toRedirectRule`,
`rulesEqual`, `loadZoneFiles`) and its API-calling functions (`cf`,
`resolveZoneId`, `fetchExistingRecords`, `fetchCurrentRedirectRules`,
`syncRecords`, `syncRedirects`, `main`) all have unit tests, with `fetch`
mocked so nothing hits the real Cloudflare API. `loadZoneFiles` is also
tested directly against the real `zones/` directory, so a change that
breaks either committed zone file's YAML fails the suite too.
`vitest.config.js` enforces a 95% coverage floor (statements, branches,
functions, lines) — `npm test` exits non-zero below that, same as the
worker's suite. Currently at 100% across all four.

## CI

`.github/workflows/sync-dns.yml` has two jobs: `test` (runs the suite
above, coverage-gated) always runs first, then `sync` — dry run
automatically on any PR touching `dns/zones/**`; actual apply is manual
only (`workflow_dispatch`, with an `apply`/`prune` checkbox), never
automatic on push. Both a broken script and a bad DNS record/redirect are
things a plain `--apply` can't undo cleanly, so both gates exist —
tests catch a broken script before it ever touches the API, the
dry-run-by-default behavior catches a bad *config* even when the script
itself is correct.
