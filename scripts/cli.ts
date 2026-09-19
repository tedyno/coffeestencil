#!/usr/bin/env bun
// Headless latte-art stencil generator: SVG/PNG/JPG/WEBP -> STL (+ 3MF), no
// browser. Mirrors the web UI's options; run with --help for the list.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { Contour, Params, SizeFit, StencilMode } from '../src/types';
import { extractContours } from '../src/svg-headless';
import { traceImage } from '../src/raster';
import { boundsAll } from '../src/geo2d';
import { buildThreeMf } from '../src/threemf';

const USAGE = `usage: coffeestencil <input> [options]

<input> is an SVG/PNG/JPG/WEBP file, an http(s)/data: URL, or - for stdin.

Output
  -o, --out PATH        output path (default <name>_stencil.stl in the cwd);
                        a .3mf extension writes only 3MF
  --3mf                 also write a 3MF next to the STL

Dust
  --mode MODE           positive = the motif is cut out (default)
                        negative = around the motif, the motif stays light

Motif size (mm)
  --width N             motif width; alone keeps the aspect
  --height N            motif height; alone keeps the aspect,
                        with --width stretches to both
                        (neither: the longer side follows the preset)

Stencil (defaults from the preset)
  --preset NAME         espresso | cappuccino | mug (default cappuccino)
  --plate N             plate diameter
  --window N            dusting window diameter (negative mode)
  --thickness N         plate thickness (default 1.2)
  --bridge-w N          bridge width (default 1.5)
  --bridges N           bridges per island 0-6, 0 = auto (default 0)
  --corner-r N          corner rounding 0-2 (default 0.3)
  --tab-len N           handle length, 0 = no handle (default 35)
  --tab-w N             handle width (default 24)
  --hole N              hanging hole, 0 = none (default 6)

Raster vectorization (PNG/JPG/WEBP)
  --threshold N         brightness threshold 1-254 (default 128)
  --invert              light shapes on a dark background
  --simplify N          simplification 0.5-8 px (default 2)
  --smooth N            smoothing iterations 0-3 (default 1)

SVG
  --keep-background     keep full-bbox rectangles (a square motif or frame)
                        that are otherwise dropped as background plates

  -h, --help            show this help`;

// cup presets — keep in sync with PRESETS in src/app.ts
const PRESETS: Record<string, { plateD: number; windowD: number; motif: number }> = {
  espresso: { plateD: 85, windowD: 55, motif: 45 },
  cappuccino: { plateD: 110, windowD: 80, motif: 60 },
  mug: { plateD: 120, windowD: 90, motif: 70 },
};

const FLAGS = new Set(['3mf', 'invert', 'keep-background', 'help']);
const VALUES = new Set(['out', 'mode', 'width', 'height', 'preset', 'plate', 'window', 'thickness',
  'bridge-w', 'bridges', 'corner-r', 'tab-len', 'tab-w', 'hole', 'threshold', 'simplify', 'smooth']);

function fail(msg: string): never {
  console.error(`error: ${msg}\nrun with --help for the options`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') opt.help = 'true';
    else if (a === '-o') opt.out = argv[++i] ?? fail('-o needs a value');
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (FLAGS.has(k) && eq < 0) opt[k] = 'true';
      else if (VALUES.has(k)) opt[k] = eq > 0 ? a.slice(eq + 1) : argv[++i] ?? fail(`--${k} needs a value`);
      else fail(`unknown option ${a}`);
    } else if (a.startsWith('-') && a !== '-') fail(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, opt };
}

function numOpt(opt: Record<string, string>, k: string, d: number): number {
  if (opt[k] === undefined) return d;
  const v = Number(opt[k]);
  if (!Number.isFinite(v)) fail(`--${k} must be a number, got "${opt[k]}"`);
  return v;
}

function enumOpt<T extends string>(opt: Record<string, string>, k: string, allowed: readonly T[], d: T): T {
  const v = opt[k] ?? d;
  if (!(allowed as readonly string[]).includes(v)) fail(`--${k} must be one of ${allowed.join(', ')}`);
  return v as T;
}

