// generation orchestration on top of manifold-3d: contours + params ->
// triangles and UI data (no DOM — runs in the worker)
//
// The whole stencil is 2D work on CrossSections — plate outline minus the
// dusting openings, islands tied back with bridges — and a single extrude,
// so the output is manifold (watertight) by construction.
import type { Contour, GenResult, Params, Pt } from './types';
import { boundsAll, ccw, pointInPoly, rdp, signedArea } from './geo2d';
import { getManifold } from './manifold';
import type { CrossSection, ManifoldToplevel } from './manifold';

const EPS = 0.03;        // contour simplification tolerance [mm]
const SEARCH_EPS = 0.15; // coarser outlines for the bridge distance search [mm]
const CIRCLE_SEG = 180;  // plate circle segments
const RIM = 3;           // minimum solid rim around the openings [mm]
const FILLET = 4;        // rounding where the handle meets the plate [mm]

/** WASM objects must be freed by hand; collect them and dispose at the end */
class Scope {
  private objs: { delete(): void }[] = [];
  t<T extends { delete(): void }>(o: T): T {
    this.objs.push(o);
    return o;
  }
  dispose(): void {
    for (const o of this.objs) {
      try { o.delete(); } catch { /* already deleted */ }
    }
  }
}

const toVecs = (l: Pt[]): [number, number][] => l.map(p => [p.x, p.y]);
const fromPolys = (polys: ArrayLike<number>[][]): Pt[][] =>
  Array.from(polys, pl => Array.from(pl, v => ({ x: v[0]!, y: v[1]! })));

/**
 * Orients contours by nesting depth (even = CCW outline, odd = CW hole), so
 * a NonZero union fills letters with counters correctly while overlapping
 * separate shapes still merge instead of cancelling out.
 */
export function orientByNesting(contours: Pt[][]): Pt[][] {
  const areas = contours.map(c => Math.abs(signedArea(c)));
  return contours.map((c, i) => {
    const depth = contours.filter((d, j) =>
      j !== i && areas[j]! > areas[i]! && pointInPoly(c[0]!, d)).length;
    const o = ccw(c);
    return depth % 2 ? [...o].reverse() : o;
  });
}

const closestOnSeg = (p: Pt, a: Pt, b: Pt): Pt => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + k * dx, y: a.y + k * dy };
};

/** Closest point pair between two loop sets (vertex-to-segment both ways); p on a, q on b */
function nearestPair(a: Pt[][], b: Pt[][], limit: number): { d: number; p: Pt; q: Pt } | null {
  let best: { d: number; p: Pt; q: Pt } | null = null;
  let bestD = limit * limit;
  const scan = (from: Pt[][], to: Pt[][], swap: boolean) => {
    for (const loop of from) {
      for (const v of loop) {
        for (const t of to) {
          for (let i = 0; i < t.length; i++) {
            const c = closestOnSeg(v, t[i]!, t[(i + 1) % t.length]!);
            const d = (c.x - v.x) ** 2 + (c.y - v.y) ** 2;
            if (d < bestD) {
              bestD = d;
              best = swap ? { d, p: c, q: v } : { d, p: v, q: c };
            }
          }
        }
      }
    }
  };
  scan(a, b, false);
  scan(b, a, true);
  return best;
}

/** Strip of width w from p to q, overshooting both ends by w so it bites into both parts */
function bridgeStrip(p: Pt, q: Pt, w: number): Pt[] {
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  const ux = len > 1e-9 ? (q.x - p.x) / len : 1, uy = len > 1e-9 ? (q.y - p.y) / len : 0;
  const nx = -uy * w / 2, ny = ux * w / 2;
  const a = { x: p.x - ux * w, y: p.y - uy * w }, b = { x: q.x + ux * w, y: q.y + uy * w };
  return ccw([
    { x: a.x - nx, y: a.y - ny }, { x: b.x - nx, y: b.y - ny },
    { x: b.x + nx, y: b.y + ny }, { x: a.x + nx, y: a.y + ny },
  ]);
}

/** The plate body holds the outer boundary, so its bounding box is the largest */
function bodyIndex(parts: CrossSection[]): number {
  const bboxArea = (c: CrossSection) => {
    const r = c.bounds();
    return (r.max[0] - r.min[0]) * (r.max[1] - r.min[1]);
  };
  return parts.reduce((bi, c, i) => bboxArea(c) > bboxArea(parts[bi]!) ? i : bi, 0);
}

export async function generate(raw: Contour[], p: Params): Promise<GenResult> {
  const wasm = await getManifold();
  const scope = new Scope();
  try {
    return build(wasm, scope, raw, p);
  } finally {
    scope.dispose();
  }
}

