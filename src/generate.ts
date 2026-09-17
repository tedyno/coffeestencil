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
const ROUND_SEG = 32;    // circular segments of the corner rounding
const MIN_EDGE = 0.01;   // outline simplification before extrusion [mm]
const BRIDGE_SPACING = 20; // auto mode: one bridge per this much island extent [mm]
const MAX_BRIDGES = 6;
const BRIDGE_GAP = 3;    // minimum clearance between two bridges [mm]
const BRIDGE_BITE = 0.4;  // bridge overshoot into the parts it joins [mm]
const CENTER_WEIGHT = 0.3; // first anchor: mm of bridge length traded per mm closer to the island centroid
const BRIDGE_CLEAR = 3;  // straight, even gap required beside a bridge anchor [mm]
const SAMPLE_STEP = 0.5; // island outline sampling for bridge anchors [mm]

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

/** Nearest point on a set of closed loops */
function nearestOn(p: Pt, loops: Pt[][]): { d: number; q: Pt } {
  let d = Infinity, q = p;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const c = closestOnSeg(p, l[i]!, l[(i + 1) % l.length]!);
      const e = Math.hypot(c.x - p.x, c.y - p.y);
      if (e < d) { d = e; q = c; }
    }
  }
  return { d, q };
}

/**
 * Bridge anchors spread evenly around an island. Its outline is sampled and
 * a sample is a valid anchor only where the bridge crosses the gap cleanly:
 * the sample and its nearest point on the other parts are mutually nearest
 * (so the bridge runs straight across, never obliquely), it points outward,
 * and the gap keeps its width along the bridge's own width either side (no
 * line ends, junctions or crossings). The valid anchor with the best mix of
 * shortness and closeness to the island centroid
 * takes the first bridge, the rest sit at equal arc length steps from it,
 * each the shortest valid one within the middle half of its arc (or the
 * whole arc when the middle has none).
 */
function spreadBridges(outer: Pt[], targets: Pt[][], n: number, w: number): { p: Pt; q: Pt }[] {
  const loop = ccw(outer);
  const samples: { s: number; p: Pt; nx: number; ny: number }[] = [];
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    // CCW loop: the interior is on the left, outward is the right normal
    const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    for (let t = 0; t < len; t += SAMPLE_STEP) {
      samples.push({ s: s + t, p: { x: a.x + (b.x - a.x) * t / len, y: a.y + (b.y - a.y) * t / len }, nx, ny });
    }
    s += len;
  }
  const L = s;

  const near = samples.map(({ p, nx, ny }) => {
    const { d, q } = nearestOn(p, targets);
    const mutual = nearestOn(q, [loop]).d > d - SAMPLE_STEP * 0.5 && // p is (about) the closest to q
      (q.x - p.x) * nx + (q.y - p.y) * ny > 0.9 * d;
    return { d, q, mutual };
  });
  // gap width must hold steady over the bridge and a clearance either side,
  // keeping bridges off line ends, junctions and crossings
  const reach = Math.max(1, Math.ceil((w / 2 + BRIDGE_CLEAR) / SAMPLE_STEP));
  const m = samples.length;
  const found = near.map((f, i) => {
    let ok = f.mutual;
    for (let k = -reach; ok && k <= reach; k++) {
      ok = Math.abs(near[(i + k + m) % m]!.d - f.d) <= 0.25 * f.d + 0.1;
    }
    return { d: f.d, q: ok ? f.q : null };
  });

  const pick = (from: number, to: number, score: (i: number) => number): number => {
    let bi = -1;
    samples.forEach((sm, i) => {
      const u = ((sm.s - from) % L + L) % L; // circular distance past `from`
      if (u <= to - from && found[i]!.q && (bi < 0 || score(i) < score(bi))) bi = i;
    });
    return bi;
  };
  // the first bridge holds the island near its centroid — an anchor at one
  // end of an elongated island leaves the rest as a lever that snaps off
  const c = centroid(loop);
  const first = pick(0, L, i => found[i]!.d + CENTER_WEIGHT * Math.hypot(samples[i]!.p.x - c.x, samples[i]!.p.y - c.y));
  if (first < 0) return [];
  const chosen = new Set([first]);
  const s0 = samples[first]!.s;
  for (let k = 1; k < n; k++) {
    const center = s0 + k * L / n;
    const byLength = (j: number) => found[j]!.d;
    // middle half of the arc keeps the spacing even; the whole arc is the
    // fallback when a junction or line end blocks the middle
    let i = pick(center - L / (4 * n), center + L / (4 * n), byLength);
    if (i < 0) i = pick(center - L / (2 * n), center + L / (2 * n), byLength);
    if (i >= 0) chosen.add(i);
  }
  return [...chosen].map(i => ({ p: samples[i]!.p, q: found[i]!.q! }));
}

/** Area centroid of a closed loop */
function centroid(pts: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!;
    const k = p.x * q.y - q.x * p.y;
    a += k;
    cx += (p.x + q.x) * k;
    cy += (p.y + q.y) * k;
  }
  return Math.abs(a) > 1e-12 ? { x: cx / (3 * a), y: cy / (3 * a) } : pts[0]!;
}

/**
 * Strip of width w from p to q, overshooting both ends just by BRIDGE_BITE
 * so it fuses with both parts — a longer overshoot pokes through a thin
 * part into the next opening
 */
