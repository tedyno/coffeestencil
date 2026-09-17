// dimension annotations of edited parameters in the 3D preview: technical
// dimensions with extension lines and arrows; small dimensions get arrows
// outside and the text beside. Colors match the dots next to sidebar inputs.
import * as THREE from 'three';
import type { GenResult, Params } from './types';
import { boundsAll } from './geo2d';
import { t } from './i18n';

export interface Dims {
  /** Group to add into modelGroup (mm, z up) */
  group: THREE.Group;
  /** Redraw dimensions from the generation result and current parameters */
  update(r: GenResult, p: Params): void;
  /** Highlight the dimension of the given parameter, fade others (null = all full) */
  emphasize(id: string | null): void;
}

const COLORS: Record<string, string> = {
  motifW: '#7aa2f7',
  motifH: '#73daca',
  plateD: '#bb9af7',
  windowD: '#ff9e64',
  thickness: '#e0af68',
  tabLen: '#9ece6a',
};

function makeLabel(text: string, color: string, height: number): THREE.Sprite {
  const cv = document.createElement('canvas');
  const font = 'bold 44px -apple-system, BlinkMacSystemFont, sans-serif';
  let ctx = cv.getContext('2d')!;
  ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + 24;
  cv.height = 64;
  ctx = cv.getContext('2d')!; // resizing resets the context state
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(height * cv.width / cv.height, height, 1);
  sprite.renderOrder = 11;
  return sprite;
}

export function createDims(): Dims {
  const group = new THREE.Group();
  const items: Record<string, THREE.Object3D[]> = {};

  function addDimension(id: string, p1: THREE.Vector3, p2: THREE.Vector3,
                        offsetDir: THREE.Vector3, offset: number,
                        label: string, textH: number, labelAt = 0.5): void {
    const color = COLORS[id]!;
    const dn = p2.clone().sub(p1).normalize();
    const len = p2.distanceTo(p1);
    const on = offsetDir.clone().normalize();
    const ext = textH * 0.35;                       // extension line overshoot
    const a = p1.clone().add(on.clone().multiplyScalar(offset));
    const b = p2.clone().add(on.clone().multiplyScalar(offset));
    const as = Math.min(textH * 0.55, len * 0.4);   // arrow size
    const small = len < as * 4.5;                   // arrows do not fit inside

    const pts: THREE.Vector3[] = [
      p1, p1.clone().add(on.clone().multiplyScalar(offset + ext)),  // extension lines
      p2, p2.clone().add(on.clone().multiplyScalar(offset + ext)),
      small ? a.clone().sub(dn.clone().multiplyScalar(as * 2.5)) : a, // dimension line
      small ? b.clone().add(dn.clone().multiplyScalar(as * 2.5)) : b,
    ];
    const wing = (tip: THREE.Vector3, dir: THREE.Vector3) => {
      const base = tip.clone().add(dir.clone().multiplyScalar(as));
      pts.push(tip, base.clone().add(on.clone().multiplyScalar(as * 0.35)));
      pts.push(tip, base.clone().sub(on.clone().multiplyScalar(as * 0.35)));
    };
    wing(a, small ? dn.clone().negate() : dn);      // arrows (outside for small dims)
    wing(b, small ? dn : dn.clone().negate());

    const g = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.renderOrder = 10;
    group.add(line);

    const sprite = makeLabel(label, color, textH);
    if (small) {
      sprite.position.copy(b.clone().add(dn.clone().multiplyScalar(as * 3.2)));
      sprite.center.set(0, 0.5);                    // text after the extended line
    } else if (Math.abs(on.x) > 0.5) {
      // offset sideways: text starts at the line and runs outward, so parallel
      // dimensions (cookie / overall) do not stack their labels on each other
      sprite.position.copy(a.clone().lerp(b, labelAt).add(on.clone().multiplyScalar(textH * 0.3)));
      sprite.center.set(on.x > 0 ? 0 : 1, 0.5);
    } else {
      sprite.position.copy(a.clone().lerp(b, labelAt).add(on.clone().multiplyScalar(textH * 0.8)));
    }
    group.add(sprite);
    (items[id] ??= []).push(line, sprite);
  }

  function update(r: GenResult, p: Params): void {
    group.clear();
    for (const k of Object.keys(items)) delete items[k];

    const bb = boundsAll(r.plateLoops);
    const mb = boundsAll(r.motifLoops);
    const R = p.plateD / 2;
    const T = p.thickness;

    const maxDim = Math.max(bb.w, bb.h);
    const off = Math.max(4, maxDim * 0.08);
    const textH = Math.max(3.5, maxDim * 0.05);
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // motif width + plate diameter above the plate (back side), motif height on the right
    addDimension('motifW',
      v(mb.minx, R, T), v(mb.maxx, R, T), v(0, 1, 0), off,
      t('dim.width', { v: mb.w.toFixed(1) }), textH);
    addDimension('plateD',
      v(-R, R, T), v(R, R, T), v(0, 1, 0), off * 2.4,
      t('dim.plate', { v: p.plateD.toFixed(1) }), textH, 0.22);
    addDimension('motifH',
      v(R, mb.miny, T), v(R, mb.maxy, T), v(1, 0, 0), off,
      t('dim.height', { v: mb.h.toFixed(1) }), textH);
    if (r.windowD !== null) {
      addDimension('windowD',
        v(-R, -r.windowD / 2, T), v(-R, r.windowD / 2, T), v(-1, 0, 0), off,
        t('dim.window', { v: r.windowD.toFixed(1) }), textH);
    }

    // handle length along its right side, thickness at its tip
    if (bb.miny < -R - 1e-3) {
      addDimension('tabLen',
        v(R, -R, T), v(R, bb.miny, T), v(1, 0, 0), off,
        t('dim.tab', { v: (-R - bb.miny).toFixed(1) }), textH);
    }
    addDimension('thickness',
      v(0, bb.miny, 0), v(0, bb.miny, T), v(0, -1, 0), off * 0.6,
      t('dim.thickness', { v: T.toFixed(1) }), textH);
  }

  function emphasize(id: string | null): void {
    for (const [key, objs] of Object.entries(items)) {
      const opacity = id === null || key === id ? 1 : 0.12;
      for (const o of objs) {
        ((o as THREE.Mesh).material as THREE.Material).opacity = opacity;
      }
    }
  }

  return { group, update, emphasize };
}