function build(wasm: ManifoldToplevel, S: Scope, raw: Contour[], p: Params): GenResult {
  if (!raw.length) throw new Error('No contours.');
  const sizeOk = p.fit === 'height' ? p.motifH > 0 : p.motifW > 0 && (p.fit !== 'both' || p.motifH > 0);
  if (!(sizeOk && p.plateD > 2 * RIM && p.thickness > 0 && p.bridgeW > 0)) throw new Error('Invalid parameters.');

  const { CrossSection, Manifold } = wasm;
  const circle = (r: number, x = 0, y = 0, seg = CIRCLE_SEG): CrossSection =>
    S.t(S.t(CrossSection.circle(r, seg)).translate(x, y));

  // motif -> scale to the target size, center on the plate
  const b0 = boundsAll(raw.map(c => c.pts));
  const sx = p.fit === 'height' ? p.motifH / b0.h : p.motifW / b0.w;
  const sy = p.fit === 'both' ? p.motifH / b0.h : sx;
  const xf = (pt: Pt): Pt => ({ x: (pt.x - (b0.minx + b0.maxx) / 2) * sx, y: (pt.y - (b0.miny + b0.maxy) / 2) * sy });
  const motifLoops = raw.map(c => rdp(c.pts.map(xf), EPS));
  const motif = S.t(new CrossSection(orientByNesting(motifLoops).map(toVecs), 'NonZero'));

  // plate outline: disc + rounded handle toward -y (toward the person holding it)
  const R = p.plateD / 2;
  let outline = circle(R);
  if (p.tabLen > 0 && p.tabW > 0) {
    const tabW = Math.min(p.tabW, p.plateD);
    const cy = -(R + Math.max(p.tabLen, tabW / 2) - tabW / 2); // center of the rounded end
    const stem = S.t(S.t(CrossSection.square([tabW, -cy])).translate(-tabW / 2, cy));
    outline = S.t(S.t(outline.add(stem)).add(circle(tabW / 2, 0, cy, 64)));
    // closing rounds the concave corners where the handle joins the disc
    outline = S.t(S.t(outline.offset(FILLET, 'Round', 2, 64)).offset(-FILLET, 'Round', 2, 64));
    const holeD = Math.min(p.holeD, tabW - 2 * RIM);
    if (holeD > 0 && -cy - holeD / 2 >= R + RIM) outline = S.t(outline.subtract(circle(holeD / 2, 0, cy, 64)));
  }

  // dusting openings, always kept inside a solid rim
  const usable = circle(Math.max(R - RIM, 1));
  let openings: CrossSection;
  let clipped: boolean;
  let windowD: number | null = null;
  const motifArea = motif.area();
  if (p.mode === 'positive') {
    openings = S.t(motif.intersect(usable));
    clipped = motifArea - openings.area() > 1e-3;
  } else {
    windowD = Math.min(p.windowD, p.plateD - 2 * RIM);
    const win = circle(windowD / 2);
    openings = S.t(win.subtract(motif));
    clipped = motifArea - S.t(motif.intersect(win)).area() > 1e-3;
  }
  let plate = S.t(outline.subtract(openings));

  // islands: parts not connected to the plate body. Specks too small to hold
  // a bridge are left open; the rest is tied to the nearest other part until
  // everything is one piece (greedy — each bridge merges two parts)
  const minIsland = 2 * p.bridgeW * p.bridgeW;
  const bridgeLoops: Pt[][] = [];
  let bridgeCount = 0, dropped = 0;
  for (let guard = 0; guard < 500; guard++) {
    const parts = plate.decompose().map(c => S.t(c));
    if (parts.length <= 1) break;
    const bodyIdx = bodyIndex(parts);
    const specks = parts.filter((c, i) => i !== bodyIdx && c.area() < minIsland);
    if (specks.length) {
      for (const s of specks) plate = S.t(plate.subtract(s));
      dropped += specks.length;
      continue;
    }

    const loops = parts.map(c => fromPolys(c.toPolygons()).map(l => rdp(l, SEARCH_EPS)));
    const boxes = loops.map(l => boundsAll(l));
    let best: { d: number; p: Pt; q: Pt } | null = null;
    for (let i = 0; i < parts.length; i++) {
      if (i === bodyIdx) continue;
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const bi = boxes[i]!, bj = boxes[j]!;
        const gap = Math.hypot(Math.max(0, bi.minx - bj.maxx, bj.minx - bi.maxx), Math.max(0, bi.miny - bj.maxy, bj.miny - bi.maxy));
        const limit: number = best ? Math.sqrt(best.d) : Infinity;
        if (gap >= limit) continue;
        best = nearestPair(loops[i]!, loops[j]!, limit) ?? best;
      }
    }
    if (!best) break;
    const strip = S.t(S.t(new CrossSection([toVecs(bridgeStrip(best.p, best.q, p.bridgeW))])).intersect(outline));
    plate = S.t(plate.add(strip));
    bridgeLoops.push(...fromPolys(strip.toPolygons()));
    bridgeCount++;
    if (plate.decompose().map(c => S.t(c)).length >= parts.length) break; // no progress — give up
  }
  // anything still loose would fall out of the print
  {
    const parts = plate.decompose().map(c => S.t(c));
    const bodyIdx = bodyIndex(parts);
    parts.forEach((c, i) => {
      if (i !== bodyIdx) { plate = S.t(plate.subtract(c)); dropped++; }
    });
  }

  const solid = S.t(Manifold.extrude(plate, p.thickness));
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.triVerts.length * 3);
  for (let i = 0; i < mesh.triVerts.length; i++) {
    const v = mesh.triVerts[i]! * mesh.numProp;
    positions.set([mesh.vertProperties[v]!, mesh.vertProperties[v + 1]!, mesh.vertProperties[v + 2]!], i * 3);
  }

  const plateLoops = fromPolys(plate.toPolygons());
  const mb = boundsAll(motifLoops);
  const tb = boundsAll(plateLoops);
  return {
    positions, plateLoops, bridgeLoops, motifLoops,
    contourCount: raw.length, bridgeCount, droppedIslands: dropped, clipped, windowD,
    motifSize: { w: mb.w, h: mb.h }, totalSize: { w: tb.w, h: tb.h },
  };
}
