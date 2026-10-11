# About and Why us shot list

The About and Why us pages currently use 13 temporary flat illustrations (`assets/img/*-temp.svg`, tagged `data-temp-image`). They stand in for real photos under a dated exception to C-MKT-05 (vpos, v0.3). This list is the brief for the real photos that replace them.

A phone camera is fine. Most shots can be taken in **one morning on one client site** (Session B), plus a few personal shots of Blake (Session A).

## Rules for every photo

- **Real only.** Real people, real sites, real kit. No stock photos, no AI, no staging that pretends to be something it isn't.
- **Written consent from everyone recognisable**, covering use on the website and social media. Cleaners in shot sign before the shoot. A client contact in shot signs too.
- **Client permission for any client site**, in writing. Nothing that identifies the client: no signage, logos, building names, street numbers or branded cups.
- **C-CLN-19 photo rules apply.** Never photograph screens, documents or paperwork with readable details, staff of the client, or patient areas on medical sites.
- **Blake's boys:** faces must not be identifiable. Shoot from behind, as silhouettes or at a distance. This is binding (`founder-facts.md`).
- **Uniforms** follow C-CLN-20: clean, complete, VPFS-branded where possible.
- **No before photos that embarrass a client.** "Before" shows ordinary daily mess, not neglect.
- **Light:** daylight or bright office light, no flash. Shoot landscape. Keep the subject in the middle of the frame, because the slots crop to 16:9 or 4:3.

## Export

| Slot type | Ratio | Export size | Format |
|---|---|---|---|
| About and Proof of work image slots | 16:9 | 1600 × 900 | WebP (or JPG), under 250 KB |
| Sample report card photos | 4:3 | 1200 × 900 | WebP (or JPG), under 200 KB |

Name each file as in the tables below, dropping `-temp` and changing the extension (for example `about-blake-beach-temp.svg` becomes `about-blake-beach.webp`).

## Session A — Blake, personal (a friend or family member takes these)

| # | Replaces | Page / section | Scene | Alt text (draft) | Avoid |
|---|---|---|---|---|---|
| A1 | `about-blake-beach-temp.svg` | About, Founder | Blake at Currumbin or Palm Beach with a surfboard, walking to or from the water, or sitting on the sand. Face visible is fine. Morning light. | Blake Warton with his surfboard at Currumbin beach | Crowds with recognisable faces, other brands' logos on boards or clothes |
| A2 | `about-blake-boys-temp.svg` | About, In Blake's words | Blake and his two boys on the beach at sunset, **from behind** (walking away or watching the water). | Blake and his two boys watching the sunset on a Gold Coast beach, seen from behind | **Any view of the boys' faces**, names on clothing, school uniforms |

## Session B — one client site, before or after hours (one morning)

Get the client's written permission first. An office with a kitchenette and a restroom covers every shot.

| # | Replaces | Page / section | Scene | Alt text (draft) | Avoid |
|---|---|---|---|---|---|
| B1 | `about-blake-onsite-client-temp.svg` | About, In Blake's words | Blake walking the office with the client contact, pointing at an area, talking. Side-on or three-quarter view. | Blake Warton walking a client's office with them | Client signage, screens, whiteboards with writing |
| B2 | `about-blake-cleaning-plan-temp.svg` | About, Our standard | Close-up: Blake's hands with a pen on a printed room-by-room cleaning plan, on a desk. | Blake reviewing a room-by-room cleaning plan on site | A readable client name or prices on the plan (use the "Example office" sample) |
| B3 | `about-team-uniform-temp.svg` | About, Local families | The cleaning team (2–3 people) in uniform with the trolley, relaxed, in the office or lobby. Faces fine with consent. | The Vantage Point cleaning team in uniform on site | Stock-style posing or thumbs up, client staff in the background |
| B4 | `whyus-pow-checked-temp.svg` | Why us, Proof of work row 1 | A cleaner in uniform arriving at the building entrance with kit, about to sign in. | A Vantage Point cleaner in uniform arriving at a client's building | Building name, street number, access codes on keypads |
| B5 | `whyus-pow-walkthrough-temp.svg` | Why us, Proof of work row 2 | Day-one walkthrough: a phone photographing a room or an existing mark, with a hand in shot. | Photographing a room on the first walkthrough to record its condition | Faces on screen, readable documents, the client's staff |
| B6 | `whyus-pow-cloths-temp.svg` | Why us, Proof of work row 3 | Flat lay or trolley shelf: red, yellow, blue and green microfibre cloths folded beside labelled spray bottles. | Colour-coded microfibre cloths beside labelled spray bottles | Competitor product brands front-on, unlabelled or handwritten bottles |
| B7 | `whyus-pow-checklist-temp.svg` | Why us, Proof of work row 4 | A cleaner's hands ticking the shift checklist on a phone or tablet, with the trolley in the background. | A cleaner ticking off the end-of-shift checklist | Readable client details or GPS maps on the screen |
| B8 | `whyus-pow-uniform-temp.svg` | Why us, Proof of work row 6 | Two cleaners in uniform working in the office (vacuuming, wiping glass). Natural, mid-task. | Two Vantage Point cleaners in uniform working in an office | The same frame as B3, client staff, wet floors with no sign |
| B9 | `whyus-sample-before-temp.svg` | Why us, sample report card (Before) | A desk or kitchenette at the start of the shift: crumbs, cups, a full bin. | Office kitchenette before cleaning | Real neglect, food waste close-ups, anything with a name on it |
| B10 | `whyus-sample-after-desk-temp.svg` | Why us, sample report card (After) | **The same spot as B9, same angle**, after cleaning. | The same office kitchenette after cleaning | A different angle or framing from B9 |
| B11 | `whyus-sample-after-restroom-temp.svg` | Why us, sample report card (After) | A clean restroom basin and mirror, restocked. No people, and no reflection of the photographer. | Clean, restocked restroom basin and mirror | People, the photographer in the mirror, toilets in close-up |

**Tip:** shoot B9 before the clean starts and B10 at the end, from the same spot. A tape mark on the floor helps.

## Swapping them in

The tests currently expect the `-temp.svg` files (`site/test/about.test.js`, `site/test/why-us.test.js`). So each swap is a small code change, not just a file drop:
1. Add the photo to `site/assets/img/`.
2. In the page, change `src` to the new file, use the alt text above, set `width`/`height` to the export size, and remove `data-temp-image`.
3. Update the matching test to expect the real file. Delete the `-temp.svg` file once nothing uses it.
4. Run `(cd site && npm test)`, then open a PR.

Easiest route: put the finished photos in one folder and ask Claude to do steps 1–4.

About goes public once at least A1 is in place (`.scratch/about-and-why-us-rebuild/issues/open/05-about-and-why-us-go-live.md`), along with amaysim's OK to be named.
