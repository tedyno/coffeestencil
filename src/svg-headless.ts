// Headless SVG -> contours, mirroring svg.ts but without the DOM.
// Beziers/arcs are flattened analytically (no getPointAtLength), transforms
// are composed by walking the parsed tree, shapes are converted to polylines.
// Output contract matches extractContours() in svg.ts.
import { XMLParser } from 'fast-xml-parser';
import type { Contour, Pt } from './types';
import { bounds, signedArea } from './geo2d';
import { expandStroke } from './clipper2d';

// ---- affine matrices: [a, b, c, d, e, f] (column-major like SVG) ----
type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const apply = (m: Mat, x: number, y: number): Pt =>
  ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const scaleOf = (m: Mat): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

function parseTransform(s: string): Mat {
  let m: Mat = IDENT;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(s))) {
    const a = g[2]!.split(/[\s,]+/).map(Number).filter(v => !Number.isNaN(v));
    let t: Mat = IDENT;
    switch (g[1]) {
      case 'matrix': t = [a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!]; break;
      case 'translate': t = [1, 0, 0, 1, a[0]!, a[1] ?? 0]; break;
      case 'scale': t = [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0]; break;
      case 'rotate': {
        const r = (a[0]! * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
        const rot: Mat = [cs, sn, -sn, cs, 0, 0];
        t = a.length >= 3
          ? mul(mul([1, 0, 0, 1, a[1]!, a[2]!], rot), [1, 0, 0, 1, -a[1]!, -a[2]!])
          : rot;
        break;
      }
      case 'skewX': t = [1, 0, Math.tan((a[0]! * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan((a[0]! * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

// ---- path data -> subpaths (already flattened to points) ----
interface Sub { pts: Pt[]; closed: boolean }
const TOK = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
const CUBIC_STEPS = 30, QUAD_STEPS = 24;

function sampleArc(cur: Pt, rx0: number, ry0: number, rotDeg: number, laf: number, sf: number, end: Pt, out: Pt[]): void {
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) { out.push(end); return; }
  const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (cur.x - end.x) / 2, dy = (cur.y - end.y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = laf === sf ? -1 : 1;
  let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  num = Math.max(0, num);
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const co = sign * Math.sqrt(num / (den || 1e-12));
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cp * cxp - sp * cyp + (cur.x + end.x) / 2;
  const cy = sp * cxp + cp * cyp + (cur.y + end.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const d = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1e-12;
    let a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / d)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sf && dt > 0) dt -= 2 * Math.PI;
  if (sf && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * 64));
  for (let k = 1; k <= n; k++) {
    const th = t1 + (dt * k) / n;
    const ex = Math.cos(th) * rx, ey = Math.sin(th) * ry;
    out.push({ x: cp * ex - sp * ey + cx, y: sp * ex + cp * ey + cy });
  }
}

function flattenPath(d: string): Sub[] {
  const tok = d.match(TOK) || [];
  let i = 0, cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;       // current + subpath start
  let pcx = 0, pcy = 0, pqx = 0, pqy = 0;   // last cubic / quad control (for S / T)
  const subs: Sub[] = [];
  let cur: Pt[] = [];
  const num = () => parseFloat(tok[i++]!);
  const push = (x: number, y: number) => cur.push({ x, y });
  const startSub = (x: number, y: number) => {
    if (cur.length > 1) subs.push({ pts: cur, closed: false });
    cur = [{ x, y }];
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    for (let k = 1; k <= CUBIC_STEPS; k++) {
      const t = k / CUBIC_STEPS, u = 1 - t;
      push(
        u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
        u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
      );
    }
    pcx = x2; pcy = y2; cx = x; cy = y;
  };
  const quad = (x1: number, y1: number, x: number, y: number) => {
    for (let k = 1; k <= QUAD_STEPS; k++) {
      const t = k / QUAD_STEPS, u = 1 - t;
      push(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y);
    }
    pqx = x1; pqy = y1; cx = x; cy = y;
  };
  while (i < tok.length) {
    if (/^[A-Za-z]$/.test(tok[i]!)) cmd = tok[i++]!;
    else if (cmd === 'M') cmd = 'L';
    else if (cmd === 'm') cmd = 'l';
    const rel = cmd === cmd.toLowerCase();
    const isCubic = 'Cc'.includes(cmd), isQuad = 'Qq'.includes(cmd);
    switch (cmd.toUpperCase()) {
      case 'M': { let x = num(), y = num(); if (rel) { x += cx; y += cy; } cx = sx = x; cy = sy = y; startSub(x, y); break; }
      case 'L': { let x = num(), y = num(); if (rel) { x += cx; y += cy; } cx = x; cy = y; push(x, y); break; }
      case 'H': { let x = num(); if (rel) x += cx; cx = x; push(x, cy); break; }
      case 'V': { let y = num(); if (rel) y += cy; cy = y; push(cx, y); break; }
      case 'C': { let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num(); if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; } cubic(x1, y1, x2, y2, x, y); break; }
      case 'S': { let x2 = num(), y2 = num(), x = num(), y = num(); if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; } const rx = 2 * cx - pcx, ry = 2 * cy - pcy; cubic(rx, ry, x2, y2, x, y); break; }
      case 'Q': { let x1 = num(), y1 = num(), x = num(), y = num(); if (rel) { x1 += cx; y1 += cy; x += cx; y += cy; } quad(x1, y1, x, y); break; }
      case 'T': { let x = num(), y = num(); if (rel) { x += cx; y += cy; } const rx = 2 * cx - pqx, ry = 2 * cy - pqy; quad(rx, ry, x, y); break; }
      case 'A': { const rx = num(), ry = num(), rot = num(), laf = num(), sf = num(); let x = num(), y = num(); if (rel) { x += cx; y += cy; } sampleArc({ x: cx, y: cy }, rx, ry, rot, laf, sf, { x, y }, cur); cx = x; cy = y; break; }
      case 'Z': { cx = sx; cy = sy; if (cur.length > 1) subs.push({ pts: cur, closed: true }); cur = [{ x: cx, y: cy }]; break; }
      default: i++; // skip unknown token
    }
    if (!isCubic && cmd.toUpperCase() !== 'S') { pcx = cx; pcy = cy; }
    if (!isQuad && cmd.toUpperCase() !== 'T') { pqx = cx; pqy = cy; }
  }
  if (cur.length > 1) subs.push({ pts: cur, closed: false });
  return subs;
}

// ---- basic shapes -> subpaths ----
const N_CIRCLE = 96;
function shapeSubs(tag: string, a: Record<string, string>): Sub[] {
  const n = (k: string) => parseFloat(a[k] || '0');
  switch (tag) {
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (w <= 0 || h <= 0) return [];
      return [{ pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true }];
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return [];
      const pts: Pt[] = [];
      for (let k = 0; k < N_CIRCLE; k++) { const t = (k / N_CIRCLE) * 2 * Math.PI; pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry }); }
      return [{ pts, closed: true }];
    }
    case 'line': {
      return [{ pts: [{ x: n('x1'), y: n('y1') }, { x: n('x2'), y: n('y2') }], closed: false }];
    }
    case 'polygon':
    case 'polyline': {
      const nums = (a.points || '').split(/[\s,]+/).map(Number).filter(v => !Number.isNaN(v));
      const pts: Pt[] = [];
      for (let k = 0; k + 1 < nums.length; k += 2) pts.push({ x: nums[k]!, y: nums[k + 1]! });
      return pts.length >= 2 ? [{ pts, closed: tag === 'polygon' }] : [];
    }
    case 'path':
      return flattenPath(a.d || '');
  }
  return [];
}

// ---- style resolution (presentation attrs < <style> rules < inline style, inherited) ----
interface Style { fill: string; stroke: string; strokeWidth: number }
type Decls = Record<string, string>;
function parseDecls(s: string): Decls {
  const out: Decls = {};
  for (const part of s.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// <style> blocks — only plain `.class` and `tag` selectors (what editors
// like Illustrator emit, e.g. `.st0{fill:none;stroke:#000}`); the browser
// app gets full CSS for free via getComputedStyle
interface Rules { cls: Map<string, Decls>; tag: Map<string, Decls> }
function parseRules(css: string, rules: Rules): void {
  const re = /([^{}]+)\{([^}]*)\}/g;
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const decls = parseDecls(m[2]!);
    for (const sel of m[1]!.split(',').map(x => x.trim())) {
      const map = /^\.[\w-]+$/.test(sel) ? rules.cls : /^[a-z]+$/i.test(sel) ? rules.tag : null;
      const key = sel.replace(/^\./, '');
      if (map) map.set(key, { ...map.get(key), ...decls });
    }
  }
}

function resolveStyle(tag: string, a: Record<string, string>, parent: Style, rules: Rules): Style {
  const fromRules: Decls = { ...rules.tag.get(tag) };
  for (const c of (a.class || '').split(/\s+/)) Object.assign(fromRules, rules.cls.get(c));
  const inline = parseDecls(a.style || '');
  const pick = (k: string) => inline[k] ?? fromRules[k] ?? a[k];
  return {
    fill: (pick('fill') ?? parent.fill),
    stroke: (pick('stroke') ?? parent.stroke),
    strokeWidth: parseFloat(pick('stroke-width') ?? '') || parent.strokeWidth,
  };
}

const SHAPES = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);

