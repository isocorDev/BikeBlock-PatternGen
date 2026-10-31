// Field patterns: seeded noise and Gray-Scott reaction diffusion.
//
// A field is a smooth value over the plate. Thresholding it gives cut
// regions that can be any shape, so they get an explicit fabrication repair:
//   1. Threshold the field into a cut mask (border forced to brass).
//   2. Open the brass by half the minimum web: thin brass necks are removed.
//   3. Find brass islands; tie each to the main body with a straight bridge
//      (or remove it), so nothing falls out.
//   4. Open the cuts by half the minimum cut: narrow cuts disappear and every
//      inside corner gets the cutter radius.
//   5. Trace smooth outlines from the signed distance of the result.

import type { RoundPoly, V } from './geom';
import { fbm } from './noise';
import { contours, edt, fixIslands, openSet, signedDistance, simplifyLoop, label } from './raster';
import { buildPlate, finishPlate, Plate } from './plate';
import { latticeSegments } from './lattice';
import { Settings, fabLimits, layerB } from './settings';
import { sfc32 } from './rng';

export type Progress = (msg: string) => void;

/** Pixels per inch for the repair raster. */
export function rasterRes(s: Settings, quality: 'draft' | 'final') {
  const lim = fabLimits(s);
  if (quality === 'draft') return Math.max(28, Math.min(48, 5 / lim.minCut));
  return Math.max(64, Math.min(128, 12 / lim.minCut));
}

/** A sampled scalar field over the plate, with bilinear lookup in inches. */
interface Field {
  nx: number;
  ny: number;
  cell: number; // inches per sample
  data: Float32Array;
}

function sampleAt(f: Field, x: number, y: number): number {
  const fx = Math.min(f.nx - 1.001, Math.max(0, x / f.cell));
  const fy = Math.min(f.ny - 1.001, Math.max(0, y / f.cell));
  const i = Math.floor(fx),
    j = Math.floor(fy);
  const tx = fx - i,
    ty = fy - j;
  const d = f.data,
    n = f.nx;
  const a = d[j * n + i],
    b = d[j * n + i + 1],
    c = d[(j + 1) * n + i],
    e = d[(j + 1) * n + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}

function noiseField(s: Settings): Field {
  const { w, h } = s.plate;
  const p = s.pattern;
  const cell = Math.max(0.02, p.scale / 12);
  const nx = Math.ceil(w / cell) + 2;
  const ny = Math.ceil(h / cell) + 2;
  const n = fbm(s.seed, p.octaves, p.warp);
  const rot = (p.rot * Math.PI) / 180;
  const cs = Math.cos(rot),
    sn = Math.sin(rot);
  const cx = w / 2,
    cy = h / 2;
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = i * cell - cx,
        y = j * cell - cy;
      const u = (x * cs + y * sn) / p.scale;
      const v = (-x * sn + y * cs) / p.scale;
      data[j * nx + i] = n(u, v);
    }
  return { nx, ny, cell, data };
}

// Gray-Scott parameters (Karl Sims' formulation: dA = 1, dB = 0.5).
const RD_PRESETS: Record<string, { f: number; k: number }> = {
  coral: { f: 0.0545, k: 0.062 },
  labyrinth: { f: 0.029, k: 0.057 },
  fingerprint: { f: 0.037, k: 0.06 },
  spots: { f: 0.0367, k: 0.0649 },
  worms: { f: 0.058, k: 0.065 },
};

const rdCache = new Map<string, Field>();

