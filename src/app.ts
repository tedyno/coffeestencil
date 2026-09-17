// application wiring: UI <-> worker <-> three.js; no geometry here
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { Contour, GenResult, Params, SizeFit, StencilMode } from './types';
import { extractContours } from './svg';
import { traceImage } from './raster';
import { createGenerator } from './worker-client';
import { createViewport } from './scene';
import { createDims } from './dims';
import { drawPreview } from './preview2d';
import { buildThreeMf } from './threemf';
import { applyStaticI18n, getLang, onLangChange, setLang, t, type Lang } from './i18n';

// ---------------------------------------------------------------------------
// UI elements
// ---------------------------------------------------------------------------

const els = {
  drop: document.getElementById('drop')!,
  file: document.getElementById('file') as HTMLInputElement,
  motifW: document.getElementById('motifW') as HTMLInputElement,
  motifH: document.getElementById('motifH') as HTMLInputElement,
  lockAspect: document.getElementById('lockAspect') as HTMLInputElement,
  preset: document.getElementById('preset') as HTMLSelectElement,
  plateD: document.getElementById('plateD') as HTMLInputElement,
  windowD: document.getElementById('windowD') as HTMLInputElement,
  windowRow: document.getElementById('windowRow')!,
  thickness: document.getElementById('thickness') as HTMLInputElement,
  bridgeW: document.getElementById('bridgeW') as HTMLInputElement,
  cornerR: document.getElementById('cornerR') as HTMLInputElement,
  cornerRVal: document.getElementById('cornerRVal')!,
  tabLen: document.getElementById('tabLen') as HTMLInputElement,
  tabW: document.getElementById('tabW') as HTMLInputElement,
  holeD: document.getElementById('holeD') as HTMLInputElement,
  preview2d: document.getElementById('preview2d') as HTMLCanvasElement,
  showDims: document.getElementById('showDims') as HTMLInputElement,
  rasterFs: document.getElementById('rasterFs') as HTMLFieldSetElement,
  threshold: document.getElementById('threshold') as HTMLInputElement,
  thresholdVal: document.getElementById('thresholdVal')!,
  invert: document.getElementById('invert') as HTMLInputElement,
  simplify: document.getElementById('simplify') as HTMLInputElement,
  simplifyVal: document.getElementById('simplifyVal')!,
  smooth: document.getElementById('smooth') as HTMLInputElement,
  info: document.getElementById('info')!,
  status: document.getElementById('status')!,
  download: document.getElementById('download') as HTMLButtonElement,
  download3mf: document.getElementById('download3mf') as HTMLButtonElement,
  hint3d: document.getElementById('hint3d')!,
  lang: document.getElementById('lang') as HTMLSelectElement,
};

// localization: translate static markup now, wire the language switch, and
// re-render dynamic content (status/info/dimensions) whenever it changes
applyStaticI18n();
els.lang.value = getLang();
els.lang.addEventListener('change', () => setLang(els.lang.value as Lang));
onLangChange(() => { if (lastResult) applyResult(lastResult); });

function setStatus(msg: string, cls: '' | 'ok' | 'err' = ''): void {
  els.status.textContent = msg;
  els.status.className = cls;
}