function bridgeStrip(p: Pt, q: Pt, w: number): Pt[] {
  const len = Math.hypot(q.x - p.x, q.y - p.y);
  const ux = len > 1e-9 ? (q.x - p.x) / len : 1, uy = len > 1e-9 ? (q.y - p.y) / len : 0;
  const nx = -uy * w / 2, ny = ux * w / 2;
  const a = { x: p.x - ux * BRIDGE_BITE, y: p.y - uy * BRIDGE_BITE };
  const b = { x: q.x + ux * BRIDGE_BITE, y: q.y + uy * BRIDGE_BITE };
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
  let hangHole: CrossSection | null = null;
  if (p.tabLen > 0 && p.tabW > 0) {
    const tabW = Math.min(p.tabW, p.plateD);
    const cy = -(R + Math.max(p.tabLen, tabW / 2) - tabW / 2); // center of the rounded end
    const stem = S.t(S.t(CrossSection.square([tabW, -cy])).translate(-tabW / 2, cy));
    outline = S.t(S.t(outline.add(stem)).add(circle(tabW / 2, 0, cy, 64)));
    // closing rounds the concave corners where the handle joins the disc
    outline = S.t(S.t(outline.offset(FILLET, 'Round', 2, 64)).offset(-FILLET, 'Round', 2, 64));
    const holeD = Math.min(p.holeD, tabW - 2 * RIM);
    if (holeD > 0 && -cy - holeD / 2 >= R + RIM) {
      hangHole = circle(holeD / 2, 0, cy, 64);
      outline = S.t(outline.subtract(hangHole));
    }
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

  // corner rounding: opening (-r, +r) rounds the plate's convex corners,
  // closing (+r, -r) its concave ones. The opening runs before bridging —
  // it would erase bridges narrower than 2r; the closing runs once more
  // after bridging to round the bridge joints
  const r = Math.max(0, p.cornerR);
  const round = (c: CrossSection, d: number): CrossSection =>
    S.t(S.t(c.offset(d, 'Round', 2, ROUND_SEG)).offset(-d, 'Round', 2, ROUND_SEG));
  if (r > 0) plate = round(round(plate, -r), r);

  // islands: parts not connected to the plate body. Specks too small to hold
  // a bridge are left open; every other island gets its bridges spread
  // around it (count by extent, or fixed), then a greedy pass ties anything
  // still loose to its nearest part until everything is one piece
  const minIsland = 2 * p.bridgeW * p.bridgeW;
  const bridgeLoops: Pt[][] = [];
  let bridgeCount = 0, dropped = 0;
  const addBridge = (a: Pt, b: Pt): void => {
    const strip = S.t(S.t(new CrossSection([toVecs(bridgeStrip(a, b, p.bridgeW))])).intersect(outline));
    plate = S.t(plate.add(strip));
    bridgeLoops.push(...fromPolys(strip.toPolygons()));
    bridgeCount++;
  };
  {
    let parts = plate.decompose().map(c => S.t(c));
    let bodyIdx = bodyIndex(parts);
    const specks = parts.filter((c, i) => i !== bodyIdx && c.area() < minIsland);
    if (specks.length) {
      for (const s of specks) plate = S.t(plate.subtract(s));
      dropped += specks.length;
      parts = plate.decompose().map(c => S.t(c));
      bodyIdx = bodyIndex(parts);
    }
    if (parts.length > 1) {
      const loops = parts.map(c => fromPolys(c.toPolygons()).map(l => rdp(l, SEARCH_EPS)));
      const anchors = loops.flatMap((own, i) => {
        if (i === bodyIdx) return [];
        const outer = own.reduce((a, b) => Math.abs(signedArea(a)) >= Math.abs(signedArea(b)) ? a : b);
        const bb = boundsAll([outer]);
        const n = p.bridges > 0
          ? p.bridges
          : Math.max(1, Math.min(MAX_BRIDGES, Math.round(Math.max(bb.w, bb.h) / BRIDGE_SPACING)));
        return spreadBridges(outer, loops.filter((_, j) => j !== i).flat(), Math.min(n, MAX_BRIDGES), p.bridgeW);
      });
      // neighbouring islands tend to bridge to each other at the same spot
      // from both sides — keep only one of such near-duplicates
      const segDist = (a: { p: Pt; q: Pt }, b: { p: Pt; q: Pt }): number => Math.min(
        ...[[a.p, b], [a.q, b], [b.p, a], [b.q, a]].map(([pt, s]) => {
          const { p: sp, q: sq } = s as { p: Pt; q: Pt };
          const c = closestOnSeg(pt as Pt, sp, sq);
          return Math.hypot(c.x - (pt as Pt).x, c.y - (pt as Pt).y);
        }));
      const kept: { p: Pt; q: Pt }[] = [];
      for (const a of anchors) {
        if (kept.some(k => segDist(a, k) < BRIDGE_GAP + p.bridgeW)) continue;
        kept.push(a);
        addBridge(a.p, a.q);
      }
    }
  }
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
    addBridge(best.p, best.q);
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

  if (r > 0) {
    // closing only adds material, so the plate stays one piece; it would
    // also shut a hanging hole of radius <= r, so that one is cut again
    plate = S.t(round(plate, r).intersect(outline));
    if (hangHole) plate = S.t(plate.subtract(hangHole));
  }

  // offsets leave micro-edges that collapse in slicers' vertex welding
  plate = S.t(plate.simplify(MIN_EDGE));
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
