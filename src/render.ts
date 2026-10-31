// Canvas rendering. The preview draws the same RoundPoly geometry that is
// exported, so what you see is exactly what gets cut.

import { RoundPoly, V, rpSegments } from './geom';
import type { Plate } from './plate';

export type ViewMode = 'brass' | 'bw' | 'cut';

export interface View {
  scale: number; // CSS px per inch
  ox: number; // CSS px of plate origin
  oy: number;
}

export function addPolygon(path: Path2D, pts: V[], view: View) {
  pts.forEach((q, i) => {
    const x = q.x * view.scale + view.ox;
    const y = q.y * view.scale + view.oy;
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  path.closePath();
}

export function addRoundPoly(path: Path2D, rp: RoundPoly, view: View) {
  const segs = rpSegments(rp);
  const X = (x: number) => x * view.scale + view.ox;
  const Y = (y: number) => y * view.scale + view.oy;
  let first = true;
  for (const sg of segs) {
    if (sg.k === 'A') {
      const sx = X(sg.c.x + sg.r * Math.cos(sg.a0));
      const sy = Y(sg.c.y + sg.r * Math.sin(sg.a0));
      if (first) path.moveTo(sx, sy);
      path.arc(X(sg.c.x), Y(sg.c.y), sg.r * view.scale, sg.a0, sg.a1, false);
    } else {
      if (first) path.moveTo(X(sg.a.x), Y(sg.a.y));
      path.lineTo(X(sg.b.x), Y(sg.b.y));
    }
    first = false;
  }
  path.closePath();
}

let brushed: HTMLCanvasElement | null = null;
function brushedTexture(): HTMLCanvasElement {
  if (brushed) return brushed;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  const img = g.createImageData(512, 512);
  // Horizontal brushing: strong per-row variation, weak along the row.
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let y = 0; y < 512; y++) {
    const row = rnd() * 0.6 + rnd() * 0.4;
    let drift = 0;
    for (let x = 0; x < 512; x++) {
      drift += (rnd() - 0.5) * 0.08;
      drift *= 0.97;
      const vv = Math.max(0, Math.min(1, row + drift));
      const i = (y * 512 + x) * 4;
      const val = 100 + vv * 155;
      img.data[i] = val;
      img.data[i + 1] = val;
      img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  brushed = c;
  return c;
}

export interface DrawOpts {
  mode: ViewMode;
  showDims?: boolean;
  thickness?: number; // in, used for the cut-wall shading
  frame?: boolean; // draw the cherry shadow box around the plate
}

/** Frame geometry, in inches: rail width and the gap between rail and plate. */
export const FRAME_RAIL = 1.4;
export const FRAME_REVEAL = 0.3;

function drawFrame(ctx: CanvasRenderingContext2D, plate: Plate, view: View) {
  const s = view.scale;
  const r = FRAME_REVEAL * s;
  const F = FRAME_RAIL * s;
  const x0 = view.ox - r;
  const y0 = view.oy - r;
  const iw = plate.w * s + 2 * r;
  const ih = plate.h * s + 2 * r;

  // Box shadow on the wall.
  ctx.save();
  ctx.shadowColor = 'rgba(40,24,10,0.35)';
  ctx.shadowBlur = Math.max(10, s * 1.2);
  ctx.shadowOffsetY = Math.max(4, s * 0.35);
  ctx.fillStyle = '#7a3f22';
  ctx.fillRect(x0 - F, y0 - F, iw + 2 * F, ih + 2 * F);
  ctx.restore();

  // Four rails, grain running along each one, mitred at the corners.
  const rail = (pts: number[][], horizontal: boolean, tone: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    ctx.closePath();
    ctx.clip();
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const bx = Math.min(...xs),
      by = Math.min(...ys),
      bw = Math.max(...xs) - bx,
      bh = Math.max(...ys) - by;
    const g = horizontal
      ? ctx.createLinearGradient(0, by, 0, by + bh)
      : ctx.createLinearGradient(bx, 0, bx + bw, 0);
    g.addColorStop(0, shade('#a35d35', tone));
    g.addColorStop(0.5, shade('#b56a3c', tone));
    g.addColorStop(1, shade('#8e4e2c', tone));
    ctx.fillStyle = g;
    ctx.fillRect(bx, by, bw, bh);
    // Grain lines from a fixed sequence so the frame never flickers.
    let seed = Math.round(bx * 7 + by * 13) + 99;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const n = Math.round((horizontal ? bh : bw) / 2.2);
    for (let i = 0; i < n; i++) {
      ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '70,30,10' : '210,150,105'},${0.05 + rnd() * 0.12})`;
      ctx.lineWidth = 0.6 + rnd() * 1.4;
      ctx.beginPath();
      const t = (horizontal ? by : bx) + rnd() * (horizontal ? bh : bw);
      const wob = (horizontal ? bh : bw) * 0.06;
      const len = horizontal ? bw : bh;
      for (let k = 0; k <= 12; k++) {
        const u = (k / 12) * len;
        const off = Math.sin(k * 0.9 + t) * wob * rnd();
        if (horizontal) ctx.lineTo(bx + u, t + off);
        else ctx.lineTo(t + off, by + u);
      }
      ctx.stroke();
    }
    ctx.restore();
  };
  const X0 = x0 - F,
    Y0 = y0 - F,
    X1 = x0 + iw + F,
    Y1 = y0 + ih + F;
  const x1 = x0 + iw,
    y1 = y0 + ih;
  rail([[X0, Y0], [X1, Y0], [x1, y0], [x0, y0]], true, 0.06);
  rail([[X0, Y1], [x0, y1], [x1, y1], [X1, Y1]], true, -0.04);
  rail([[X0, Y0], [x0, y0], [x0, y1], [X0, Y1]], false, 0);
  rail([[X1, Y0], [X1, Y1], [x1, y1], [x1, y0]], false, -0.08);

  // Dark back of the box seen through the reveal.
  ctx.fillStyle = '#3b2414';
  ctx.fillRect(x0, y0, iw, ih);
  ctx.strokeStyle = 'rgba(40,18,6,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, iw - 1, ih - 1);
}

function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(Math.max(0, Math.min(255, c + t * 255)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function drawPlate(
  ctx: CanvasRenderingContext2D,
  plate: Plate,
  view: View,
  opts: DrawOpts,
) {
  const outline = new Path2D();
  addRoundPoly(outline, plate.outline, view);
  const cuts = new Path2D();
  for (const rp of plate.slots) addRoundPoly(cuts, rp, view);
  for (const rp of plate.holes) addRoundPoly(cuts, rp, view);
  for (const pth of plate.paths) addPolygon(cuts, pth, view);
  const body = new Path2D();
  body.addPath(outline);
  body.addPath(cuts);

  const W = plate.w * view.scale;
  const H = plate.h * view.scale;
  const cx = view.ox + W / 2;
  const cy = view.oy + H / 2;

  if (opts.mode === 'bw') {
    ctx.fillStyle = '#000';
    ctx.fill(body, 'evenodd');
  } else if (opts.mode === 'cut') {
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1f6feb';
    ctx.stroke(outline);
    ctx.strokeStyle = '#d1242f';
    ctx.stroke(cuts);
  } else {
    if (opts.frame) drawFrame(ctx, plate, view);
    // Drop shadow on the wall.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = Math.max(8, view.scale * 0.6);
    ctx.shadowOffsetY = Math.max(3, view.scale * 0.15);
    ctx.fillStyle = '#2a2116';
    ctx.fill(outline);
    ctx.restore();

    // Warm LED glow behind the plate, brightest in the middle.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.62);
    glow.addColorStop(0, '#fffbf0');
    glow.addColorStop(0.4, '#ffe6ad');
    glow.addColorStop(1, '#f2a94e');
    ctx.fillStyle = glow;
    ctx.fill(outline);

    // Brass body.
    const brass = ctx.createLinearGradient(view.ox, view.oy, view.ox + W, view.oy + H);
    brass.addColorStop(0, '#6e521f');
    brass.addColorStop(0.24, '#b28c42');
    brass.addColorStop(0.46, '#8f6d2b');
    brass.addColorStop(0.72, '#c29c52');
    brass.addColorStop(1, '#755722');
    ctx.fillStyle = brass;
    ctx.fill(body, 'evenodd');

    ctx.save();
    ctx.clip(body, 'evenodd');
    const pat = ctx.createPattern(brushedTexture(), 'repeat');
    if (pat) {
      // Pin the brushing to the plate so it moves and scales with it.
      const k = Math.max(0.25, view.scale / 64);
      pat.setTransform(new DOMMatrix([k, 0, 0, k, view.ox, view.oy]));
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = pat;
      ctx.fillRect(view.ox, view.oy, W, H);
    }
    ctx.restore();

    // Cut walls: a dark rim just inside every hole suggests plate thickness.
    const t = opts.thickness ?? 0.125;
    ctx.save();
    ctx.clip(cuts);
    ctx.strokeStyle = 'rgba(74, 40, 8, 0.62)';
    ctx.lineWidth = Math.max(1, t * view.scale * 0.9);
    ctx.stroke(cuts);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 238, 196, 0.35)';
    ctx.lineWidth = 1;
    ctx.stroke(outline);

    if (opts.frame) {
      // The top rail of the box shades the top of the plate.
      const sh = ctx.createLinearGradient(0, view.oy - FRAME_REVEAL * view.scale, 0, view.oy + 1.4 * view.scale);
      sh.addColorStop(0, 'rgba(30,14,4,0.55)');
      sh.addColorStop(1, 'rgba(30,14,4,0)');
      ctx.fillStyle = sh;
      const r = FRAME_REVEAL * view.scale;
      ctx.fillRect(view.ox - r, view.oy - r, W + 2 * r, 1.4 * view.scale + r);
    }
  }

  if (opts.showDims) {
    ctx.save();
    ctx.fillStyle = opts.mode === 'brass' ? 'rgba(233,226,212,0.7)' : 'rgba(0,0,0,0.6)';
    ctx.font = '12px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${plate.w.toFixed(2)} in`, cx, view.oy + H + 22);
    ctx.translate(view.ox - 14, cy);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${plate.h.toFixed(2)} in`, 0, 0);
    ctx.restore();
  }
}

/** View that fits the plate inside a box with a margin. */
export function fitView(pw: number, ph: number, bw: number, bh: number, margin = 40): View {
  const scale = Math.max(0.1, Math.min((bw - 2 * margin) / pw, (bh - 2 * margin) / ph));
  return { scale, ox: (bw - pw * scale) / 2, oy: (bh - ph * scale) / 2 };
}

/** Render a plate to a new canvas at a given pixel width. */
export function renderToCanvas(
  plate: Plate,
  pxWidth: number,
  mode: ViewMode,
  thickness: number,
  background: string | null,
  frame = false,
): HTMLCanvasElement {
  const padIn = frame ? FRAME_RAIL + FRAME_REVEAL + 0.6 : 0.6;
  const scale = pxWidth / (plate.w + 2 * padIn);
  const margin = padIn * scale;
  const pxHeight = Math.round(plate.h * scale + 2 * margin);
  const c = document.createElement('canvas');
  c.width = pxWidth;
  c.height = pxHeight;
  const ctx = c.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  drawPlate(ctx, plate, { scale, ox: margin, oy: margin }, { mode, thickness, frame: frame && mode === 'brass' });
  return c;
}