function mode(): StencilMode {
  return (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as StencilMode;
}

function readParams(): Params {
  return {
    motifW: +els.motifW.value,
    motifH: +els.motifH.value,
    fit: els.lockAspect.checked ? sizeFit : 'both',
    mode: mode(),
    plateD: +els.plateD.value,
    windowD: +els.windowD.value,
    thickness: +els.thickness.value,
    bridgeW: +els.bridgeW.value,
    cornerR: +els.cornerR.value,
    tabLen: +els.tabLen.value,
    tabW: +els.tabW.value,
    holeD: +els.holeD.value,
  };
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

let rawContours: Contour[] = [];   // contours from the file (sorted largest first)
let rasterData: ImageData | null = null; // source raster for retracing
let sizeFit: SizeFit = 'width';    // axis the user last set while the aspect is locked
let fileName = 'motif';
let exportGeometry: THREE.BufferGeometry | null = null; // mm, z up — for STL
let lastResult: GenResult | null = null;
let refitOnNext = false;

// ---------------------------------------------------------------------------
// 3D scene + dimensions + worker
// ---------------------------------------------------------------------------

const viewport = createViewport(document.getElementById('viewport')!);
const dims = createDims();

const generator = createGenerator({
  onResult: applyResult,
  onError(message) {
    setStatus(message, 'err');
    els.download.disabled = true;
    els.download3mf.disabled = true;
  },
});

function rebuild({ refit = false }: { refit?: boolean } = {}): void {
  if (!rawContours.length) return;
  refitOnNext = refit || refitOnNext;
  setStatus(t('status.generating'));
  generator.request(rawContours, readParams());
}

function applyResult(r: GenResult): void {
  lastResult = r;
  const p = readParams();

  exportGeometry = new THREE.BufferGeometry();
  exportGeometry.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
  exportGeometry.computeVertexNormals();

  viewport.modelGroup.clear();
  viewport.modelGroup.add(new THREE.Mesh(exportGeometry, viewport.material));
  dims.update(r, p);
  dims.group.visible = els.showDims.checked;
  viewport.modelGroup.add(dims.group);
  els.hint3d.style.display = 'none';
  if (refitOnNext) { viewport.fitCamera(); refitOnNext = false; }

  drawPreview(els.preview2d, r);
  if (els.lockAspect.checked) syncSize(r); // the other axis follows the shape

  const lines = [
    t('info.contours', { contours: r.contourCount }),
    t('info.bridges', { n: r.bridgeCount }),
    ...(r.droppedIslands ? [t('info.dropped', { n: r.droppedIslands })] : []),
    t('info.motif', { w: r.motifSize.w.toFixed(1), h: r.motifSize.h.toFixed(1) }),
    t('info.overall', { w: r.totalSize.w.toFixed(1), h: r.totalSize.h.toFixed(1), d: p.thickness.toFixed(1) }),
    t('info.triangles', { n: r.positions.length / 9 }),
    ...(r.clipped ? [t('info.clipped')] : []),
  ];
  els.info.textContent = lines.join('\n');
  els.download.disabled = false;
  els.download3mf.disabled = false;
  setStatus(t('status.modelGenerated'), 'ok');
}

// ---------------------------------------------------------------------------
// file loading (SVG directly, PNG/JPG via vectorization)
// ---------------------------------------------------------------------------

function loadSvg(text: string, name: string): void {
  try {
    rawContours = extractContours(text);
    fileName = name.replace(/\.svg$/i, '') || 'motif';
    rebuild({ refit: true });
  } catch (e) {
    console.error(e);
    setStatus(e instanceof Error ? e.message : String(e), 'err');
  }
}

function retrace(refit = false): void {
  if (!rasterData) return;
  try {
    rawContours = traceImage(rasterData, {
      threshold: +els.threshold.value,
      invert: els.invert.checked,
      simplify: +els.simplify.value,
      smooth: +els.smooth.value,
    });
    rebuild({ refit });
  } catch (e) {
    console.error(e);
    setStatus(e instanceof Error ? e.message : String(e), 'err');
  }
}

async function loadFile(f: File): Promise<void> {
  if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') {
    rasterData = null;
    els.rasterFs.style.display = 'none';
    loadSvg(await f.text(), f.name);
    return;
  }
  try {
    // downscale to max 1024 px — a powder stencil needs no more detail
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
    const cw = Math.max(1, Math.round(bmp.width * s)), ch = Math.max(1, Math.round(bmp.height * s));
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, cw, ch);
    rasterData = ctx.getImageData(0, 0, cw, ch);
    fileName = f.name.replace(/\.[a-z0-9]+$/i, '') || 'motif';
    els.rasterFs.style.display = '';
    retrace(true);
  } catch (e) {
    console.error(e);
    setStatus(t('status.imageLoadFailed'), 'err');
  }
}

/** Load an image dragged/pasted from another page (a URL, not a file) */
async function loadUrl(url: string): Promise<void> {
  try {
    setStatus(t('status.fetching'));
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const name = new URL(url).pathname.split('/').pop() || 'pasted';
    await loadFile(new File([blob], name, { type: blob.type }));
  } catch (e) {
    console.error(e);
    // cross-origin servers without CORS headers block the read
    setStatus(t('status.fetchFailed'), 'err');
  }
}

/** Pull an image URL out of a drag/paste payload (page images carry a URL, not a file) */
function imageUrlFrom(data: DataTransfer): string | null {
  const uri = data.getData('text/uri-list') || data.getData('text/plain');
  if (/^https?:|^data:image\//i.test(uri.trim())) return uri.trim();
  const html = data.getData('text/html');
  const m = html.match(/<img[^>]+src="([^"]+)"/i);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

// files: drop zone + picker
els.drop.addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files?.[0];
  if (f) void loadFile(f);
});

function consumeDrop(data: DataTransfer): void {
  const f = data.files[0];
  if (f) { void loadFile(f); return; }
  const url = imageUrlFrom(data); // image dragged from another page
  if (url) void loadUrl(url);
}

// the whole window is a drop target — otherwise the browser navigates to a
// file/image dropped anywhere outside the drop zone (opening it instead)
window.addEventListener('dragover', e => {
  e.preventDefault();
  els.drop.classList.add('over');
});
window.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) els.drop.classList.remove('over'); // left the window
});
window.addEventListener('drop', e => {
  e.preventDefault();
  els.drop.classList.remove('over');
  if (e.dataTransfer) consumeDrop(e.dataTransfer);
});

