# Handoff: Vantage Point Facility Services — Marketing Website

## Overview
A five-screen commercial marketing site (Home, Services, Areas, Why us, Contact) for Vantage Point Facility Services (VPFS), a Gold Coast commercial cleaning company. Built on a custom design system (Deep Navy `#0F3060` brand, Manrope type, "leaf corner" motif).

## About the Design Files
Everything in `design_reference/` is an **HTML/React design reference**, not production code — a prototype built in a browser-only environment (Babel-in-browser JSX, no bundler, no package.json). Do not copy these files into the target app as-is. The task is to **recreate these screens in `/Workspaces/vpfs-website/site`'s actual stack** (Next.js/React/Vue/etc. — whatever that repo uses, or your recommended choice if it's empty) using its own build tooling, component conventions, and asset pipeline. Use the reference to match layout, copy, and visual detail exactly; do not use its file format.

## Fidelity
**High-fidelity.** Colors, type scale, spacing, and component styling are final brand values pulled from the client's brand guidelines PDF (see `design_reference/tokens/colors.css` for exact hex values). Layout, copy, and placeholder numbers (120+ sites, 98% audit pass, etc.) are proposals — flagged in `design_reference/readme.md` — and should be confirmed with the client before shipping, not treated as final content.

## Screens
1. **Home** — Inverse-navy hero (headline, two CTAs, four trust badges, hero image slot) → "Five scopes, one standard" grid of 5 cards (Offices, Strata, Education, Medical, Industrial; icon + title + body + image) → walkthrough process (4 numbered steps) + image card → closing CTA band.
2. **Services** — Auto-playing 5-slide hero carousel (one slide per scope, full-bleed image + navy gradient overlay + white caption + dot nav, 5s interval) → tabbed scope detail (bullet list of scope line items + badges + "book a walkthrough" card) → FAQ accordion.
3. **Areas** — Coverage/suburb content (see file for structure).
4. **Why us** — Differentiators + 3-column testimonial grid.
5. **Contact** — Form (service type, add-ons — Day porter checked by default, Window cleaning unchecked — message, submit) + real business contact details.

Shared chrome (`Chrome.jsx`): sticky header (nav shrinks/phone hides below 1100px), footer with "© 2026 Vantage Point Facility Services Pty Ltd."

## Interactions & Behavior
- Services hero: `setInterval` auto-advance every 5000ms, opacity crossfade (600ms ease), click-through dot navigation, pauses are not implemented (matches brand's stated "no auto-playing carousels" caution — flag this to the client; it's a deviation worth confirming).
- Header nav collapses responsively below 1100px (phone number hidden) and below 1000px (hero stacks to single column).
- Image placeholders are drag-and-drop slots in the prototype tool only — they carry no runtime behavior to reproduce; treat them as static `<img>`/`next/image` in the real build.

## Design Tokens
All exact values are in `design_reference/tokens/*.css` — do not re-derive by eye:
- `colors.css` — primary (`--vp-navy #0F3060`, `--vp-white`, `--vp-charcoal #494949`), 8-step grayscale, derived navy interaction ramp, semantic aliases.
- `typography.css` — Manrope, weights 300–800, scale 64/48/32/24/18/16 (+14/12 for UI).
- `spacing.css` — 4px base scale, 1240px container, 64px desktop / 24px mobile gutters.
- `shape.css` — radii (4/8/12/20px "leaf"/pill), navy-tinted shadows only.
- `motion.css` — 120ms press / 200ms hover / 360ms entrance, easing `cubic-bezier(.2,.6,.2,1)`.

## Assets
- `design_reference/assets/logos/` — 8 clean SVGs (mark + lockup × navy/white/charcoal/black).
- Icons: substituted from lucide (`unpkg.com/lucide-static`) — confirm with client whether they have a purchased/drawn icon set before shipping lucide to production.
- No real photography supplied — every photo is a placeholder; source real site photography before launch.

## Screenshots
`screenshots/1-home.png` through `5-contact.png` — full-page captures of each live screen, for exact visual reference alongside the layout descriptions above.

## Files
The screens (`ui_kits/website/*.jsx` + `index.html`) and the 24 component primitives (`components/`) live in the source design-system project, not duplicated into this bundle (duplicating them breaks the design system's own build). This handoff includes:
- `design_reference/tokens/` — all design values (colors, type, spacing, shape, motion).
- `design_reference/styles.css` — the stylesheet that wires the tokens together.
- `design_reference/assets/logos/` — the 8 brand SVGs.
- `design_reference/readme.md` — full design system documentation (voice/copy rules, visual foundations, sources).

For the actual screen markup and component code, ask for the design-system project directly (or a fresh export of `ui_kits/website/` and `components/`) — read them as reference, per the Fidelity note above, rather than copying them into the target app.
