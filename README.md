# vpfs-website

Vantage Point Facility Services delivers professional, consistent, and quality-controlled commercial cleaning, building trust through strong relationships, proven partners, social proof and genuine word of mouth.

**Live at:** [www.vantagepointfacilityservices.com.au](https://www.vantagepointfacilityservices.com.au) — the bare apex (`vantagepointfacilityservices.com.au`) and `vantagepointfacilityservices.com` both redirect there. See `docs/ARCHITECTURE.md` for how.

This repo holds three independent pieces: the marketing site (`site/`), the
lead-scoring Cloudflare Worker behind its gate form (`worker/`), and the
Cloudflare DNS/redirect config for both domains (`dns/`) — each with its
own install/test/deploy story, tied together in
`.github/workflows/`.

## Documentation

| Doc | Covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How GoDaddy, Cloudflare, GitHub Pages, and GitHub Actions fit together — diagrams for the domain/DNS setup, the three CI/CD workflows, and a visitor request lifecycle |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Install, run locally, and test each of `site/`, `worker/`, and `dns/` |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | One-time step-by-step setup runbook: GoDaddy nameservers → Cloudflare zones/token → applying DNS → GitHub Pages custom domain |
| [`worker/README.md`](worker/README.md) | Worker-specific detail: endpoints, local dev, CI/CD secrets, test coverage |
| [`dns/README.md`](dns/README.md) | Zone-file format, `sync-dns.mjs` usage, what's live vs. commented out pending real values |

## Project structure

```
README.md                                 this file
docs/                                      cross-cutting docs — architecture, development, deployment (see table above)

site/                                      the website (plain HTML/CSS/JS, no build step)
  index.html, services.html, service-areas.html,
  why-us.html, about.html, contact.html,
  careers.html                           the seven pages (see Page & section map below)
  assets/css/style.css                   shared stylesheet (design tokens + components)
  assets/js/main.js                      nav toggle, carousel, tabs, FAQ, form handling
  assets/img/                            logo SVGs
  branding/                              client-supplied brand guidelines and source logo files
  dev-server.js                          local dev server with live reload (see below)
  robots.txt, sitemap.xml                SEO crawl/index directives (see SEO section below)
  CNAME                                  GitHub Pages custom domain — www.vantagepointfacilityservices.com.au (canonical; apex redirects here)
serve.sh                                  runs the local dev server for site/ (see below)

worker/                                   Cloudflare Worker — lead-scoring and applicant-scoring webhook receiver
  worker.js, wrangler.toml, package.json, test/   see worker/README.md

dns/                                       Cloudflare DNS + redirect-rule config, applied via the Cloudflare API
  zones/*.yaml, sync-dns.mjs, package.json, test/   see dns/README.md

.github/workflows/                        deploy-website.yml, deploy-worker.yml, sync-dns.yml — see docs/ARCHITECTURE.md

design/design_handoff_vpfs_website/      design tokens, component reference and screenshots
                                          the site was built against, for comparison
```

## Quick start

```bash
./serve.sh                    # website — http://localhost:8124, live reload
(cd worker && npm install && npm test)   # worker — install + run its test suite
(cd dns && npm install && npm test)      # dns — install + run its test suite
```

Full detail (including how to run the Worker locally with `wrangler dev`,
and how to dry-run/apply DNS changes) is in `docs/DEVELOPMENT.md`.

## Page & section map

Five of the seven pages come from the original design handoff (see Design reference
below); `about.html` and `careers.html` were added after launch and follow the same
design system rather than a design-handoff screen, so no screenshots exist for either.

| Page | Purpose | Sections |
|---|---|---|
| `index.html` | Home / conversion entry point. First stop for most visitors and paid traffic. | Hero (headline + walkthrough booking form) → What we clean (5 scope cards) → How it works (4-step process) → Final CTA |
| `services.html` | Scope detail for buyers who already know they need commercial cleaning and want specifics. | Hero carousel (one slide per scope) → Tabbed scope detail (line items per scope) → FAQ accordion |
| `service-areas.html` | Local-SEO / coverage-confirmation page — "do you service my suburb?" | Intro → Region/suburb grid (Brisbane, Coomera–Labrador, Southport–Nerang, Robina–Coolangatta, Mudgeeraba–Worongary) |
| `why-us.html` | Comparison-shopping page — makes the case to pick Vantage Point over another cleaner. Service-level: what you get in the engagement. | Hero → Differentiators (written scope, same faces, monthly audit, right-fit products) → Client testimonials |
| `about.html` | Trust-building page — who is actually behind the business. Company-level: why it exists and how it's staffed. Deliberately avoids repeating Why Us's service-level claims (see note below). | Hero (cross-links to Why Us) → Founder story → Core values (4 cards) → Our people / workforce model → Final CTA |
| `contact.html` | Lead capture. | Contact form (service type, add-ons, message) → Phone/email/address details |
| `careers.html` | Applicant capture — recruits commercial cleaners. | Hero (headline + application form with DQ questions) → Why cleaners choose us (4 cards) → How it works (4-step process) → Final CTA |

**Why Us vs. About — keep these distinct:** Why Us answers "why pick you?" with service
mechanics (scope, audit, consistency) aimed at a comparison shopper. About answers "who
am I dealing with?" with founder story, values, and workforce model, aimed at someone
already interested. When adding content, put service-level proof (what the client
receives) on Why Us and company-level context (who runs it, why it exists) on About —
don't restate the same claims (e.g. "police checked," "fully insured," "named
supervisor") on both pages.

## Lead capture: the two-stage gate form

`index.html`'s booking form (and the equivalent on paid-traffic landing
pages) is Stage 1 of a two-stage qualification flow — a short form embedded
via GHL's JS widget, gated and scored by the Worker in `worker/`. Full field
structure and scoring rules are documented in the `vpos` repo:
`commercial/docs/lead-scoring-and-two-stage-gate-form.md`. Architecture
summary: `docs/ARCHITECTURE.md`.