/** Text content of all <style> elements in the parsed tree */
function styleText(nodes: any[]): string {
  let out = '';
  for (const node of nodes) {
    const tag = Object.keys(node).find(k => k !== ':@');
    if (!tag || !Array.isArray(node[tag])) continue;
    if (tag === 'style') out += node[tag].map((c: any) => c['#text'] ?? '').join('') + '\n';
    else out += styleText(node[tag]);
  }
  return out;
}

export interface ExtractOpts {
  /** keep full-bbox rectangles (a square motif or frame) instead of dropping them as backgrounds */
  keepBackground?: boolean;
}

export function extractContours(svgText: string, opts: ExtractOpts = {}): Contour[] {
  const parser = new XMLParser({
    preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
  });
  const tree = parser.parse(svgText);
  const contours: Contour[] = [];
  const rules: Rules = { cls: new Map(), tag: new Map() };
  parseRules(styleText(tree), rules);

  const walk = (nodes: any[], mat: Mat, style: Style): void => {
    for (const node of nodes) {
      const tag = Object.keys(node).find(k => k !== ':@');
      if (!tag || tag === '#text' || tag === '?xml') continue;
      const attrs: Record<string, string> = node[':@'] || {};
      const local = attrs.transform ? mul(mat, parseTransform(attrs.transform)) : mat;
      const st = resolveStyle(tag, attrs, style, rules);
      const children = node[tag];

      if (SHAPES.has(tag)) {
        const stroked = st.fill === 'none' && st.stroke !== 'none' && st.stroke !== '';
        const strokeW = stroked ? st.strokeWidth * scaleOf(local) : 0;
        for (const sub of shapeSubs(tag, attrs)) {
          const pts = sub.pts.map(p => { const q = apply(local, p.x, p.y); return { x: q.x, y: -q.y }; });
          if (strokeW > 0) {
            for (const poly of expandStroke(pts, strokeW, sub.closed)) {
              const area = Math.abs(signedArea(poly));
              if (area > 1e-6) contours.push({ pts: poly, area });
            }
          } else {
            const area = Math.abs(signedArea(pts));
            if (area > 1e-6) contours.push({ pts, area });
          }
        }
      }
      if (Array.isArray(children)) walk(children, local, st);
    }
  };

  walk(tree, IDENT, { fill: 'black', stroke: 'none', strokeWidth: 1 });
  if (!contours.length) throw new Error('No usable outlines found in the SVG.');

  // Drop full-bbox rectangular backgrounds/frames (a near-1.0 fill ratio means
  // the loop just traces its bounding box) when actual artwork exists. The
  // browser app shows the preview so a stray plate gets noticed; headless it
  // would silently swallow the whole motif.
  let kept = contours;
  if (contours.length >= 2 && !opts.keepBackground) {
    const art = contours.filter(c => { const b = bounds(c.pts); return c.area / (b.w * b.h || 1) <= 0.985; });
    if (art.length) kept = art;
  }
  // stencils live on fine details (eyes, whiskers) — only real specks go
  const maxArea = Math.max(...kept.map(c => c.area));
  return kept.filter(c => c.area > maxArea * 0.0003).sort((a, b) => b.area - a.area);
}
