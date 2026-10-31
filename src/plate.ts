// Build the full plate from settings: outline, mounting holes and cuts.
//
// Analytic patterns (cells, circles, Game of Life) produce convex cuts that
// never touch each other or the border, so the brass is always one piece:
// - Cell cuts are pulled back from cell edges by seam/2, and from each other
//   by the line width.
// - Every convex cut is "opened" (shrunk by r, grown back round), which rounds
//   inside corners to the cutter radius and deletes slivers under the minimum
//   cut.
// Field patterns (noise, reaction diffusion) are built in fields.ts on a
// raster with explicit repair, and return free-form polygon cuts.

import {
  RoundPoly,
  V,
  clipHalf,
  clipRect,
  clean,
  dot,
  inset,
  orient,
  outward,
  perimeter,
  rpArea,
  rpLength,
  rpPerimeter,
  signedArea,
} from './geom';
import { makeCells } from './layouts';
import { fbm } from './noise';
import { hash01, sfc32 } from './rng';
import { Settings, fabLimits, FabLimits } from './settings';

export interface PlateStats {
  slots: number; // number of separate cuts in the pattern
  openArea: number; // fraction of plate area that is pattern cut
  cutLength: number; // in, total cutter path
  pierces: number;
  dropped: number; // stubs or specks removed
  islands: number; // loose brass pieces left (should be 0)
  bridges: number; // bridges added to hold islands
  thinSpots: number; // places still under the minimum width (should be 0)
}

export interface Plate {
  w: number;
  h: number;
  outline: RoundPoly;
  holes: RoundPoly[]; // mounting holes
  slots: RoundPoly[]; // convex rounded cuts
  paths: V[][]; // free-form polygon cuts (field patterns)
  stats: PlateStats;
  limits: FabLimits;
  quality: 'draft' | 'final';
}

export const isFieldKind = (s: Settings) => s.pattern.kind === 'noise' || s.pattern.kind === 'rd';

/** Radius used to open every convex cut. */
export function openRadius(lim: FabLimits, width: number) {
  return Math.min(Math.max(lim.cornerR, lim.minCut / 2), width / 2 - 1e-6);
}

export function basePlate(s: Settings) {
  const { w, h, border, corner, holeD } = s.plate;
  const lim = fabLimits(s);
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
  return { w, h, outline, holes, lim };
}

export function finishPlate(
  s: Settings,
  slots: RoundPoly[],
  paths: V[][],
  extra: { dropped: number; islands?: number; bridges?: number; thinSpots?: number; quality?: 'draft' | 'final' },
): Plate {
  const b = basePlate(s);
  const plateArea = rpArea(b.outline);
  let open = 0;
  let cut = rpPerimeter(b.outline);
  for (const sl of slots) {
    open += rpArea(sl);
    cut += rpPerimeter(sl);
  }
  for (const pth of paths) {
    open += Math.abs(signedArea(pth));
    cut += perimeter(pth);
  }
  for (const hl of b.holes) cut += rpPerimeter(hl);
  return {
    w: b.w,
    h: b.h,
    outline: b.outline,
    holes: b.holes,
    slots,
    paths,
    limits: b.lim,
    quality: extra.quality ?? 'final',
    stats: {
      slots: slots.length + paths.length,
      openArea: open / plateArea,
      cutLength: cut,
      pierces: slots.length + paths.length + b.holes.length,
      dropped: extra.dropped,
      islands: extra.islands ?? 0,
      bridges: extra.bridges ?? 0,
      thinSpots: extra.thinSpots ?? 0,
    },
  };
}

/** Synchronous builder for the analytic kinds. Field kinds go through fields.ts. */
export function buildPlate(s: Settings): Plate {
  switch (s.pattern.kind) {
    case 'circles':
      return buildCircles(s);
    case 'life':
      return buildLife(s);
    default:
      return buildCells(s);
  }
}

// ---------------------------------------------------------------- cells