function rdField(s: Settings, progress: Progress): Field {
  const { w, h } = s.plate;
  const p = s.pattern;
  const steps = 5000;
  const key = [s.seed, w, h, p.scale, p.rd, steps].join('|');
  const hit = rdCache.get(key);
  if (hit) return hit;

  // About 8 simulation cells per feature period.
  const cell = Math.max(0.01, p.scale / 8);
  const nx = Math.ceil(w / cell) + 2;
  const ny = Math.ceil(h / cell) + 2;
  const N = nx * ny;
  let A = new Float32Array(N).fill(1);
  let B = new Float32Array(N);
  let A2 = new Float32Array(N);
  let B2 = new Float32Array(N);

  // Seed with scattered patches so growth starts everywhere at once.
  const rnd = sfc32(s.seed, 300);
  const patches = Math.max(8, Math.round((nx * ny) / 180));
  for (let k = 0; k < patches; k++) {
    const px = Math.floor(rnd() * nx),
      py = Math.floor(rnd() * ny);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = (px + dx + nx) % nx,
          y = (py + dy + ny) % ny;
        B[y * nx + x] = 0.25 + 0.05 * rnd();
        A[y * nx + x] = 0.5;
      }
  }

  const { f, k } = RD_PRESETS[p.rd] ?? RD_PRESETS.coral;
  const up = new Int32Array(ny),
    dn = new Int32Array(ny),
    lf = new Int32Array(nx),
    rt = new Int32Array(nx);
  for (let y = 0; y < ny; y++) {
    up[y] = ((y - 1 + ny) % ny) * nx;
    dn[y] = ((y + 1) % ny) * nx;
  }
  for (let x = 0; x < nx; x++) {
    lf[x] = (x - 1 + nx) % nx;
    rt[x] = (x + 1) % nx;
  }
  for (let it = 0; it < steps; it++) {
    for (let y = 0; y < ny; y++) {
      const r0 = y * nx,
        ru = up[y],
        rd = dn[y];
      for (let x = 0; x < nx; x++) {
        const l = lf[x],
          r = rt[x];
        const i = r0 + x;
        const a = A[i],
          b = B[i];
        const lapA =
          0.2 * (A[r0 + l] + A[r0 + r] + A[ru + x] + A[rd + x]) +
          0.05 * (A[ru + l] + A[ru + r] + A[rd + l] + A[rd + r]) -
          a;
        const lapB =
          0.2 * (B[r0 + l] + B[r0 + r] + B[ru + x] + B[rd + x]) +
          0.05 * (B[ru + l] + B[ru + r] + B[rd + l] + B[rd + r]) -
          b;
        const abb = a * b * b;
        const na = a + (lapA - abb + f * (1 - a));
        const nb = b + (0.5 * lapB + abb - (k + f) * b);
        A2[i] = na < 0 ? 0 : na > 1 ? 1 : na;
        B2[i] = nb < 0 ? 0 : nb > 1 ? 1 : nb;
      }
    }
    [A, A2] = [A2, A];
    [B, B2] = [B2, B];
    if (it % 500 === 0) progress(`Growing the pattern, ${Math.round((it / steps) * 100)}%`);
  }
  const field: Field = { nx, ny, cell, data: B };
  if (rdCache.size > 6) rdCache.delete(rdCache.keys().next().value!);
  rdCache.set(key, field);
  return field;
}

/** Value at which a share `open` of the inner plate area lies above. */
function quantile(f: Field, s: Settings, open: number): number {
  const { w, h, border } = s.plate;
  const vals: number[] = [];
  for (let j = 0; j < f.ny; j++)
    for (let i = 0; i < f.nx; i++) {
      const x = i * f.cell,
        y = j * f.cell;
      if (x > border && x < w - border && y > border && y < h - border) vals.push(f.data[j * f.nx + i]);
    }
  if (!vals.length) return Infinity;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor((1 - open) * vals.length))];
}

export interface Grid {
  W: number;
  H: number;
  rho: number; // pixels per inch
  toIn: (px: number) => number; // pixel index to inches
  inner: (i: number, j: number) => boolean; // inside the patterned area
}

