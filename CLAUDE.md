# coffeestencil

Client-only web app (bun + TypeScript + three.js): generates a latte art
dusting stencil STL/3MF from SVG/PNG/JPG. Everything runs in the browser,
geometry in a Web Worker. Sibling of `../cookiecut` — shared modules (svg,
raster, scene, viewcube, threemf, worker plumbing) were copied from there.

## Commands

```sh
bun install
bun run dev           # build:worker + dev server (port via BUN_PORT)
bun run build         # static build into dist/
bun run build:worker  # rebundle just the worker into src/worker.gen.js
bunx tsc --noEmit     # typecheck (bun itself does not typecheck)
```

## Worker — BEWARE of stale builds

Bun's bundler cannot handle `new Worker(new URL(...))`. The worker is
therefore prebundled into `src/worker.gen.js` (gitignored) and inlined into
the app as a text import (`with { type: 'text' }`) → Blob URL. Consequence:
**after any change to worker-side code (`geo2d.ts`, `manifold.ts`,
`generate.ts`, `worker.ts`) run `bun run build:worker` and restart the dev
server** — a running server won't pick the change up on its own.

## Architecture

Shared: `types.ts` (contracts between modules and the worker).

Geometry (no DOM — runs in the worker):
- `geo2d.ts` — areas, bounds, point-in-poly, RDP, dedup
- `manifold.ts` — manifold-3d WASM singleton (binary embedded as base64 by
  `scripts/build-worker.ts`)
- `generate.ts` — plate outline, openings, island bridging, extrude →
  triangles
- `worker.ts` — thin message wrapper around `generate()`

Main thread: `clipper2d.ts` (stroke expansion), `svg.ts`, `raster.ts`
(contour extraction), `scene.ts` + `viewcube.ts` (three.js viewport),
`dims.ts` (dimension annotations), `preview2d.ts` (dusting preview),
`worker-client.ts`, `i18n.ts` (cs/en), `app.ts` (UI wiring only).

## Geometry invariants

- Units mm, Y axis up (SVG Y is flipped during extraction), Z = thickness.
  The handle points to -y.
- Motif contours are oriented by nesting depth (even CCW, odd CW) and fed
  with the NonZero fill rule — EvenOdd would cancel overlapping shapes.
  Single loops fed with the Positive rule must be CCW.
- Openings stay inside a solid `RIM`; a motif reaching past it is clipped
  and reported (`clipped`).
- Every island (plate part apart from the body — the part with the largest
  bounding box, not area: in negative mode the motif can outweigh the rim)
  gets `bridges` bridges (auto: one per `BRIDGE_SPACING` mm of extent),
  spread at equal arc length around its outline, each pointing outward so
  it never runs back across the island. Near-duplicates (two islands
  bridging to each other at one spot) are skipped. Specks under
  `2·bridgeW²` are subtracted instead. A greedy nearest-part pass then ties
  up anything still loose; it stops when a bridge fails to merge and
  leftover parts are removed, so the export is always one piece.
- The contour extractors keep shapes down to 0.03 % of the largest area —
  line-art eyes and whiskers are tiny next to the outline.
- Corner rounding `cornerR` is morphological: opening (-r,+r) before
  bridging (after it would erase bridges narrower than 2r), closing (+r,-r)
  after, then the hanging hole is cut again (closing shuts holes of radius
  <= r). Features narrower than 2r disappear — inherent, keep the slider
  range small. The plate is `simplify`d before extrusion: offset
  micro-edges otherwise break watertightness after slicer vertex welding.
- Every Manifold/CrossSection WASM object must be `delete()`d — the `Scope`
  helper in generate.ts tracks and disposes them per request.

## Verification

No checked-in tests. Pure geometry: `bun -e "import { generate } from
'./src/generate.ts'; ..."` with mock contours. End to end: a playwright-core
script (Chromium from `~/Library/Caches/ms-playwright/`) uploads a file, waits
for the "Model generated" status, downloads the STL — validated in Python
with trimesh: `is_watertight`, exactly one body, bbox.
