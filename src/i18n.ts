// tiny client-only i18n: a flat dictionary keyed by string id, Czech + English.
// Static markup is translated via [data-i18n] attributes; dynamic strings
// (status / info / dimension labels) go through t(). Language is persisted in
// localStorage and applied on load.
export type Lang = 'cs' | 'en';

type Dict = Record<string, string>;

const EN: Dict = {
  'app.subtitle': '— latte art stencil generator',
  'drop.title': 'Drop SVG / PNG / JPG here',
  'drop.sub': 'or click to choose · or paste (⌘V)',

  'raster.legend': 'Image vectorization',
  'raster.threshold': 'Brightness threshold',
  'raster.invert': 'invert (light shapes)',
  'raster.simplify': 'Simplification',
  'raster.smooth': 'Smoothing (0–3)',

  'mode.legend': 'Powder draws',
  'mode.positive': 'the motif (cut out)',
  'mode.negative': 'around the motif (motif stays light)',

  'size.legend': 'Motif (mm)',
  'size.width': 'Motif width',
  'size.height': 'Motif height',
  'size.lockAspect': 'keep aspect ratio',

  'params.legend': 'Stencil (mm)',
  'params.preset': 'Cup',
  'preset.espresso': 'espresso',
  'preset.cappuccino': 'cappuccino',
  'preset.mug': 'large mug',
  'preset.custom': 'custom',
  'params.plateD': 'Plate diameter',
  'params.windowD': 'Dusting window',
  'params.thickness': 'Thickness',
  'params.bridgeW': 'Bridge width',
  'params.tabLen': 'Handle length',
  'params.tabW': 'Handle width',
  'params.holeD': 'Hanging hole',
  'params.showDims': 'show dimensions',

  'hint3d': 'Load a file…',

  'cube.top': 'TOP',
  'cube.bottom': 'BOTTOM',
  'cube.front': 'FRONT',
  'cube.back': 'BACK',
  'cube.left': 'LEFT',
  'cube.right': 'RIGHT',

  'status.generating': 'Generating model…',
  'status.modelGenerated': 'Model generated.',
  'status.fetching': 'Fetching image…',
  'status.imageLoadFailed': 'Failed to load the image.',
  'status.fetchFailed': 'Could not fetch the image (the source site may block it). Save it and drop the file instead.',

  'info.contours': 'Contours: {contours}',
  'info.bridges': 'Bridges: {n}',
  'info.dropped': 'Specks left open: {n}',
  'info.clipped': '⚠ The motif does not fit — it is clipped to the plate rim / window.',
  'info.motif': 'Motif: {w} × {h} mm',
  'info.overall': 'Overall size: {w} × {h} × {d} mm',
  'info.triangles': 'Triangles: {n}',

  'dim.plate': 'plate ⌀ {v} mm',
  'dim.window': 'window ⌀ {v} mm',
  'dim.width': 'width {v} mm',
  'dim.height': 'height {v} mm',
  'dim.thickness': 'thickness {v} mm',
  'dim.tab': 'handle {v} mm',
};

const CS: Dict = {
  'app.subtitle': '— generátor šablon na kávu',
  'drop.title': 'Přetáhněte sem SVG / PNG / JPG',
  'drop.sub': 'nebo klikněte pro výběr · nebo vložte (⌘V)',

  'raster.legend': 'Vektorizace obrázku',
  'raster.threshold': 'Práh jasu',
  'raster.invert': 'invertovat (světlé tvary)',
  'raster.simplify': 'Zjednodušení',
  'raster.smooth': 'Vyhlazení (0–3)',

  'mode.legend': 'Kakao kreslí',
  'mode.positive': 'motiv (vyříznutý)',
  'mode.negative': 'okolí motivu (motiv zůstane světlý)',

  'size.legend': 'Motiv (mm)',
  'size.width': 'Šířka motivu',
  'size.height': 'Výška motivu',
  'size.lockAspect': 'zachovat poměr stran',

  'params.legend': 'Šablona (mm)',
  'params.preset': 'Hrnek',
  'preset.espresso': 'espresso',
  'preset.cappuccino': 'cappuccino',
  'preset.mug': 'velký hrnek',
  'preset.custom': 'vlastní',
  'params.plateD': 'Průměr desky',
  'params.windowD': 'Okno pro sypání',
  'params.thickness': 'Tloušťka',
  'params.bridgeW': 'Šířka můstků',
  'params.tabLen': 'Délka úchytu',
  'params.tabW': 'Šířka úchytu',
  'params.holeD': 'Otvor na pověšení',
  'params.showDims': 'zobrazit kóty',

  'hint3d': 'Načtěte soubor…',

  'cube.top': 'SHORA',
  'cube.bottom': 'ZDOLA',
  'cube.front': 'ZEPŘEDU',
  'cube.back': 'ZEZADU',
  'cube.left': 'ZLEVA',
  'cube.right': 'ZPRAVA',

  'status.generating': 'Generuji model…',
  'status.modelGenerated': 'Model vygenerován.',
  'status.fetching': 'Načítám obrázek…',
  'status.imageLoadFailed': 'Nepodařilo se načíst obrázek.',
  'status.fetchFailed': 'Obrázek se nepodařilo stáhnout (zdrojový web jej může blokovat). Uložte jej a přetáhněte jako soubor.',

  'info.contours': 'Kontury: {contours}',
  'info.bridges': 'Můstky: {n}',
  'info.dropped': 'Drobky ponechané otevřené: {n}',
  'info.clipped': '⚠ Motiv se nevejde — je oříznutý okrajem desky / oknem.',
  'info.motif': 'Motiv: {w} × {h} mm',
  'info.overall': 'Celkový rozměr: {w} × {h} × {d} mm',
  'info.triangles': 'Trojúhelníky: {n}',

  'dim.plate': 'deska ⌀ {v} mm',
  'dim.window': 'okno ⌀ {v} mm',
  'dim.width': 'šířka {v} mm',
  'dim.height': 'výška {v} mm',
  'dim.thickness': 'tloušťka {v} mm',
  'dim.tab': 'úchyt {v} mm',
};

const DICTS: Record<Lang, Dict> = { cs: CS, en: EN };
const STORAGE_KEY = 'coffeestencil.lang';

function initialLang(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'cs' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('cs') ? 'cs' : 'en';
}

let lang: Lang = initialLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.lang = next;
  applyStaticI18n();
  for (const cb of listeners) cb();
}

/** Subscribe to language changes (re-render dynamic content). */
export function onLangChange(cb: () => void): void {
  listeners.add(cb);
}

/** Translate a key, substituting {name} placeholders from vars. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? EN[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** Fill every [data-i18n] element's text from the current dictionary. */
export function applyStaticI18n(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n!);
  }
  document.documentElement.lang = lang;
}