function makeGrid(s: Settings, rho: number): Grid {
  const { w, h, border } = s.plate;
  const pad = 4;
  const W = Math.ceil(w * rho) + 2 * pad;
  const H = Math.ceil(h * rho) + 2 * pad;
  const toIn = (px: number) => (px - pad + 0.5) / rho;
  const inner = (i: number, j: number) => {
    const x = toIn(i),
      y = toIn(j);
    return x >= border && x <= w - border && y >= border && y <= h - border;
  };
  return { W, H, rho, toIn, inner };
}

/** Cut mask of a noise or reaction diffusion layer. */
function fieldMask(s: Settings, g: Grid, progress: Progress): Uint8Array {
  const p = s.pattern;
  const { W, H, rho, toIn, inner } = g;
  const field = p.kind === 'rd' ? rdField(s, progress) : noiseField(s);
  // Region mode cuts where the field is high. Band mode cuts parallel bands
  // offset from that region's outline, so every brass line and every cut
  // keeps exactly the set width, like growth rings.
  const level = quantile(field, s, p.open);
  const region = new Uint8Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) region[j * W + i] = sampleAt(field, toIn(i), toIn(j)) > level ? 1 : 0;
  const mask = new Uint8Array(W * H);
  if (p.fieldMode === 'band') {
    const period = p.line + p.gap;
    const duty = p.gap / period;
    const sd = signedDistance(region, W, H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        if (!inner(i, j)) continue;
        const u = (sd[j * W + i] / rho - p.gap / 2) / period + p.phase;
        if (u - Math.floor(u) < duty) mask[j * W + i] = 1;
      }
  } else {
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) if (inner(i, j) && region[j * W + i]) mask[j * W + i] = 1;
  }
  return mask;
}

/** Cut mask of a lattice layer: brass straps along the motif lines. */
function latticeMask(s: Settings, g: Grid): Uint8Array {
  const { W, H, rho, inner } = g;
  const pad = 4;
  const center = new Uint8Array(W * H);
  // Mark strap centerlines, then grow them to the line width with one
  // distance transform (much faster than stamping long straps).
  for (const [ax, ay, bx, by] of latticeSegments(s)) {
    const x0 = (ax * rho) + pad - 0.5,
      y0 = (ay * rho) + pad - 0.5,
      x1 = (bx * rho) + pad - 0.5,
      y1 = (by * rho) + pad - 0.5;
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
    for (let k = 0; k <= n; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / n),
        y = Math.round(y0 + ((y1 - y0) * k) / n);
      if (x >= 0 && y >= 0 && x < W && y < H) center[y * W + x] = 1;
    }
  }
  const { d2 } = edt(center, W, H, 1);
  const r = (s.pattern.line / 2) * rho;
  const r2 = r * r;
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) if (inner(i, j) && d2[j * W + i] > r2) mask[j * W + i] = 1;
  return mask;
}

/** Cut mask of an analytic layer, rasterized from its exact geometry. */
function analyticMask(s: Settings, g: Grid): Uint8Array {
  const { W, H, rho } = g;
  const pad = 4;
  const pl = buildPlate(s);
  const mask = new Uint8Array(W * H);
  for (const rp of pl.slots) {
    const pts = rp.pts;
    let minx = Infinity,
      maxx = -Infinity,
      miny = Infinity,
      maxy = -Infinity;
    for (const q of pts) {
      minx = Math.min(minx, q.x);
      maxx = Math.max(maxx, q.x);
      miny = Math.min(miny, q.y);
      maxy = Math.max(maxy, q.y);
    }
    const i0 = Math.max(0, Math.floor((minx - rp.r) * rho + pad - 1)),
      i1 = Math.min(W - 1, Math.ceil((maxx + rp.r) * rho + pad + 1));
    const j0 = Math.max(0, Math.floor((miny - rp.r) * rho + pad - 1)),
      j1 = Math.min(H - 1, Math.ceil((maxy + rp.r) * rho + pad + 1));
    for (let j = j0; j <= j1; j++) {
      const y = g.toIn(j);
      for (let i = i0; i <= i1; i++) if (insideRound(rp, g.toIn(i), y)) mask[j * W + i] = 1;
    }
  }
  return mask;
}

