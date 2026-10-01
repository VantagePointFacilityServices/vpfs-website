# Development

Install, run, and test each part of this repo. For the full one-time
domain/DNS/Pages setup, see `docs/DEPLOYMENT.md`. For how the pieces fit
together, see `docs/ARCHITECTURE.md`.

This repo has three independently-versioned parts — the website has no
build step (still plain HTML/CSS, hand-served) but does now have a small
dev-only JS test dependency; the Worker and DNS tooling are separate Node
packages with their own `package.json`, installed and tested
independently.

## Website (`site/`)

**Install:**

```bash
cd site
npm install   # only needed to run the JS test suite below — the site
              # itself still has zero runtime dependencies
```

**Run locally:**

```bash
./serve.sh          # http://localhost:8124, with live reload
./serve.sh 3000      # or pass a port
```

Requires only [Node.js](https://nodejs.org/). `serve.sh` wraps
`site/dev-server.js`; edit any file under `site/` and open browser tabs
auto-refresh.

**Test:**

```bash
cd site
npm test    # vitest run, jsdom environment — see test/booking-gate.test.js
```

79 tests across five files, `fetch` mocked throughout (nothing hits the
live Worker):
- `booking-gate.test.js` — the two-step booking gate JS: Step 1 → `/lead`,
  the Step 2 overlay (`<dialog>`), `/gate` → calendar/message choice,
  error/retry handling.
- `page-forms.test.js` — loads the real `index.html`/`contact.html`: no
  hidden `required` fields blocking Step 1, frequency options, overlay
  structure and accessibility attributes.
- `utm.test.js` — UTM capture across pages (`assets/js/utm.js`).
- `business-hours.test.js` — every page's footer, contact card and schema
  say Mon–Sun 7am–9pm.
- `cache-bust.test.js` — the deploy-time `?v=<commit>` asset versioning
  (`scripts/cache-bust.mjs`). The rest of the static
markup (page layout, copy) has no logic to unit test and is checked
visually against `design/design_handoff_vpfs_website/` (see the root
README's Design reference section).

**Deploy:** automatic, via `.github/workflows/deploy-website.yml` on every
push to `main` touching `site/**`, gated on the test job passing (same
pattern as the Worker). Just before upload the job runs
`site/scripts/cache-bust.mjs`, which appends `?v=<commit>` to every local
CSS/JS URL in the deployed copy (GitHub Pages caches files for 10 minutes);
the repo's own files never carry it. See `docs/DEPLOYMENT.md` Part 7 for the one-time
GitHub Pages setup this depends on.

## Lead Scoring Worker (`worker/`)

**Install:**

```bash
cd worker
npm install
```

**Run locally:**

```bash
npx wrangler dev
```

Starts the Worker against a local `workerd` runtime at
`http://localhost:8787`, routing all seven endpoints (`/lead`, `/gate`,
`/enrich`, `/confirm`, `/outcome`, `/apply`, `/apply-screen`) per
`worker/worker.js`. It doesn't need `CLOUDFLARE_API_TOKEN`
to run locally — only `wrangler deploy` does. `writeBackToGHL` will still
attempt a real call to the GHL API on each request, though, so a request
without a working `GHL_API_KEY` set locally (`wrangler dev` reads
`.dev.vars` if present — git-ignored, never commit it) will return
`ghl_update: { success: false, ... }` rather than failing the whole
request; that's expected for local testing of the routing/scoring logic
itself.

**Test:**

```bash
npm test    # vitest run, with coverage — see worker/README.md
```

Enforces 95% coverage (statements/branches/functions/lines) on
`worker.js`; the command exits non-zero below that. 119 tests across
`test/scoring.test.js` (pure scoring/disqualification logic),
`test/applicant-scoring.test.js` and `test/handlers.test.js` (all seven
endpoints, end-to-end through the exported `fetch` handler, with `fetch`
mocked so nothing hits the live GHL API). See `docs/WORKER.md` for the
full guide.

**Deploy:** automatic, via `.github/workflows/deploy-worker.yml` on every
push to `main` touching `worker/**`, gated on the test job passing. See
`worker/README.md` for the secrets it needs.

## DNS / Cloudflare config (`dns/`)

**Install:**

```bash
cd dns
npm install
cp .env.example .env   # fill in CLOUDFLARE_API_TOKEN
```

**Run** (there's no long-running process here — "running" this package
means syncing DNS state):

```bash
node --env-file=.env sync-dns.mjs                # dry run, all zones
node --env-file=.env sync-dns.mjs --zone <domain>  # dry run, one zone
node --env-file=.env sync-dns.mjs --apply          # actually apply
```

Always dry-run before `--apply` — see `dns/README.md` for the full
`--prune` warning and zone-file format.

**Test:**

```bash
npm test    # vitest run, with coverage — see dns/README.md
```

Enforces 95% coverage on `sync-dns.mjs`; 53 tests, `fetch` mocked
throughout so no test ever calls the real Cloudflare API. Also directly
parses the real `dns/zones/*.yaml` files as a regression check that they
stay valid.

**Deploy** (apply to the live Cloudflare zones): manual only, via
`.github/workflows/sync-dns.yml`'s `workflow_dispatch` (with `apply`/
`prune` checkboxes) — never automatic on push. See `docs/DEPLOYMENT.md`
for the full one-time setup (GoDaddy nameservers, Cloudflare zones, API
token scopes).

## Running every test suite at once

```bash
(cd site && npm test) && (cd worker && npm test) && (cd dns && npm test)
```

Both are also run in CI on every relevant PR — see `docs/ARCHITECTURE.md`
for the full CI/CD diagram.