## Recruitment: the careers application gate

`careers.html`'s application form is a single-stage equivalent of the lead
gate above, aimed at job applicants instead of clients — collects name,
email, phone, plus a set of DQ questions (right to work, police-check
consent, service-area postcode, experience, availability, transport,
physical capability, attitude), gated and scored by the Worker's `/apply`
endpoint. Applicants route into one of three GHL recruitment pipelines —
Priority, Standard, or Unsuccessful — with Unsuccessful applicants still
recorded rather than discarded, so a currently-unsuitable applicant can be
re-engaged later if they become qualified (same rationale as the lead
gate's nurture pool). Full field structure, DQ criteria, and scoring rules
are documented in the `vpos` repo:
`commercial/docs/recruitment-scoring-and-application-form.md`.

## Design reference

`design/design_handoff_vpfs_website/` contains the design tokens
(`design_reference/tokens/*.css`), the compiled stylesheet they wire together
(`design_reference/styles.css`), and per-section screenshots of each page
(`screenshots/<page>/`) that the built site is checked against for fidelity — this
covers the five original screens (Home, Services, Areas, Why us, Contact), not
`about.html`. See that folder's own `README.md` for the full handoff notes, including
which copy and numbers are placeholders pending client confirmation.

## SEO

`site/robots.txt` and `site/sitemap.xml` are served as static files at the site root
(`https://www.vantagepointfacilityservices.com.au/robots.txt`,
`.../sitemap.xml`) — nothing generates them, they're committed directly and
must be kept in sync by hand when pages change.

**Canonical domain:** `www.vantagepointfacilityservices.com.au` — this has
to match exactly across four places, or search engines get mixed signals
about which URL is authoritative:

1. `site/CNAME` (what GitHub Pages actually serves as canonical; the bare
   apex and `vantagepointfacilityservices.com` both redirect here — see
   `docs/ARCHITECTURE.md`)
2. Every page's `<link rel="canonical">` and `og:url` tag
3. Every `<loc>` in `sitemap.xml`
4. The `Sitemap:` line in `robots.txt`

If you ever change the canonical domain, all four need updating together —
`grep -rn "vantagepointfacilityservices" site/` to find every occurrence.

**`site/robots.txt`:** `Allow: /` for all user agents, plus a `Sitemap:`
pointer. No pages are currently disallowed — there's nothing here worth
hiding from crawlers (no admin area, no staging path served from this
repo).

**`site/sitemap.xml`:** one `<url>` entry per page, each with a `<loc>` and
a `<priority>` reflecting its role in the funnel — `index.html` at `1.0`
(entry point), `services.html`/`service-areas.html`/`contact.html` at
`0.8` (high-intent conversion pages), `why-us.html`/`about.html` at `0.6`
(consideration-stage). **When adding a page:** add its `<url>` block here
using the same priority convention, matching its position in the funnel
above.

**Per-page `<head>` block** (canonical link, Open Graph/Twitter Card tags,
JSON-LD `LocalBusiness` schema) — when adding a page, copy this block from
an existing page and update the title/description/canonical URL/`og:url`
to match, then add the page to `sitemap.xml` per above.
