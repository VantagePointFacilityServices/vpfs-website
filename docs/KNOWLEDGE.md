# Operating knowledge & lessons learned

Things that aren't obvious from the code, learned the hard way while
building and running this site, the Worker and their GoHighLevel (GHL)
integration. Read this before changing DNS, the Worker, or anything GHL
reads. Setup runbooks live elsewhere — this file points to them.

| Need | Go to |
|---|---|
| How the pieces fit together | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| One-time domain / DNS / Pages setup | [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Run and test locally | [`DEVELOPMENT.md`](DEVELOPMENT.md) |
| The Worker, end to end (setup, verify, troubleshoot) | [`WORKER.md`](WORKER.md) |
| DNS zone files and the sync script | [`../dns/README.md`](../dns/README.md) |
| GHL setup: custom fields/IDs, tags, workflows, AI Receptionist | `vpos` repo → `shared/integrations/gohighlevel/` (especially `pipelines/commercial/core/custom-field-ids.md`, `tag-ids.md`, `voice-agent/commercial/`) |

---

## 1. Where things live

| Thing | Value |
|---|---|
| Canonical site | `https://www.vantagepointfacilityservices.com.au` (GitHub Pages) |
| Bare `.com.au` | 301 → `www` (GitHub Pages redirect; apex A records are DNS-only) |
| `.com` domain | 301 → `www.…com.au`, path + query kept (Cloudflare Redirect Rule) |
| Worker | `https://worker.vantagepointfacilityservices.com.au` (`vpfs-lead-scoring-worker`) |
| DNS | Cloudflare, both zones; desired state in `dns/zones/*.yaml` |
| Registrar | GoDaddy (nameservers only) |
| Email | Google Workspace on both domains; GHL sends from `noreply.vantagepointfacilityservices.com.au` via Mailgun |
| GHL sub-account (location) | `i1xCcUSRa8PDofaJ1Oyz` (`GHL_LOCATION_ID` in `worker/wrangler.toml`) |
| Website-lead tag | `website-lead` (ID `AxqSvCibXVSHZd0ycUI4`) — the new-lead workflow triggers on Tag Added |
| Calendars | Priority `Ugunj3x67DQlmRm2aL2h`, Standard `FMEE7r6jwySahTZ90S0C` (manual-only: `AD4RlvMCfaaaq4QpLPFu`) |
| Phone | `07 5651 2257` published (voice); `0485 033 115` SMS-only, never published |
| Business hours | Mon–Sun 7am–7pm (Australia/Brisbane) |
| Secrets | `GHL_API_KEY` (Worker secret), `CLOUDFLARE_WORKER_API_TOKEN` and `CLOUDFLARE_API_TOKEN` (GitHub repo secrets) |

## 2. Business rules the code encodes (as of 2026-09-29)

- **Budget alone decides booking:** $5,000+/month → Priority calendar,
  $2,000–$4,999 → Standard, under $2,000 → nurture (budget message, no
  calendar). Frequency, facility type and postcode are `lead_flags`
  (`low-frequency`, `capability-gap`, `out-of-area`), never blockers.
- **SLA flags:** Priority `call-within-5min`, Standard/standard-flagged
  `call-within-15min`, nurture `none` — GHL workflow 29 (vpos) escalates on
  exactly these strings.
- **No instant quotes** for any commercial service; everything books a
  walkthrough.
- The AI Receptionist calls the same `/gate`, so phone and web leads get
  identical rules.

## 3. GoHighLevel lessons

- **GHL silently drops values it doesn't recognise.** Writing a custom
  field whose key doesn't exist, or a dropdown value that isn't an option,
  still returns `success: true`. The only proof a write worked is looking
  at the contact. Every value the Worker writes must exist as an exact
  field key (`contact.<key>`) and exact option text (e.g.
  `three_days_week`, not "3 days a week").
- **Create contacts with `POST /contacts/upsert` + `locationId`, never
  `POST /contacts/`** — the latter errors when the email/phone already
  exists, which blocked repeat enquirers.
- **Add tags through `POST /contacts/{id}/tags`**, not in the upsert body
  (the upsert can overwrite a returning contact's tags). **Tag Added fires
  only the first time** a contact gets a tag.
- **`/gate` returns the tier as `tier`**, not `lead_tier` — the GHL voice
  agent's webhook action has to map it.
- **Inbound Webhook triggers are premium (per-run cost) and can't hand a
  contact ID back** to the website — that's why the site goes through the
  Worker instead.
- **Private Integration tokens:** create them inside the *sub-account*, not
  agency view; scopes `contacts.write` + `contacts.readonly`; shown once.
  Name the Worker's one "Cloudflare Worker – Lead Scoring".
- **Ask AI** is good for fields, tags and workflow drafts but may not
  finish Voice AI settings (webhook response mapping, call routing) — check
  what it reports it couldn't do.

## 4. Cloudflare / DNS lessons

- **The sync script only sees records in the zone files.** A plain dry run
  won't show leftovers; `sync-dns.mjs --prune` (still a dry run without
  `--apply`) lists every live record the files don't mention. Do this
  before trusting a zone.
- **Leftover GoDaddy A records hijacked the bare domain.** Until
  2026-09-29 the `.com.au` apex had two *proxied* GoDaddy records beside
  the four GitHub ones, so `vantagepointfacilityservices.com.au` (and every
  `.com` redirect, which then pointed at the apex) served a GoDaddy page.
- **The zone files now list every live record, email included** — Google
  Workspace on both domains and GHL's Mailgun `noreply.` records. Before
  that, `--prune` would have deleted all email.
- **SPF was broken on both domains until 2026-09-29** — it included a
  GoDaddy `dc-…._spfm` record that vanished with the move to Cloudflare.
  Now `v=spf1 include:_spf.google.com ~all` (verified: a Google Workspace
  IP passes, 1 DNS lookup). GoDaddy leftovers are the recurring theme —
  check anything that references `domaincontrol.com` or `_spfm`.
- **Changing a TXT record's value plans as CREATE + DELETE**, not UPDATE,
  so apply it with `--prune` — otherwise both old and new stay live (two
  SPF records = SPF error).
- **The Worker's `worker.` DNS record is Cloudflare read-only** (owned by
  Wrangler's custom domain). The sync script never prunes read-only
  records; don't add it to a zone file.
- **Worker secrets are write-only.** `npx wrangler secret list` shows
  names, never values. The name must be exactly `GHL_API_KEY` — a secret
  saved as `GHL_API_KEY_CLOUDFLARE_WORKER` left the Worker sending
  `Bearer undefined` → `401 Invalid JWT` on every call.
- A DNS backup before any live change: dump
  `/zones/{id}/dns_records` and the redirect ruleset to JSON first.

## 5. Website / GitHub Pages lessons

- **Pages caches every file for 10 minutes** (`max-age=600`). New HTML with
  old cached JS broke the booking form after a deploy, so the deploy now
  appends `?v=<commit>` to every local CSS/JS URL
  (`site/scripts/cache-bust.mjs`). Don't hard-code `?v=` in source.
- **Step 1 and Step 2 share one `<form>`.** A `required` field in the hidden
  Step 2 makes the browser block Step 1 ("An invalid form control … is not
  focusable"). Step 2 validates in JS; use `aria-required`, never
  `required`, there. `page-forms.test.js` guards this.
- **Site and Worker deploy independently.** A change that needs both (e.g.
  new frequency values) has a ~1-minute window where one is live without
  the other — merge outside busy hours.
- The careers form is **not connected** to anything yet.

## 6. Testing the live system safely

| Want to check | Safe way |
|---|---|
| Worker is up | `POST /nope` → `404 Unknown route` |
| GHL token works | `POST /gate` with `contact_id` `doesNotExist000000000` → GHL `400 Contact … not found` = token OK; `401 Invalid JWT` = token missing/wrong. Writes nothing. |
| Scoring rules | Same fake-contact `/gate` call with different budgets — returns tier, flags, SLA |
| Full real flow | One real submission with marker details: name "Claude Test Lead - delete me", email `blake+claude-test-<n>@vantagepointfacilityservices.com`, phone `0491 570 006` (reserved for fiction). Check every field on the contact in GHL, then delete it. |
| DNS matches the files | `cd dns && node --env-file=.env sync-dns.mjs --prune` (dry run) |
| Pages in a real browser (WSL) | Puppeteer's Chrome needs `libnss3`/`libnspr4`: `apt-get download libnss3 libnspr4`, `dpkg -x` into a folder, run with `LD_LIBRARY_PATH` pointing at it (no sudo). Intercept only `/lead` to avoid creating contacts. GHL calendar iframes load fine this way. |

Windows' headless Chrome (`chrome.exe --headless --screenshot`) works for
quick screenshots but can't render narrower than ~500px — load the page in
a fixed-size `<iframe>` to get true phone widths.
