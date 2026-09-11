# Development

Install, run, and test each part of this repo. For the full one-time
domain/DNS/Pages setup, see `docs/DEPLOYMENT.md`. For how the pieces fit
together, see `docs/ARCHITECTURE.md`.

This repo has three independently-versioned parts — the website has no
build step or dependencies at all; the Worker and DNS tooling are separate
Node packages with their own `package.json`, installed and tested
independently.

## Website (`site/`)

**Install:** nothing — plain HTML/CSS/JS, no dependencies.

**Run locally:**

```bash
./serve.sh          # http://localhost:8124, with live reload
./serve.sh 3000      # or pass a port
```

Requires only [Node.js](https://nodejs.org/). `serve.sh` wraps
`site/dev-server.js`; edit any file under `site/` and open browser tabs
auto-refresh.

**Test:** none currently — the site is static markup with no logic to
unit test. Changes are checked visually against
`design/design_handoff_vpfs_website/` (see the root README's Design
reference section).

**Deploy:** automatic, via `.github/workflows/deploy-website.yml` on every
push to `main` touching `site/**`. See `docs/DEPLOYMENT.md` Part 7 for the
one-time GitHub Pages setup this depends on.

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
`http://localhost:8787`, routing `/gate`, `/enrich`, `/confirm`,
`/outcome` per `worker/worker.js`. It doesn't need `CLOUDFLARE_API_TOKEN`
to run locally — only `wrangler deploy` does. `writeBackToGHL` will still
attempt a real call to the GHL API on each request, though, so a request
without a working `GHL_API_KEY` set locally (`wrangler dev` reads
`.dev.vars` if present — not currently in this repo) will return
`ghl_update: { success: false, ... }` rather than failing the whole
request; that's expected for local testing of the routing/scoring logic
itself.

**Test:**

```bash
npm test    # vitest run, with coverage — see worker/README.md
```

Enforces 95% coverage (statements/branches/functions/lines) on
`worker.js`; the command exits non-zero below that. 36 tests across
`test/scoring.test.js` (pure scoring/disqualification logic) and
`test/handlers.test.js` (all four endpoints, end-to-end through the
exported `fetch` handler, with `fetch` mocked so nothing hits the live
GHL API).

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

Enforces 95% coverage on `sync-dns.mjs`; 51 tests, `fetch` mocked
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
(cd worker && npm test) && (cd dns && npm test)
```

Both are also run in CI on every relevant PR — see `docs/ARCHITECTURE.md`
for the full CI/CD diagram.