// paste from clipboard (Cmd/Ctrl+V): an image file, or SVG markup as text
window.addEventListener('paste', e => {
  const data = (e as ClipboardEvent).clipboardData;
  if (!data) return;
  const file = [...data.items].find(it => it.kind === 'file')?.getAsFile();
  if (file) {
    e.preventDefault();
    void loadFile(file);
    return;
  }
  const text = data.getData('text');
  if (/<svg[\s>]/i.test(text)) {
    e.preventDefault();
    rasterData = null;
    els.rasterFs.style.display = 'none';
    loadSvg(text, 'pasted');
    return;
  }
  const url = imageUrlFrom(data); // image copied from another page
  if (url) {
    e.preventDefault();
    void loadUrl(url);
  }
});

// parameters: debounced rebuild; focus highlights the matching dimension
const debounce = (fn: () => void, ms = 150) => {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
};
const debouncedRebuild = debounce(() => rebuild());
for (const id of ['plateD', 'windowD', 'thickness', 'bridgeW', 'tabLen', 'tabW', 'holeD'] as const) {
  els[id].addEventListener('input', () => {
    if (id === 'plateD' || id === 'windowD') els.preset.value = 'custom';
    debouncedRebuild();
  });
  els[id].addEventListener('focus', () => dims.emphasize(id));
  els[id].addEventListener('blur', () => dims.emphasize(null));
}

// motif size: with the aspect locked, the last edited axis drives the scale
// and the other one follows the shape's width/height ratio
function syncSize(r: GenResult | null = lastResult): void {
  if (!r || !(r.motifSize.w > 0 && r.motifSize.h > 0)) return;
  const [el, v] = sizeFit === 'height'
    ? [els.motifW, +els.motifH.value * r.motifSize.w / r.motifSize.h]
    : [els.motifH, +els.motifW.value * r.motifSize.h / r.motifSize.w];
  if (el !== document.activeElement && v > 0) el.value = String(Math.round(v * 10) / 10);
}
for (const [el, axis] of [[els.motifW, 'width'], [els.motifH, 'height']] as const) {
  el.addEventListener('input', () => {
    if (els.lockAspect.checked) {
      sizeFit = axis;
      syncSize();
    }
    debouncedRebuild();
  });
  el.addEventListener('focus', () => dims.emphasize(el.id));
  el.addEventListener('blur', () => dims.emphasize(null));
}
els.lockAspect.addEventListener('change', () => {
  sizeFit = 'width'; // re-locking keeps the width, the height snaps to the shape
  rebuild();
});

// cup presets: plate rests on the rim, motif and window fit inside the drink
const PRESETS: Record<string, { plateD: number; windowD: number; motif: number }> = {
  espresso: { plateD: 85, windowD: 55, motif: 45 },
  cappuccino: { plateD: 110, windowD: 80, motif: 60 },
  mug: { plateD: 120, windowD: 90, motif: 70 },
};
function applyPreset(): void {
  const p = PRESETS[els.preset.value];
  if (!p) return; // custom
  els.plateD.value = String(p.plateD);
  els.windowD.value = String(p.windowD);
  // the motif's longer side matches the preset
  const r = lastResult;
  if (els.lockAspect.checked && r && r.motifSize.h > r.motifSize.w) {
    els.motifH.value = String(p.motif);
    sizeFit = 'height';
  } else {
    els.motifW.value = String(p.motif);
    sizeFit = 'width';
  }
  syncSize();
}
els.preset.addEventListener('change', () => {
  applyPreset();
  rebuild({ refit: true });
});

function updateModeControls(): void {
  els.windowRow.style.display = mode() === 'negative' ? '' : 'none';
}
for (const radio of document.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    updateModeControls();
    rebuild();
  });
}
updateModeControls();
els.cornerR.addEventListener('input', () => {
  els.cornerRVal.textContent = els.cornerR.value;
  debouncedRebuild();
});
els.showDims.addEventListener('change', () => { dims.group.visible = els.showDims.checked; });

// vectorization: threshold/simplification/smoothing changes retrace the image
const debouncedRetrace = debounce(() => retrace());
els.threshold.addEventListener('input', () => {
  els.thresholdVal.textContent = els.threshold.value;
  debouncedRetrace();
});
els.simplify.addEventListener('input', () => {
  els.simplifyVal.textContent = els.simplify.value;
  debouncedRetrace();
});
els.invert.addEventListener('change', () => retrace());
els.smooth.addEventListener('input', () => retrace());

// exports: binary STL + 3MF (explicit mm units, indexed mesh)
function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

els.download.addEventListener('click', () => {
  if (!exportGeometry) return;
  const data = new STLExporter().parse(new THREE.Mesh(exportGeometry), { binary: true }) as DataView<ArrayBuffer>;
  downloadBlob(new Blob([data], { type: 'model/stl' }), `${fileName}_stencil.stl`);
});

els.download3mf.addEventListener('click', () => {
  if (!lastResult) return;
  downloadBlob(buildThreeMf(lastResult.positions, `${fileName}_stencil`), `${fileName}_stencil.3mf`);
});
