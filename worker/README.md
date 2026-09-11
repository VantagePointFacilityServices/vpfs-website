# Lead Scoring Worker

Cloudflare Worker that scores and routes leads from the two-stage gate form
embedded on this site (and on paid-traffic landing pages). Receives GHL
webhooks on four endpoints — `/gate`, `/enrich`, `/confirm`, `/outcome` — and
writes `lead_tier`/`dq_flag`/score fields back to the GHL contact.

Field structure, scoring rules, and DQ/nurture routing are documented in the
vpos repo: `commercial/docs/lead-scoring-and-two-stage-gate-form.md`.

**Status:** source only — not yet wired up for deployment. Still needed:
`wrangler.toml`, the `GHL_API_KEY` secret (`wrangler secret put`), Vitest
tests (`checkDisqualifiers`, `calculateGateScore`, `tierFromScore` first,
then handler-level tests with `writeBackToGHL`'s `fetch` mocked), and a
GitHub Actions workflow gated on tests passing before `wrangler deploy`.
