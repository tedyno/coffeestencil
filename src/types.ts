// shared types — no code, just contracts between modules and the worker

export interface Pt { x: number; y: number }

/** Closed contour from SVG/raster; area is absolute (orientation is resolved at build time) */
export interface Contour { pts: Pt[]; area: number }

export interface Box { minx: number; miny: number; maxx: number; maxy: number; w: number; h: number }

/**
 * What the powder draws: 'positive' = the motif is cut out (dark motif on
 * light foam), 'negative' = the motif stays solid inside a round dusting
 * window (light motif on a dark disc)
 */
export type StencilMode = 'positive' | 'negative';
/** Which target size drives the scale: one axis (aspect kept) or both (stretch) */
export type SizeFit = 'width' | 'height' | 'both';

/** Generation input — values from the UI, sent to the worker */
export interface Params {
  motifW: number;    // target motif width [mm]
  motifH: number;    // target motif height [mm]
  fit: SizeFit;
  mode: StencilMode;
  plateD: number;    // plate diameter [mm]
  windowD: number;   // dusting window diameter in negative mode [mm]
  thickness: number; // plate thickness [mm]
  bridgeW: number;   // width of bridges holding islands [mm]
  cornerR: number;   // corner rounding radius of the plate outline in plan view [mm]
  tabLen: number;    // handle overhang beyond the plate [mm], 0 = no handle
  tabW: number;      // handle width [mm]
  holeD: number;     // hanging hole in the handle [mm], 0 = none
}

/** Generation output — triangles for STL/preview + data for the UI */
export interface GenResult {
  positions: Float32Array;  // triangle soup (xyz by 9), mm, z up
  plateLoops: Pt[][];       // final plate (outlines CCW, holes CW)
  bridgeLoops: Pt[][];      // added bridges (preview highlight)
  motifLoops: Pt[][];       // scaled motif contours
  contourCount: number;
  bridgeCount: number;
  droppedIslands: number;   // islands too small to hold, left open
  clipped: boolean;         // motif reaches past the usable plate area
  windowD: number | null;   // effective dusting window diameter (negative mode)
  motifSize: { w: number; h: number };
  totalSize: { w: number; h: number };
}