function insideRound(rp: RoundPoly, x: number, y: number): boolean {
  const p = rp.pts;
  const n = p.length;
  if (n >= 3) {
    let inside = true;
    for (let k = 0; k < n && inside; k++) {
      const a = p[k],
        b = p[(k + 1) % n];
      // Positive orientation: outward normal is (dy, -dx).
      if ((b.y - a.y) * (x - a.x) - (b.x - a.x) * (y - a.y) > 0) inside = false;
    }
    if (inside) return true;
  }
  const r2 = rp.r * rp.r;
  for (let k = 0; k < n; k++) {
    const a = p[k],
      b = p[(k + 1) % n];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a.x + t * dx - x,
      ey = a.y + t * dy - y;
    if (ex * ex + ey * ey <= r2) return true;
  }
  return false;
}

/** Cut mask of the main pattern of s, whatever its kind. */
export function layerMask(s: Settings, g: Grid, progress: Progress): Uint8Array {
  switch (s.pattern.kind) {
    case 'noise':
    case 'rd':
      return fieldMask(s, g, progress);
    case 'lattice':
      return latticeMask(s, g);
    default:
      return analyticMask(s, g);
  }
}

const smooth = (e0: number, e1: number, x: number) => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The blend source: a value from 0 to 1 at every point of the plate. */
function sourceField(s: Settings): (x: number, y: number) => number {
  const b = s.blend;
  const { w, h } = s.plate;
  const cx = w / 2,
    cy = h / 2;
  const a = (b.angle * Math.PI) / 180;
  const ca = Math.cos(a),
    sa = Math.sin(a);
  const sw = Math.max(0.005, b.soft * 0.5);
  switch (b.source) {
    case 'radial': {
      const R = Math.hypot(w, h) / 2;
      return (x, y) => smooth(b.center - sw, b.center + sw, Math.hypot(x - cx, y - cy) / R);
    }
    case 'noise': {
      const n = fbm(s.seed + 31, 2, 0.3);
      return (x, y) => smooth(b.center - sw, b.center + sw, (n(x / b.nscale, y / b.nscale) + 0.8) / 1.6);
    }
    case 'band': {
      // A band across the plate, perpendicular to the angle direction.
      const ext = Math.abs(w * sa) / 2 + Math.abs(h * ca) / 2;
      const half = b.width / 2;
      const pos = 2 * b.center - 1;
      return (x, y) => {
        const v = (-(x - cx) * sa + (y - cy) * ca) / ext;
        return 1 - smooth(half - sw * 0.5, half + sw * 0.5, Math.abs(v - pos));
      };
    }
    default: {
      const ext = Math.abs(w * ca) / 2 + Math.abs(h * sa) / 2;
      return (x, y) => smooth(b.center - sw, b.center + sw, (((x - cx) * ca + (y - cy) * sa) / ext + 1) / 2);
    }
  }
}

