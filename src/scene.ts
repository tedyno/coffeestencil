// three.js viewport: scene, camera, lights, orbit controls
// the model is in mm with z up; the whole group is rotated for three (y up)
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createViewCube } from './viewcube';

export interface Viewport {
  /** Group for the mesh + dimensions (mm, z up); cleared on rebuild */
  modelGroup: THREE.Group;
  /** Material for new model meshes; swapped by the viewing mode (look.ts) */
  material: THREE.Material;
  fitCamera(): void;
  // internals the viewing mode restyles
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  grid: THREE.GridHelper;
  /** The plain CAD lighting, hidden while the viewing mode has its own rig */
  cadLights: THREE.Group;
}

// Orthographic projection like CAD plan views: one scale everywhere, no
// converging walls. Zoom scales the frustum (camera.zoom), so the camera just
// orbits at a fixed distance far enough to stay clear of the model.
const VIEW_H = 100;     // mm visible vertically at zoom 1
const CAM_DIST = 1000;  // orbit radius [mm]

export function createViewport(container: HTMLElement): Viewport {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1b26);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAM_DIST * 3);
  camera.position.set(80, 60, 80).setLength(CAM_DIST);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN; // middle drag moves the orbit target
  controls.minZoom = 0.05;
  controls.maxZoom = 50;
  const viewCube = createViewCube(container, camera, controls);

  const cadLights = new THREE.Group();
  cadLights.add(new THREE.HemisphereLight(0xc0caf5, 0x24283b, 1.1));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight.position.set(60, 100, 40);
  cadLights.add(dirLight);
  scene.add(cadLights);
  const grid = new THREE.GridHelper(200, 20, 0x3b4261, 0x2a2e44);
  scene.add(grid);

  const modelGroup = new THREE.Group();
  modelGroup.rotation.x = -Math.PI / 2;
  scene.add(modelGroup);

  function resize(): void {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    const aspect = w / h;
    camera.left = -VIEW_H / 2 * aspect;
    camera.right = VIEW_H / 2 * aspect;
    camera.top = VIEW_H / 2;
    camera.bottom = -VIEW_H / 2;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  renderer.setAnimationLoop(now => {
    viewCube.animate(now);
    controls.update();
    renderer.render(scene, camera);
    viewCube.render();
  });

  function fitCamera(): void {
    const box = new THREE.Box3().setFromObject(modelGroup);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    camera.position.copy(center).add(new THREE.Vector3(0.75, 0.65, 0.75).setLength(CAM_DIST));
    camera.zoom = VIEW_H / (size * 1.05);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
  }

  const material = new THREE.MeshStandardMaterial({ color: 0xd8c3a5, roughness: 0.45, metalness: 0.05 });

  return { modelGroup, material, fitCamera, scene, renderer, grid, cadLights };
}
