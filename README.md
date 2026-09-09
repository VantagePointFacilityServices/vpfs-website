# vpfs-website

Vantage Point Facility Services delivers professional, consistent, and quality-controlled commercial cleaning, building trust through strong relationships, proven partners, social proof and genuine word of mouth.

## Project structure

```
serve.sh                                  runs the local dev server (see below)
site/                                    the website (plain HTML/CSS/JS, no build step)
  index.html, services.html,
  service-areas.html, why-us.html, contact.html  the five pages
  assets/css/style.css                   shared stylesheet (design tokens + components)
  assets/js/main.js                      nav toggle, carousel, tabs, FAQ, form handling
  assets/img/                            logo SVGs
  branding/                              client-supplied brand guidelines and source logo files
  dev-server.js                          local dev server with live reload (see below)

Vantage Point Design System/             design tokens, component reference and screenshots
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

## Design reference

`Vantage Point Design System/design_handoff_vpfs_website/` contains the design tokens
(`design_reference/tokens/*.css`), the compiled stylesheet they wire together
(`design_reference/styles.css`), and per-section screenshots of each page
(`screenshots/<page>/`) that the built site is checked against for fidelity. See that
folder's own `README.md` for the full handoff notes, including which copy and numbers
are placeholders pending client confirmation.