function bilinear(F: Float32Array, W: number, H: number, x: number, y: number): number {
  x = Math.min(W - 1.001, Math.max(0, x));
  y = Math.min(H - 1.001, Math.max(0, y));
  const i = Math.floor(x),
    j = Math.floor(y);
  const tx = x - i,
    ty = y - j;
  const a = F[j * W + i],
    b = F[j * W + i + 1],
    c = F[(j + 1) * W + i],
    d = F[(j + 1) * W + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Combine layer A and layer B (or a source field) into one cut mask. */
function blendMask(s: Settings, g: Grid, progress: Progress): Uint8Array {
  const { W, H, rho, toIn, inner } = g;
  const b = s.blend;
  const lim = fabLimits(s);
  const m = sourceField(s);
  const mA = layerMask(s, g, progress);
  const sdA = signedDistance(mA, W, H);
  const needB = b.mode === 'crossfade' || b.mode === 'union' || b.mode === 'intersect' || b.mode === 'subtract' || (b.mode === 'mask' && !b.solidB);
  let sdB: Float32Array | null = null;
  if (needB) {
    const sB = layerB(s);
    sdB = signedDistance(layerMask(sB, g, progress), W, H);
  }
  progress('Blending');
  const out = new Uint8Array(W * H);
  const M = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const y = toIn(j);
    for (let i = 0; i < W; i++) M[j * W + i] = m(toIn(i), y);
  }

  if (b.mode === 'mask') {
    // Zone B where the source is above one half; a brass seam on the border.
    const zone = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) zone[k] = M[k] > 0.5 ? 1 : 0;
    const sdZ = signedDistance(zone, W, H);
    const seam = (Math.max(lim.minWeb, s.pattern.seam) / 2) * rho;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!inner(i, j) || Math.abs(sdZ[k]) < seam) continue;
        const v = zone[k] ? (sdB ? sdB[k] : -1) : sdA[k];
        if (v > 0) out[k] = 1;
      }
    return out;
  }

  if (b.mode === 'warp') {
    const nx = fbm(s.seed + 41, 2, 0),
      ny = fbm(s.seed + 43, 2, 0);
    // Displacement up to about a tenth of the noise size: enough to bend lines
    // like wood grain without tearing them apart.
    const amp = b.amount * b.nscale * 0.1 * rho;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!inner(i, j)) continue;
        const x = toIn(i),
          y = toIn(j);
        const strength = b.source === 'noise' ? 1 : M[k];
        const dx = nx(x / b.nscale, y / b.nscale) * amp * strength;
        const dy = ny(x / b.nscale, y / b.nscale) * amp * strength;
        if (bilinear(sdA, W, H, i + dx, j + dy) > 0) out[k] = 1;
      }
    return out;
  }

  if (b.mode === 'grow') {
    // Widen cuts where the source is high and narrow them where it is low.
    const p = s.pattern;
    const brass = p.kind === 'cells' && p.fill === 'open' ? p.seam : p.line;
    const cut = Math.max(p.gap, brass);
    // Never widen past what leaves the minimum brass, never narrow past the
    // minimum cut, so the gradient stays cuttable everywhere.
    const up = b.amount * 0.9 * Math.max(0, (brass - lim.minWeb) / 2) * rho;
    const down = b.amount * 0.9 * Math.max(0, (cut - lim.minCut) / 2) * rho;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const t = 2 * M[k] - 1;
        if (inner(i, j) && sdA[k] + (t > 0 ? t * up : t * down) > 0) out[k] = 1;
      }
    return out;
  }

  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (!inner(i, j)) continue;
      const a = sdA[k],
        bb = sdB![k];
      let v: number;
      switch (b.mode) {
        case 'union':
          v = Math.max(a, bb);
          break;
        case 'intersect':
          v = Math.min(a, bb);
          break;
        case 'subtract':
          v = Math.min(a, -bb);
          break;
        default:
          v = (1 - M[k]) * a + M[k] * bb;
      }
      if (v > 0) out[k] = 1;
    }
  return out;
}

