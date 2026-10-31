// Seeded 2D simplex noise (after Stefan Gustavson's public-domain version)
// plus fractal sum and domain warp helpers. Pure arithmetic, so the same
// seed gives the same values on every device.

import { sfc32 } from './rng';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export type Noise2 = (x: number, y: number) => number;

export function simplex(seed: number, salt = 0): Noise2 {
  const rnd = sfc32(seed, 1000 + salt);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  return (xin: number, yin: number) => {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = GRAD[perm[ii + perm[jj]] & 7];
      t0 *= t0;
      n += t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7];
      t1 *= t1;
      n += t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7];
      t2 *= t2;
      n += t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * n; // roughly -1..1
  };
}

/** Fractal noise with optional domain warp. Coordinates in pattern units. */
export function fbm(seed: number, octaves: number, warp: number): Noise2 {
  const layers = Array.from({ length: octaves }, (_, k) => simplex(seed, k));
  const wx = simplex(seed, 50);
  const wy = simplex(seed, 51);
  const base: Noise2 = (x, y) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (const n of layers) {
      sum += amp * n(x * f, y * f);
      norm += amp;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  };
  if (warp <= 0) return base;
  return (x, y) => base(x + warp * wx(x * 0.7, y * 0.7), y + warp * wy(x * 0.7 + 5.2, y * 0.7 + 1.3));
}