/** Reads the input as bytes plus a base name for the output files */
async function readInput(src: string): Promise<{ bytes: Uint8Array; name: string; type: string }> {
  if (src === '-') return { bytes: new Uint8Array(await Bun.stdin.arrayBuffer()), name: 'pasted', type: '' };
  if (/^(https?|data):/i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${src}`);
    const name = src.startsWith('data:') ? 'pasted' : decodeURIComponent(new URL(src).pathname.split('/').pop() || 'pasted');
    return { bytes: new Uint8Array(await res.arrayBuffer()), name, type: res.headers.get('content-type') || '' };
  }
  if (!existsSync(src)) throw new Error(`file not found: ${src}`);
  return { bytes: readFileSync(src), name: basename(src), type: '' };
}

const isSvg = (name: string, type: string, bytes: Uint8Array): boolean =>
  /\.svg$/i.test(name) || type.includes('svg') ||
  /<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)));

/** Raster -> RGBA, downscaled to max 1024 px like the web app, then traced */
async function traceRaster(bytes: Uint8Array, opt: Record<string, string>): Promise<Contour[]> {
  const { data, info } = await sharp(bytes)
    .rotate() // honour EXIF orientation like createImageBitmap
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const img = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) } as ImageData;
  return traceImage(img, {
    threshold: numOpt(opt, 'threshold', 128),
    invert: opt.invert === 'true',
    simplify: numOpt(opt, 'simplify', 2),
    smooth: Math.round(numOpt(opt, 'smooth', 1)),
  });
}

/** Generation imports the manifold WASM from src/manifold-wasm.ts (gitignored,
 *  written by build-worker) — create it on first use so no build step is needed */
function ensureManifoldWasm(): void {
  const root = join(import.meta.dir, '..');
  const target = join(root, 'src/manifold-wasm.ts');
  if (existsSync(target)) return;
  const wasm = readFileSync(join(root, 'node_modules/manifold-3d/manifold.wasm'));
  writeFileSync(target, `// generated by scripts/build-worker.ts — do not edit\nexport default '${wasm.toString('base64')}';\n`);
}

// binary STL from a triangle soup (xyz by 9), recomputing per-face normals
function buildStl(positions: Float32Array): Uint8Array {
  const tris = positions.length / 9;
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  let real = 0, off = 84;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const f = [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz];
    for (let k = 0; k < 12; k++) { dv.setFloat32(off, f[k]!, true); off += 4; }
    off += 2; // attribute byte count
    real++;
  }
  dv.setUint32(80, real, true);
  return new Uint8Array(buf);
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  if (opt.help) { console.log(USAGE); return; }
  if (pos.length !== 1) fail(pos.length ? 'expected a single input' : 'missing input');

  const preset = PRESETS[enumOpt(opt, 'preset', Object.keys(PRESETS), 'cappuccino')]!;
  const bridges = numOpt(opt, 'bridges', 0);
  if (!Number.isInteger(bridges) || bridges < 0) fail('--bridges must be a whole number >= 0');

  const input = await readInput(pos[0]!);
  const svg = isSvg(input.name, input.type, input.bytes);
  const contours = svg
    ? extractContours(new TextDecoder().decode(input.bytes), { keepBackground: opt['keep-background'] === 'true' })
    : await traceRaster(input.bytes, opt);
  const name = input.name.replace(/\.[a-z0-9]+$/i, '') || 'motif';

  // one given axis drives the scale (aspect kept), both given stretch;
  // neither = the motif's longer side matches the preset, as in the web app
  const b = boundsAll(contours.map(c => c.pts));
  const hasW = opt.width !== undefined, hasH = opt.height !== undefined;
  const fit: SizeFit = hasW && hasH ? 'both' : hasH || (!hasW && b.h > b.w) ? 'height' : 'width';
  const params: Params = {
    motifW: numOpt(opt, 'width', preset.motif),
    motifH: numOpt(opt, 'height', preset.motif),
    fit,
    mode: enumOpt<StencilMode>(opt, 'mode', ['positive', 'negative'], 'positive'),
    plateD: numOpt(opt, 'plate', preset.plateD),
    windowD: numOpt(opt, 'window', preset.windowD),
    thickness: numOpt(opt, 'thickness', 1.2),
    bridgeW: numOpt(opt, 'bridge-w', 1.5),
    bridges,
    cornerR: numOpt(opt, 'corner-r', 0.3),
    tabLen: numOpt(opt, 'tab-len', 35),
    tabW: numOpt(opt, 'tab-w', 24),
    holeD: numOpt(opt, 'hole', 6),
  };

  ensureManifoldWasm();
  const { generate } = await import('../src/generate');
  const r = await generate(contours, params);

  console.log(`${input.name}: Contours: ${r.contourCount}`);
  console.log(`  Bridges: ${r.bridgeCount}`);
  if (r.droppedIslands) console.log(`  Specks left open: ${r.droppedIslands}`);
  console.log(`  Motif: ${r.motifSize.w.toFixed(1)} × ${r.motifSize.h.toFixed(1)} mm`);
  console.log(`  Overall size: ${r.totalSize.w.toFixed(1)} × ${r.totalSize.h.toFixed(1)} × ${params.thickness.toFixed(1)} mm`);
  console.log(`  Triangles: ${r.positions.length / 9}`);
  if (r.clipped) console.warn('warning: the motif does not fit — it is clipped to the plate rim / window');

  const out = opt.out ?? `${name}_stencil.stl`;
  const only3mf = /\.3mf$/i.test(out);
  const stem = out.replace(/\.(stl|3mf)$/i, '');
  if (!only3mf) {
    writeFileSync(`${stem}.stl`, buildStl(r.positions));
    console.log(`  -> ${stem}.stl`);
  }
  if (only3mf || opt['3mf']) {
    const blob = buildThreeMf(r.positions, basename(stem));
    writeFileSync(`${stem}.3mf`, new Uint8Array(await blob.arrayBuffer()));
    console.log(`  -> ${stem}.3mf`);
  }
}

main().catch(e => { console.error('error:', e instanceof Error ? e.message : e); process.exit(1); });
