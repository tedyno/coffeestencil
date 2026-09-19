// viewing mode: presentation look of the 3D viewport — lighting rigs, a
// background colour and physical materials with a surface finish. Purely
// cosmetic; exports are untouched.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Viewport } from './scene';

export type LightingId = 'studio' | 'daylight' | 'cafe' | 'dramatic' | 'top';
export type MaterialId = 'plaMatte' | 'plaGloss' | 'silk' | 'petg' | 'steel' | 'brass' | 'copper';
export type SurfaceId = 'smooth' | 'printed' | 'blasted';

export interface LookState {
  on: boolean;
  lighting: LightingId;
  background: string;
  material: MaterialId;
  color: string;
  surface: SurfaceId;
}

export const DEFAULT_LOOK: LookState = {
  on: false, lighting: 'studio', background: '#e9dcc9', material: 'plaMatte',
  color: '#f4f1ea', surface: 'printed',
};

export const BACKGROUNDS = ['#e9dcc9', '#f5f5f2', '#8a8f98', '#6b4a2f', '#1a1b26', '#0b0b0d'];

interface MaterialDef { color: string; params: THREE.MeshPhysicalMaterialParameters }
export const MATERIALS: Record<MaterialId, MaterialDef> = {
  plaMatte: { color: '#f4f1ea', params: { roughness: 0.78, metalness: 0 } },
  plaGloss: { color: '#c0392b', params: { roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12 } },
  silk: { color: '#d4af37', params: { roughness: 0.32, metalness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.2, sheen: 0.6, sheenRoughness: 0.3 } },
  petg: { color: '#7fc8f8', params: { roughness: 0.12, transmission: 0.85, thickness: 1.2, ior: 1.57 } },
  steel: { color: '#c8ccd2', params: { roughness: 0.3, metalness: 1 } },
  brass: { color: '#d6a84e', params: { roughness: 0.26, metalness: 1 } },
  copper: { color: '#c7764a', params: { roughness: 0.3, metalness: 1 } },
};

// ---------------------------------------------------------------------------
// surface finishes: procedural tiling textures in mm, mapped by planar UVs
// ---------------------------------------------------------------------------

const TEX = 256; // texture size [px]
const LINE_MM = 0.45;  // top-surface extrusion width
const LAYER_MM = 0.2;  // layer height seen on the walls

function canvasTexture(draw: (img: ImageData) => void, tileMm: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = TEX;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(TEX, TEX);
  draw(img);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / tileMm, 1 / tileMm); // UVs are in mm
  tex.anisotropy = 8;
  return tex;
}

const setGray = (img: ImageData, i: number, v: number): void => {
  img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
  img.data[i * 4 + 3] = 255;
};

/** FDM extrusion lines along u, one per LINE_MM of v (see planarUv) */
function printedLines(): THREE.CanvasTexture {
  const LINES = 8;
  return canvasTexture(img => {
    for (let y = 0; y < TEX; y++) {
      // rounded bead profile: bright crest, dark seam between lines
      const v = Math.pow(Math.abs(Math.sin(Math.PI * y * LINES / TEX)), 0.6) * 255;
      for (let x = 0; x < TEX; x++) setGray(img, y * TEX + x, v);
    }
  }, LINES * LINE_MM);
}

/** Bead-blasted grain: smoothed value noise (tileable) */
function blastedGrain(): THREE.CanvasTexture {
  const raw = new Float32Array(TEX * TEX).map(() => Math.random());
  return canvasTexture(img => {
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) sum += raw[((y + dy + TEX) % TEX) * TEX + (x + dx + TEX) % TEX]!;
        }
        setGray(img, y * TEX + x, (sum / 9) * 255);
      }
    }
  }, 6);
}

/**
 * UVs in mm for a triangle soup, picked per face so the print texture reads
 * like a real FDM part: top/bottom faces get 45° extrusion lines, walls get
 * horizontal layer lines (u runs along the wall, v up the layers)
 */
