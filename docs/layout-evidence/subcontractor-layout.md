# subcontractor.html layout check (2026-10-13)

The evidence is the screenshots: taken with `shot.mjs` at 1366, 390 and 360px, committed in `screenshots/`
(`subcontractor-<width>-NN.png`). The numbers below were read once from the "What you get" `.card-grid-careers`
grid after full page load, using a one-off Chrome DevTools measurement script that was not kept in the repo
(it needed a dev server on a fixed port):

| width | scrollWidth / clientWidth | columns | card heights (px) | card widths (px) |
|---|---|---|---|---|
| 1366 | 1351 / 1351 (no h-scroll) | 4 | 313, 313, 313, 313 (even) | 260 x4 |
| 390 | 390 / 390 | 1 | 240, 265, 216, 216 | 342 x4 |
| 360 | 360 / 360 | 1 | 240, 289, 216, 239 | 312 x4 |

Mobile cards stack in one column at identical widths; heights differ only by text length.
