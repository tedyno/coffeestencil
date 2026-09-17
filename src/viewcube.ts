// orientation cube in the viewport corner: mirrors the main camera's view
// direction, drag on it orbits, double-click on a face/edge/corner animates
// the camera to that view. Built in three's frame (y up): model +z (up) is
// three +y, model front (-y) is three +z — the same mapping as modelGroup.
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { onLangChange, t } from './i18n';

export interface ViewCube {
  /** Advance the view transition; call once per frame before controls.update() */
  animate(now: number): void;
  /** Render the cube oriented like the main camera; call after controls.update() */
  render(): void;
}

const E = 0.3;         // edge/corner band width (cube spans -1..1)
const SIZE = 150;      // CSS px
const ANIM_MS = 450;
const DRAG_SPEED = 0.012; // rad/px

// BoxGeometry material order: +x, -x, +y, -y, +z, -z (three frame)
const FACE_KEYS = ['cube.right', 'cube.left', 'cube.top', 'cube.bottom', 'cube.front', 'cube.back'];

function drawFace(ctx: CanvasRenderingContext2D, label: string): void {
  const n = ctx.canvas.width, band = n * E / 2;
  ctx.fillStyle = '#2a2f47';
  ctx.fillRect(0, 0, n, n);
  ctx.fillStyle = '#343a58';
  ctx.fillRect(band, band, n - 2 * band, n - 2 * band);
  ctx.strokeStyle = '#565f89';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, n - 6, n - 6);
  ctx.fillStyle = '#c0caf5';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let px = 46;
  ctx.font = `600 ${px}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const w = ctx.measureText(label).width, maxW = n - 2 * band - 12;
  if (w > maxW) {
    px = Math.floor(px * maxW / w);
    ctx.font = `600 ${px}px -apple-system, BlinkMacSystemFont, sans-serif`;
  }
  ctx.fillText(label, n / 2, n / 2 + 2);
}

function axisLabel(text: string, color: string): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.font = 'bold 48px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.setScalar(0.55);
  s.renderOrder = 2;
  return s;
}

export function createViewCube(container: HTMLElement, camera: THREE.Camera, controls: OrbitControls): ViewCube {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(SIZE, SIZE);
  const el = renderer.domElement;
  el.style.cssText = `position:absolute; top:12px; right:12px; width:${SIZE}px; height:${SIZE}px; cursor:grab; touch-action:none`;
  container.appendChild(el);

  const scene = new THREE.Scene();
  const half = 2.4;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 20);

  // cube with a label texture per face
  const faces = FACE_KEYS.map(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { ctx: cv.getContext('2d')!, tex, mat: new THREE.MeshBasicMaterial({ map: tex }) };
  });
  const paintLabels = (): void => faces.forEach((f, i) => { drawFace(f.ctx, t(FACE_KEYS[i]!)); f.tex.needsUpdate = true; });
  paintLabels();
  onLangChange(paintLabels);
  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), faces.map(f => f.mat));
  scene.add(cube);

  // hovered region (face / edge / corner) as a translucent box over the cube
  const hover = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x7aa2f7, transparent: true, opacity: 0.55, depthWrite: false }));
  hover.visible = false;
  scene.add(hover);

  // model axes from the left-bottom-front corner, along the cube edges
  const o = new THREE.Vector3(-1.12, -1.12, 1.12);
  const axes: [THREE.Vector3, number, string][] = [
    [new THREE.Vector3(1, 0, 0), 0xf7768e, 'X'],
    [new THREE.Vector3(0, 0, -1), 0x9ece6a, 'Y'],
    [new THREE.Vector3(0, 1, 0), 0x7aa2f7, 'Z'],
  ];
  const len = 2.35;
  for (const [dir, color, name] of axes) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, len, 8),
      new THREE.MeshBasicMaterial({ color }));
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    rod.position.copy(o).addScaledVector(dir, len / 2);
    scene.add(rod);
    const label = axisLabel(name, '#' + color.toString(16).padStart(6, '0'));
    label.position.copy(o).addScaledVector(dir, len + 0.25);
    scene.add(label);
  }

  // --- picking: hit point -> region vector with components in {-1, 0, 1}
  const raycaster = new THREE.Raycaster();
  function pick(e: PointerEvent | MouseEvent): THREE.Vector3 | null {
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, cam);
    const hit = raycaster.intersectObject(cube)[0];
    if (!hit) return null;
    const p = hit.point;
    const c = (v: number) => (Math.abs(v) > 1 - E - 1e-6 ? Math.sign(v) : 0);
    return new THREE.Vector3(c(p.x), c(p.y), c(p.z));
  }
  function showHover(v: THREE.Vector3 | null): void {
    hover.visible = !!v;
    if (!v) return;
    const out = 1.012; // just above the cube surface
    const span = (k: number): [number, number] => (k === 0 ? [2 - 2 * E, 0] : [E + out - 1, Math.sign(k) * (1 - E + out) / 2]);
    const [sx, px] = span(v.x), [sy, py] = span(v.y), [sz, pz] = span(v.z);
    hover.scale.set(sx, sy, sz);
    hover.position.set(px, py, pz);
  }

  // --- animation between orbits around controls.target (spherical, y up)
  const sph = new THREE.Spherical();
  let anim: { t0: number; from: THREE.Spherical; to: THREE.Spherical } | null = null;

  function viewFrom(dir: THREE.Vector3): void {
    const off = camera.position.clone().sub(controls.target);
    const from = new THREE.Spherical().setFromVector3(off);
    const to = new THREE.Spherical().setFromVector3(dir.clone().normalize().multiplyScalar(from.radius));
    if (dir.x === 0 && dir.z === 0) {
      // straight top/bottom: plan view with X right, Y up (front at the bottom)
      to.theta = 0;
      to.phi = dir.y > 0 ? 1e-4 : Math.PI - 1e-4;
    }
    // shortest way around
    let d = to.theta - from.theta;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    to.theta = from.theta + d;
    anim = { t0: performance.now(), from, to };
    controls.enableDamping = false; // no leftover inertia fighting the animation
  }
  controls.addEventListener('start', () => {
    if (anim) { anim = null; controls.enableDamping = true; }
  });

  function orbitBy(dTheta: number, dPhi: number): void {
    const off = camera.position.clone().sub(controls.target);
    sph.setFromVector3(off);
    sph.theta += dTheta;
    sph.phi = THREE.MathUtils.clamp(sph.phi + dPhi, 1e-4, Math.PI - 1e-4);
    camera.position.copy(controls.target).add(off.setFromSpherical(sph));
  }

  // --- pointer: drag orbits, double-click jumps to the region's view
  let drag: { x: number; y: number } | null = null;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
    anim = null;
    controls.enableDamping = true;
  });
  el.addEventListener('pointermove', e => {
    if (drag) {
      orbitBy(-(e.clientX - drag.x) * DRAG_SPEED, -(e.clientY - drag.y) * DRAG_SPEED);
      drag = { x: e.clientX, y: e.clientY };
      showHover(null);
    } else {
      showHover(pick(e));
    }
  });
  const endDrag = (): void => { drag = null; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('pointerleave', () => showHover(null));
  el.addEventListener('dblclick', e => {
    const v = pick(e);
    if (v) viewFrom(v);
  });
  el.addEventListener('contextmenu', e => e.preventDefault());

  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

  function animate(now: number): void {
    if (anim) {
      const k = Math.min(1, (now - anim.t0) / ANIM_MS), e = ease(k);
      sph.set(
        anim.from.radius,
        anim.from.phi + (anim.to.phi - anim.from.phi) * e,
        anim.from.theta + (anim.to.theta - anim.from.theta) * e,
      );
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
      if (k >= 1) { anim = null; controls.enableDamping = true; }
    }
  }

  function render(): void {
    // cube camera looks along the main camera's view direction
    const dir = camera.position.clone().sub(controls.target).normalize();
    cam.position.copy(dir).multiplyScalar(10);
    cam.up.copy(camera.up);
    cam.lookAt(0, 0, 0);
    renderer.render(scene, cam);
  }

  return { animate, render };
}
