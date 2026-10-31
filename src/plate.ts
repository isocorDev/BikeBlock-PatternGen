// Build the full plate from settings: outline, mounting holes and slots.
//
// Why the result is always cuttable:
// - Every slot is a convex piece of one cell, shrunk away from the cell's
//   edges by seam/2, so slots in neighboring cells stay >= seam apart.
// - Slots in the same cell are separated by the line width.
// - Each slot is "opened" (shrunk by r, grown back by r with round corners),
//   which rounds every inside corner to the cutter radius and deletes any
//   sliver narrower than the minimum cut.
// - Slots never touch each other or the border, so the brass is one
//   connected piece: islands are impossible by construction.

import {
  RoundPoly,
  V,
  clipHalf,
  clipRect,
  clean,
  dot,
  inset,
  orient,
  rpArea,
  rpLength,
  rpPerimeter,
} from './geom';
import { makeCells } from './layouts';
import { hash01 } from './rng';
import { Settings, fabLimits, FabLimits } from './settings';

export interface PlateStats {
  slots: number;
  openArea: number; // fraction of plate area that is pattern cut
  cutLength: number; // in, total cutter path
  pierces: number;
  dropped: number; // slot stubs removed
}

export interface Plate {
  w: number;
  h: number;
  outline: RoundPoly;
  holes: RoundPoly[]; // mounting holes
  slots: RoundPoly[];
  stats: PlateStats;
  limits: FabLimits;
}

export function buildPlate(s: Settings): Plate {
  const { w, h, border, corner, holeD } = s.plate;
  const p = s.pattern;
  const lim = fabLimits(s);

  // Outline: a rectangle shrunk by the corner radius, grown back round.
  const cr = Math.min(corner, w / 2 - 1e-4, h / 2 - 1e-4);
  const outline: RoundPoly = {
    pts: orient([
      { x: cr, y: cr },
      { x: w - cr, y: cr },
      { x: w - cr, y: h - cr },
      { x: cr, y: h - cr },
    ]),
    r: cr,
  };

  // Mounting holes centered in the border band, kept clear of the corner arc.
  const holes: RoundPoly[] = [];
  if (holeD > 0) {
    const hr = holeD / 2;
    let m = border / 2;
    if (cr > m) m = Math.max(m, cr - (cr - hr - lim.minWeb) / Math.SQRT2);
    for (const [x, y] of [
      [m, m],
      [w - m, m],
      [w - m, h - m],
      [m, h - m],
    ])
      holes.push({ pts: [{ x, y }], r: hr });
  }

  // Pattern cells, generated around the plate center in rotated space.
  const cx = w / 2;
  const cy = h / 2;
  const rot = (p.rot * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const toPlate = (q: V): V => ({ x: cx + q.x * cos - q.y * sin, y: cy + q.x * sin + q.y * cos });
  const R = Math.hypot(w, h) / 2;
  const cells = makeCells(p.layout, p.scale, R);

  const period = p.line + p.gap;
  // Opening radius: the cutter's corner radius, but never less than half the
  // minimum cut (so slivers vanish) and never so big the slot disappears.
  const ro = Math.min(Math.max(lim.cornerR, lim.minCut / 2), p.gap / 2 - 1e-6);
  const slots: RoundPoly[] = [];
  let dropped = 0;

  for (const cell of cells) {
    const poly = cell.poly.map(toPlate);
    // Quick reject: cell entirely outside the plate.
    let minx = Infinity,
      maxx = -Infinity,
      miny = Infinity,
      maxy = -Infinity;
    for (const q of poly) {
      minx = Math.min(minx, q.x);
      maxx = Math.max(maxx, q.x);
      miny = Math.min(miny, q.y);
      maxy = Math.max(maxy, q.y);
    }
    if (maxx < border || minx > w - border || maxy < border || miny > h - border) continue;

    const c1 = clean(clipRect(poly, 0, 0, w, h));
    if (c1.length < 3) continue;
    const c2 = inset(c1, p.seam / 2);
    if (c2.length < 3) continue;
    const c3 = clean(clipRect(c2, border, border, w - border, h - border));
    if (c3.length < 3) continue;

    const dir = pickDir(cell.dirs, cell.parity, cell.key, s) + rot;
    // Stripes run along `dir`; n is their normal.
    const n = { x: -Math.sin(dir), y: Math.cos(dir) };
    // Anchor stripes to the cell's own centroid so each cell looks intentional.
    const anchor = centroid(poly);
    const t0 = dot(n, anchor) - p.gap / 2 + p.phase * period;
    let tmin = Infinity,
      tmax = -Infinity;
    for (const q of c3) {
      const t = dot(n, q);
      tmin = Math.min(tmin, t);
      tmax = Math.max(tmax, t);
    }
    const k0 = Math.floor((tmin - t0) / period) - 1;
    const k1 = Math.ceil((tmax - t0) / period) + 1;
    const nNeg = { x: -n.x, y: -n.y };
    for (let k = k0; k <= k1; k++) {
      const lo = t0 + k * period;
      const hi = lo + p.gap;
      if (hi <= tmin || lo >= tmax) continue;
      let band = clipHalf(c3, n, hi);
      if (band.length) band = clipHalf(band, nNeg, -lo);
      band = clean(band);
      if (band.length < 3) continue;
      const core = inset(band, ro);
      if (core.length === 0) {
        dropped++;
        continue;
      }
      const rp: RoundPoly = { pts: core, r: ro };
      if (rpLength(rp) < p.minSlot) {
        dropped++;
        continue;
      }
      slots.push(rp);
    }
  }

  const plateArea = rpArea(outline);
  let open = 0;
  let cut = rpPerimeter(outline);
  for (const sl of slots) {
    open += rpArea(sl);
    cut += rpPerimeter(sl);
  }
  for (const hl of holes) cut += rpPerimeter(hl);

  return {
    w,
    h,
    outline,
    holes,
    slots,
    limits: lim,
    stats: {
      slots: slots.length,
      openArea: open / plateArea,
      cutLength: cut,
      pierces: slots.length + holes.length,
      dropped,
    },
  };
}

function pickDir(dirs: number[], parity: number, key: number[], s: Settings): number {
  const rule = s.pattern.rule;
  if (dirs.length === 1) return dirs[0];
  switch (rule) {
    case 'first':
      return dirs[0];
    case 'second':
      return dirs[1];
    case 'alternate':
      return dirs[parity % dirs.length];
    default: {
      const u = hash01(s.seed, key[0], key[1], key[2]);
      if (u >= s.pattern.variation) return dirs[0];
      const k = 1 + Math.floor(hash01(s.seed, key[0], key[1], key[2], 7) * (dirs.length - 1));
      return dirs[k];
    }
  }
}

function centroid(p: V[]): V {
  let x = 0,
    y = 0;
  for (const q of p) {
    x += q.x;
    y += q.y;
  }
  return { x: x / p.length, y: y / p.length };
}