export function planarUv(positions: Float32Array): THREE.BufferAttribute {
  const uv = new Float32Array(positions.length / 3 * 2);
  const p = positions;
  for (let t = 0; t < p.length; t += 9) {
    const ux = p[t + 3]! - p[t]!, uy = p[t + 4]! - p[t + 1]!, uz = p[t + 5]! - p[t + 2]!;
    const vx = p[t + 6]! - p[t]!, vy = p[t + 7]! - p[t + 1]!, vz = p[t + 8]! - p[t + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const flat = Math.abs(nz) > Math.hypot(nx, ny);
    for (let k = 0; k < 3; k++) {
      const x = p[t + k * 3]!, y = p[t + k * 3 + 1]!, z = p[t + k * 3 + 2]!;
      const j = (t / 3 + k) * 2;
      if (flat) {
        uv[j] = (x + y) * Math.SQRT1_2;
        uv[j + 1] = (x - y) * Math.SQRT1_2;
      } else {
        uv[j] = Math.abs(nx) > Math.abs(ny) ? y : x; // the coordinate running along the wall
        uv[j + 1] = z * LINE_MM / LAYER_MM;
      }
    }
  }
  return new THREE.BufferAttribute(uv, 2);
}

// ---------------------------------------------------------------------------
// lighting rigs (three frame: y up; the model lies in the xz plane)
// ---------------------------------------------------------------------------

interface Rig { group: THREE.Group; key: THREE.DirectionalLight | THREE.SpotLight; env: number; exposure: number }

function dirLight(color: number, intensity: number, x: number, y: number, z: number): THREE.DirectionalLight {
  const l = new THREE.DirectionalLight(color, intensity);
  l.position.set(x, y, z);
  return l;
}

function buildRig(id: LightingId): Rig {
  const group = new THREE.Group();
  let key: Rig['key'];
  let env = 1, exposure = 1;
  switch (id) {
    case 'studio':
      key = dirLight(0xffffff, 1.8, 120, 260, 160);
      group.add(dirLight(0xffffff, 0.5, -200, 120, -80)); // fill
      break;
    case 'daylight':
      key = dirLight(0xfff1dc, 3.2, -160, 300, 120);
      group.add(new THREE.HemisphereLight(0xbfd9ff, 0x8a7a66, 0.8));
      env = 0.6;
      break;
    case 'cafe':
      key = dirLight(0xffa860, 2.6, 260, 140, 60);
      group.add(new THREE.HemisphereLight(0xffd2a0, 0x3a2414, 0.5));
      env = 0.35;
      exposure = 1.1;
      break;
    case 'dramatic': {
      const spot = new THREE.SpotLight(0xffffff, 14, 0, Math.PI / 7, 0.5, 0);
      spot.position.set(-260, 200, 120);
      key = spot;
      group.add(dirLight(0x6f8cff, 1.6, 180, 60, -240)); // cold rim
      env = 0.3; // metals are lit by reflections — without them they go black
      break;
    }
    case 'top':
      key = dirLight(0xffffff, 2.4, 0, 400, 0.01);
      env = 0.5;
      break;
  }
  group.add(key);
  if (key.target) group.add(key.target); // aims at the origin
  return { group, key, env, exposure };
}

// ---------------------------------------------------------------------------

export interface Look {
  apply(state: LookState): void;
}

export function createLook(vp: Viewport): Look {
  const cadMaterial = vp.material;
  const cadBackground = (vp.scene.background as THREE.Color).clone();
  let envMap: THREE.Texture | null = null;
  let rig: Rig | null = null;
  let rigId: LightingId | null = null;
  const textures: Partial<Record<SurfaceId, THREE.Texture>> = {};

  function surfaceTexture(id: SurfaceId): THREE.Texture | null {
    if (id === 'smooth') return null;
    return (textures[id] ??= id === 'printed' ? printedLines() : blastedGrain());
  }

  function buildMaterial(s: LookState): THREE.MeshPhysicalMaterial {
    const def = MATERIALS[s.material];
    const m = new THREE.MeshPhysicalMaterial({ ...def.params, color: new THREE.Color(s.color) });
    const tex = surfaceTexture(s.surface);
    if (tex) {
      m.bumpMap = tex;
      m.bumpScale = s.surface === 'printed' ? 0.9 : 0.6;
      if (s.surface === 'blasted') {
        // blasting kills the gloss: rougher, no clear coat
        m.roughness = Math.max(m.roughness, 0.6);
        m.clearcoat = 0;
        m.roughnessMap = tex;
      }
    }
    return m;
  }

  function setMaterial(next: THREE.Material): void {
    const prev = vp.material;
    vp.material = next;
    vp.modelGroup.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material === prev) mesh.material = next;
    });
    if (prev !== cadMaterial) prev.dispose();
  }

  return {
    apply(s) {
      const { scene, renderer } = vp;
      vp.grid.visible = !s.on;
      vp.cadLights.visible = !s.on;

      if (!s.on) {
        if (rig) rig.group.visible = false;
        scene.background = cadBackground;
        scene.environment = null;
        renderer.toneMapping = THREE.NoToneMapping;
        setMaterial(cadMaterial);
        return;
      }

      envMap ??= new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
      if (rigId !== s.lighting) {
        if (rig) scene.remove(rig.group);
        rig = buildRig(s.lighting);
        rigId = s.lighting;
        scene.add(rig.group);
      }
      rig!.group.visible = true;
      scene.environment = envMap;
      scene.environmentIntensity = rig!.env;
      scene.background = new THREE.Color(s.background);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = rig!.exposure;
      setMaterial(buildMaterial(s));
    },
  };
}