export function buildFieldPlate(s: Settings, quality: 'draft' | 'final', progress: Progress = () => {}): Plate {
  const p = s.pattern;
  const lim = fabLimits(s);
  const rho = rasterRes(s, quality);
  const g = makeGrid(s, rho);
  const { W, H, toIn } = g;
  const mask = s.blend.mode === 'off' ? layerMask(s, g, progress) : blendMask(s, g, progress);
  progress('Shaping cuts');

  // 2-4. Repair. Removing thin brass can leave a narrow cut throat, and
  // closing a narrow throat can leave thin brass, so the two repairs run in
  // turn until they agree. Any brass neck still too thin is then thickened.
  // Half a pixel of slack so features right at the minimum are not lost to
  // pixel rounding (at final resolution that is under 0.01 in).
  const rb = Math.max(0.5, (lim.minWeb / 2) * rho - 0.5);
  const rc = Math.max(0.5, Math.max(lim.minCut / 2, lim.cornerR) * rho - 0.5);
  const minKeepPx = (2 * lim.minWeb * rho) ** 2;
  const bridgeW = Math.max(lim.minWeb, p.seam) * rho;
  let m: Uint8Array = mask;
  let bridges = 0;
  let removed = 0;
  const rounds = quality === 'draft' ? 1 : 3;
  for (let r = 0; r < rounds; r++) {
    let m1 = openSet(m, W, H, 0, rb);
    const isl = fixIslands(m1, W, H, p.islands, bridgeW, minKeepPx);
    bridges += isl.bridges;
    removed += isl.removed;
    m1 = openSet(m1, W, H, 1, rc);
    let same = true;
    for (let i = 0; i < m1.length && same; i++) if (m1[i] !== m[i]) same = false;
    m = m1;
    if (same) break;
  }
  if (quality === 'final') {
    const thick = openSet(m, W, H, 0, rb);
    const thin = new Uint8Array(W * H);
    let any = false;
    for (let i = 0; i < m.length; i++)
      if (m[i] === 0 && thick[i] === 1) {
        thin[i] = 1;
        any = true;
      }
    if (any) {
      const { d2 } = edt(thin, W, H, 1);
      const t = (rb + 1) * (rb + 1);
      for (let i = 0; i < m.length; i++) if (m[i] === 1 && d2[i] <= t) m[i] = 0;
      m = openSet(m, W, H, 1, rc);
      const isl = fixIslands(m, W, H, p.islands, bridgeW, minKeepPx);
      bridges += isl.bridges;
      removed += isl.removed;
    }
  }

  // Count what is still loose or too thin, so the readout can say so.
  const { sizes } = label(m, W, H, 0);
  const remaining = Math.max(0, sizes.length - 2);
  const thinSpots = countThin(m, W, H, rb, rc);

  // 5. Outlines.
  const sdf = signedDistance(m, W, H);
  const loops = contours(sdf, W, H);
  const tol = 0.35;
  const minArea = (lim.minCut * rho) ** 2 * 0.5;
  const paths: V[][] = [];
  let dropped = 0;
  for (const loop of loops) {
    const simp = simplifyLoop(loop, tol);
    let a = 0;
    for (let i = 0; i < simp.length; i++) {
      const q = simp[i],
        r = simp[(i + 1) % simp.length];
      a += q.x * r.y - r.x * q.y;
    }
    if (Math.abs(a / 2) < minArea || simp.length < 3) {
      dropped++;
      continue;
    }
    paths.push(simp.map((q) => ({ x: toIn(q.x), y: toIn(q.y) })));
  }
  return finishPlate(s, [], paths, {
    dropped: dropped + removed,
    islands: remaining,
    bridges,
    thinSpots,
    quality,
  });
}

/**
 * Number of separate places where brass or cut is narrower than allowed,
 * found by opening with a slightly smaller radius (so curve pixels do not
 * count) and labeling what the opening removes.
 */
function countThin(m: Uint8Array, W: number, H: number, rb: number, rc: number): number {
  let total = 0;
  for (const [value, r] of [
    [0, rb],
    [1, rc],
  ] as const) {
    const o = openSet(m, W, H, value, Math.max(0.5, r * 0.8 - 0.5));
    const lost = new Uint8Array(W * H);
    for (let i = 0; i < m.length; i++) if (m[i] === value && o[i] !== value) lost[i] = 1;
    const { sizes } = label(lost, W, H, 1);
    for (let k = 1; k < sizes.length; k++) if (sizes[k] >= 4) total++;
  }
  return total;
}
