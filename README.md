# vpfs-website

Vantage Point Facility Services delivers professional, consistent, and quality-controlled commercial cleaning, building trust through strong relationships, proven partners, social proof and genuine word of mouth.

## Project structure

```
serve.sh                                  runs the local dev server (see below)
site/                                    the website (plain HTML/CSS/JS, no build step)
  index.html, services.html, service-areas.html,
  why-us.html, about.html, contact.html  the six pages (see Page & section map below)
  assets/css/style.css                   shared stylesheet (design tokens + components)
  assets/js/main.js                      nav toggle, carousel, tabs, FAQ, form handling
  assets/img/                            logo SVGs
  branding/                              client-supplied brand guidelines and source logo files
  dev-server.js                          local dev server with live reload (see below)
  robots.txt, sitemap.xml                SEO crawl/index directives (see SEO section below)

design/design_handoff_vpfs_website/      design tokens, component reference and screenshots
                                          the site was built against, for comparison
```

## Running the site locally

The site is static HTML/CSS/JS — no build step and no dependencies to install.

```bash
./serve.sh          # serves on http://localhost:8124, with live reload
./serve.sh 3000      # or pass a port
```

Requires only [Node.js](https://nodejs.org/) (no `npm install` needed). `serve.sh` is a
thin wrapper around `site/dev-server.js`; edit any file under `site/` and open browser
tabs auto-refresh. See `site/dev-server.js` for how it works.

## Page & section map

Five of the six pages come from the original design handoff (see Design reference
below); `about.html` was added after launch and follows the same design system rather
than a design-handoff screen, so no screenshots exist for it.

| Page | Purpose | Sections |
|---|---|---|
| `index.html` | Home / conversion entry point. First stop for most visitors and paid traffic. | Hero (headline + walkthrough booking form) → What we clean (5 scope cards) → How it works (4-step process) → Final CTA |
| `services.html` | Scope detail for buyers who already know they need commercial cleaning and want specifics. | Hero carousel (one slide per scope) → Tabbed scope detail (line items per scope) → FAQ accordion |
| `service-areas.html` | Local-SEO / coverage-confirmation page — "do you service my suburb?" | Intro → Region/suburb grid (Brisbane, Coomera–Labrador, Southport–Nerang, Robina–Coolangatta, Mudgeeraba–Worongary) |
| `why-us.html` | Comparison-shopping page — makes the case to pick Vantage Point over another cleaner. Service-level: what you get in the engagement. | Hero → Differentiators (written scope, same faces, monthly audit, right-fit products) → Client testimonials |
| `about.html` | Trust-building page — who is actually behind the business. Company-level: why it exists and how it's staffed. Deliberately avoids repeating Why Us's service-level claims (see note below). | Hero (cross-links to Why Us) → Founder story → Core values (4 cards) → Our people / workforce model → Final CTA |
| `contact.html` | Lead capture. | Contact form (service type, add-ons, message) → Phone/email/address details |

**Why Us vs. About — keep these distinct:** Why Us answers "why pick you?" with service
mechanics (scope, audit, consistency) aimed at a comparison shopper. About answers "who
am I dealing with?" with founder story, values, and workforce model, aimed at someone
already interested. When adding content, put service-level proof (what the client
receives) on Why Us and company-level context (who runs it, why it exists) on About —
don't restate the same claims (e.g. "police checked," "fully insured," "named
supervisor") on both pages.

## Design reference

`design/design_handoff_vpfs_website/` contains the design tokens
(`design_reference/tokens/*.css`), the compiled stylesheet they wire together
(`design_reference/styles.css`), and per-section screenshots of each page
(`screenshots/<page>/`) that the built site is checked against for fidelity — this
covers the five original screens (Home, Services, Areas, Why us, Contact), not
`about.html`. See that folder's own `README.md` for the full handoff notes, including
which copy and numbers are placeholders pending client confirmation.

## SEO

`site/robots.txt` and `site/sitemap.xml` are served as static files. Every page also
carries a canonical link, Open Graph/Twitter Card tags, and a JSON-LD `LocalBusiness`
schema block in its `<head>` — when adding a page, copy that block from an existing
page and update the title/description/canonical URL, and add the new URL to
`sitemap.xml`.
