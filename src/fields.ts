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

import type { V } from './geom';
import { fbm } from './noise';
import { contours, edt, fixIslands, openSet, signedDistance, simplifyLoop, label } from './raster';
import { finishPlate, Plate } from './plate';
import { Settings, fabLimits } from './settings';
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

export function buildFieldPlate(s: Settings, quality: 'draft' | 'final', progress: Progress = () => {}): Plate {
  const { w, h, border } = s.plate;
  const p = s.pattern;
  const lim = fabLimits(s);
  const field = p.kind === 'rd' ? rdField(s, progress) : noiseField(s);
  progress('Shaping cuts');

  const rho = rasterRes(s, quality);
  const pad = 4;
  const W = Math.ceil(w * rho) + 2 * pad;
  const H = Math.ceil(h * rho) + 2 * pad;
  const toIn = (px: number) => (px - pad + 0.5) / rho;

  // 1. Threshold. Region mode cuts where the field is high. Band mode cuts
  // parallel bands offset from that region's outline, so every brass line
  // and every cut keeps exactly the set width, like growth rings.
  const level = quantile(field, s, p.open);
  const inner = (i: number, j: number) => {
    const x = toIn(i),
      y = toIn(j);
    return x >= border && x <= w - border && y >= border && y <= h - border;
  };
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
