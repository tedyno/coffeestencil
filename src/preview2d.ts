// 2D preview on a canvas as the dusted result: foam where the plate covers,
// cocoa where powder falls through; bridges outlined in the accent color
import type { GenResult, Pt } from './types';
import { boundsAll, signedArea } from './geo2d';

const COCOA = '#6f4e37';
const FOAM = '#ead9bd';
const BRIDGE = '#e0af68';

export function drawPreview(canvas: HTMLCanvasElement, r: GenResult): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = canvas.clientWidth, H = canvas.clientHeight, PAD = 12;
  ctx.clearRect(0, 0, W, H);
  if (!r.plateLoops.length) return;

  const bb = boundsAll(r.plateLoops);
  const s = Math.min((W - 2 * PAD) / bb.w, (H - 2 * PAD) / bb.h);
  const ox = PAD + (W - 2 * PAD - bb.w * s) / 2;
  const oy = H - PAD - (H - 2 * PAD - bb.h * s) / 2;
  const tx = (x: number) => ox + (x - bb.minx) * s;
  const ty = (y: number) => oy - (y - bb.miny) * s; // y up

  const trace = (loops: Pt[][]) => {
    ctx.beginPath();
    for (const pts of loops) {
      pts.forEach((p, i) => i ? ctx.lineTo(tx(p.x), ty(p.y)) : ctx.moveTo(tx(p.x), ty(p.y)));
      ctx.closePath();
    }
  };

  // everything inside the outer boundary is cocoa, the plate itself is foam
  const outer = r.plateLoops.reduce((a, b) => Math.abs(signedArea(a)) >= Math.abs(signedArea(b)) ? a : b);
  trace([outer]);
  ctx.fillStyle = COCOA;
  ctx.fill();
  trace(r.plateLoops);
  ctx.fillStyle = FOAM;
  ctx.fill('evenodd');

  ctx.strokeStyle = BRIDGE;
  ctx.lineWidth = 1;
  for (const loop of r.bridgeLoops) {
    trace([loop]);
    ctx.stroke();
  }
}
