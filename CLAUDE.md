# coffeestencil

Client-only web app (bun + TypeScript + three.js): generates a latte art
dusting stencil STL/3MF from SVG/PNG/JPG. Everything runs in the browser,
geometry in a Web Worker; the same generator also runs headless as a CLI
(`scripts/cli.ts`). Sibling of `../cookiecut` — shared modules (svg,
svg-headless, raster, scene, viewcube, threemf, worker plumbing, the CLI
scaffolding) were copied from there.

## Commands

```sh
bun install
bun run dev           # build:worker + dev server (port via BUN_PORT)
bun run build         # static build into dist/
bun run build:worker  # rebundle just the worker into src/worker.gen.js
bunx tsc --noEmit     # typecheck (bun itself does not typecheck)
bun run cli <input> [options]  # headless generator, see --help
```

## CLI

`scripts/cli.ts` mirrors the web UI without a browser: `svg-headless.ts`
(copied from cookiecut; fast-xml-parser, analytic curve flattening,
`.class`/tag `<style>` rules) replaces `svg.ts`, sharp decodes rasters for
`raster.ts`, and `generate.ts` runs in-process (it writes
`src/manifold-wasm.ts` itself when missing). Its `PRESETS` and defaults
duplicate `app.ts`/`index.html` — **keep them in sync**, and add any new UI
parameter to the CLI too. `bunx tsc --noEmit` covers only `src/` —
typecheck the CLI by running it.

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
`dims.ts` (dimension annotations), `look.ts` (viewing mode: lighting rigs,
background, physical materials + procedural surface finishes on per-face mm
UVs — cosmetic only, exports untouched), `preview2d.ts` (dusting preview),
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
  spread at equal arc length around its outline. Anchors must be mutually
  nearest across the gap (straight, not oblique), point outward and sit on
  a stretch of even gap width (`BRIDGE_CLEAR` — no line ends/junctions).
  The first anchor also favours the island centroid (`CENTER_WEIGHT`) so
  elongated islands are not held at one end. Strips overshoot only
  `BRIDGE_BITE` — a longer overshoot pokes through thin parts. Near-duplicates (two islands
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
with trimesh: `is_watertight`, exactly one body, bbox. Faster for geometry
changes: `bun run cli samples/<x>.svg -o <tmp>/x` and the same trimesh check
(no worker rebuild needed) — but it goes through `svg-headless.ts`, so
changes to `svg.ts` still need the browser path.