function buildCells(s: Settings): Plate {
  const { w, h, border } = s.plate;
  const p = s.pattern;
  const lim = fabLimits(s);
  const cx = w / 2;
  const cy = h / 2;
  const rot = (p.rot * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const toPlate = (q: V): V => ({ x: cx + q.x * cos - q.y * sin, y: cy + q.x * sin + q.y * cos });
  const R = Math.hypot(w, h) / 2;
  const cells = makeCells(s, R);

  const period = p.line + p.gap;
  const ro = openRadius(lim, p.gap);
  const slots: RoundPoly[] = [];
  let dropped = 0;

  const keep = (poly: V[], r: number, minLen: number) => {
    const c = clean(poly);
    if (c.length < 3) return;
    const core = inset(c, r);
    if (!core.length) {
      dropped++;
      return;
    }
    const rp: RoundPoly = { pts: core, r };
    if (rpLength(rp) < minLen) {
      dropped++;
      return;
    }
    slots.push(rp);
  };

  for (const cell of cells) {
    const poly = cell.poly.map(toPlate);
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

    if (p.fill === 'open') {
      keep(c3, Math.min(Math.max(lim.cornerR, lim.minCut / 2), 0.5), p.minSlot);
      continue;
    }

    if (p.fill === 'concentric') {
      concentric(c3, s, ro, keep);
      continue;
    }

    const dir = pickDir(cell.dirs, cell.parity, cell.key, s) + rot;
    const n = { x: -Math.sin(dir), y: Math.cos(dir) };
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
      keep(band, ro, p.minSlot);
    }
  }
  return finishPlate(s, slots, [], { dropped });
}

/**
 * Concentric bands following the cell outline. Each band is split into one
 * straight slot per edge; the brass left at the corners (seam wide) holds
 * every inner ring in place, so nothing falls out.
 */
function concentric(c3: V[], s: Settings, ro: number, keep: (p: V[], r: number, minLen: number) => void) {
  const p = s.pattern;
  const period = p.line + p.gap;
  const n = c3.length;
  const normals: V[] = [];
  const cs: number[] = [];
  for (let i = 0; i < n; i++) {
    const nn = outward(c3[i], c3[(i + 1) % n]);
    normals.push(nn);
    cs.push(dot(nn, c3[i]));
  }
  const half = p.seam / 2;
  for (let k = 0; k < 400; k++) {
    const d = (p.phase * period) % period + k * period;
    const P = d > 0 ? inset(c3, d) : c3;
    if (P.length < 3) break;
    for (let i = 0; i < n; i++) {
      const D = d + p.gap;
      let slot = clipHalf(P, { x: -normals[i].x, y: -normals[i].y }, -(cs[i] - D));
      for (let j = 0; j < n && slot.length; j++) {
        if (j === i) continue;
        const m = { x: normals[j].x - normals[i].x, y: normals[j].y - normals[i].y };
        const L = Math.hypot(m.x, m.y);
        if (L < 1e-9) continue;
        slot = clipHalf(slot, m, cs[j] - cs[i] - half * L);
      }
      if (slot.length >= 3) keep(slot, ro, p.minSlot);
    }
  }
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

// ---------------------------------------------------------------- circle packing

/**
 * Greedy, seeded circle packing. Each candidate gets the size the sizing
 * field asks for, shrunk until it clears its neighbors by the line width.
 * Circles never touch, so the brass stays one piece.
 */
function buildCircles(s: Settings): Plate {
  const { w, h, border } = s.plate;
  const p = s.pattern;
  const lim = fabLimits(s);
  const rMin = Math.max(p.cMin, lim.minCut) / 2;
  const rMax = Math.max(p.cMax / 2, rMin);
  const gapC = p.line;
  const x0 = border,
    y0 = border,
    x1 = w - border,
    y1 = h - border;
  const rnd = sfc32(s.seed, 77);
  const noise = fbm(s.seed, 2, 0.3);
  const cx = w / 2,
    cy = h / 2;
  const maxD = Math.hypot(cx - x0, cy - y0);
  const rot = (p.rot * Math.PI) / 180;
  const want = (x: number, y: number): number => {
    let t: number;
    switch (p.cSizing) {
      case 'radial':
        t = 1 - Math.hypot(x - cx, y - cy) / maxD;
        break;
      case 'gradient': {
        const u = ((x - cx) * Math.cos(rot) + (y - cy) * Math.sin(rot)) / (x1 - x0);
        t = Math.min(1, Math.max(0, u + 0.5));
        break;
      }
      case 'random':
        t = rnd();
        break;
      default:
        t = (noise(x / p.scale, y / p.scale) + 0.75) / 1.5;
    }
    t = Math.min(1, Math.max(0, t));
    return rMin + (rMax - rMin) * t * t;
  };

  const cell = 2 * rMax + gapC;
  const cols = Math.ceil((x1 - x0) / cell) + 1;
  const grid = new Map<number, number[]>();
  const circles: { x: number; y: number; r: number }[] = [];
  const gi = (x: number, y: number) => Math.floor((x - x0) / cell) + Math.floor((y - y0) / cell) * cols;

  let fails = 0;
  const area = (x1 - x0) * (y1 - y0);
  const maxAttempts = Math.min(400000, Math.ceil((area / (rMin * rMin)) * 8));
  for (let a = 0; a < maxAttempts && fails < 6000; a++) {
    const x = x0 + rnd() * (x1 - x0);
    const y = y0 + rnd() * (y1 - y0);
    let r = Math.min(want(x, y), x - x0, x1 - x, y - y0, y1 - y);
    if (r < rMin) {
      fails++;
      continue;
    }
    const gx = Math.floor((x - x0) / cell);
    const gy = Math.floor((y - y0) / cell);
    for (let dy = -1; dy <= 1 && r >= rMin; dy++)
      for (let dx = -1; dx <= 1 && r >= rMin; dx++) {
        const b = grid.get(gx + dx + (gy + dy) * cols);
        if (!b) continue;
        for (const k of b) {
          const c = circles[k];
          const d = Math.hypot(c.x - x, c.y - y) - c.r - gapC;
          if (d < r) r = d;
          if (r < rMin) break;
        }
      }
    if (r < rMin) {
      fails++;
      continue;
    }
    fails = 0;
    const k = circles.length;
    circles.push({ x, y, r });
    const key = gi(x, y);
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(k);
  }
  const slots: RoundPoly[] = circles.map((c) => ({ pts: [{ x: c.x, y: c.y }], r: c.r }));
  return finishPlate(s, slots, [], { dropped: 0 });
}

// ---------------------------------------------------------------- Game of Life

/**
 * Conway's Game of Life on a seeded soup, run for N generations on a torus.
 * Live cells become rounded square holes inside a brass grid whose walls are
 * the line width, so holes never touch and nothing falls out.
 */
function buildLife(s: Settings): Plate {
  const { w, h, border } = s.plate;
  const p = s.pattern;
  const lim = fabLimits(s);
  const c = p.scale;
  const iw = w - 2 * border + p.line;
  const ih = h - 2 * border + p.line;
  const cols = Math.max(1, Math.floor(iw / c));
  const rows = Math.max(1, Math.floor(ih / c));
  const ox = (w - cols * c) / 2;
  const oy = (h - rows * c) / 2;

  let grid = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) grid[j * cols + i] = hash01(s.seed, i, j, 31) < p.lifeDensity ? 1 : 0;
  let next = new Uint8Array(cols * rows);
  for (let g = 0; g < p.lifeGens; g++) {
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            n += grid[((j + dy + rows) % rows) * cols + ((i + dx + cols) % cols)];
          }
        const alive = grid[j * cols + i];
        next[j * cols + i] = n === 3 || (alive && n === 2) ? 1 : 0;
      }
    [grid, next] = [next, grid];
  }

  const a = c - p.line; // hole side
  const slots: RoundPoly[] = [];
  let dropped = 0;
  if (a < lim.minCut) {
    dropped = grid.reduce((x, y) => x + y, 0);
    return finishPlate(s, [], [], { dropped });
  }
  const rr = Math.min(a / 2, Math.max(openRadius(lim, a), p.round * (a / 2)));
  const half = a / 2 - rr;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!grid[j * cols + i]) continue;
      const x = ox + (i + 0.5) * c;
      const y = oy + (j + 0.5) * c;
      const pts =
        half < 1e-6
          ? [{ x, y }]
          : orient([
              { x: x - half, y: y - half },
              { x: x + half, y: y - half },
              { x: x + half, y: y + half },
              { x: x - half, y: y + half },
            ]);
      slots.push({ pts, r: rr });
    }
  return finishPlate(s, slots, [], { dropped });
}
