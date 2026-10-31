// Layouts split the plate into convex cells. Each cell carries the hatch
// directions that suit it (usually its own edge directions) and the integer
// coordinates used to seed its random choices.

import { V, clipHalf, orient, signedArea } from './geom';
import { hash01 } from './rng';
import type { Settings } from './settings';

export interface Cell {
  poly: V[]; // pattern space, positively oriented
  dirs: number[]; // candidate stripe directions, radians, pattern space
  key: [number, number, number]; // integer cell id for hashing
  parity: number; // for the "alternate" rule
}

const DEG = Math.PI / 180;

/** Cells covering a disk of radius R around the origin. */
export function makeCells(st: Settings, R: number): Cell[] {
  const s = st.pattern.scale;
  switch (st.pattern.layout) {
    case 'voronoi':
      return voronoi(st, R);
    case 'tumbling':
      return tumbling(s, R);
    case 'parquet':
      return parquet(s, R);
    case 'triangles':
      return triangles(s, R);
    default:
      return single(R);
  }
}

function single(R: number): Cell[] {
  const r = R * 1.5;
  return [
    {
      poly: orient([
        { x: -r, y: -r },
        { x: r, y: -r },
        { x: r, y: r },
        { x: -r, y: r },
      ]),
      dirs: [0, 90 * DEG],
      key: [0, 0, 0],
      parity: 0,
    },
  ];
}

/** Hexagons split into three rhombi: the "tumbling blocks" of the reference. */
function tumbling(s: number, R: number): Cell[] {
  const cells: Cell[] = [];
  const sq3 = Math.sqrt(3);
  const N = Math.ceil(R / (1.5 * s)) + 2;
  const M = Math.ceil(R / (sq3 * s)) + Math.ceil(N / 2) + 2;
  const lim = R + 2 * s;
  for (let r = -N; r <= N; r++) {
    for (let q = -M; q <= M; q++) {
      const cx = sq3 * s * (q + r / 2);
      const cy = 1.5 * s * r;
      if (Math.abs(cx) > lim || Math.abs(cy) > lim) continue;
      const vert = (k: number): V => {
        const a = (30 + 60 * k) * DEG;
        return { x: cx + s * Math.cos(a), y: cy + s * Math.sin(a) };
      };
      for (let j = 0; j < 3; j++) {
        const c = { x: cx, y: cy };
        cells.push({
          poly: orient([c, vert(2 * j), vert(2 * j + 1), vert((2 * j + 2) % 6)]),
          dirs: [(30 + 120 * j) * DEG, (150 + 120 * j) * DEG],
          key: [q, r, j],
          parity: (q + r + j) & 1,
        });
      }
    }
  }
  return cells;
}

/** Square grid; "alternate" gives a basketweave. */
function parquet(s: number, R: number): Cell[] {
  const cells: Cell[] = [];
  const N = Math.ceil(R / s) + 1;
  for (let j = -N; j <= N; j++) {
    for (let i = -N; i <= N; i++) {
      const x0 = (i - 0.5) * s;
      const y0 = (j - 0.5) * s;
      cells.push({
        poly: orient([
          { x: x0, y: y0 },
          { x: x0 + s, y: y0 },
          { x: x0 + s, y: y0 + s },
          { x: x0, y: y0 + s },
        ]),
        dirs: [0, 90 * DEG],
        key: [i, j, 0],
        parity: (i + j) & 1,
      });
    }
  }
  return cells;
}

/** Equilateral triangles, hatched parallel to one of their three edges. */
function triangles(s: number, R: number): Cell[] {
  const cells: Cell[] = [];
  const h = (s * Math.sqrt(3)) / 2;
  const K = Math.ceil(R / h) + 1;
  const I = Math.ceil((2 * R) / s) + 2;
  for (let k = -K; k <= K; k++) {
    const y0 = k * h;
    const y1 = y0 + h;
    for (let i = -I; i <= I; i++) {
      const x = (i * s) / 2;
      const up = ((i + k) & 1) === 0;
      const poly = up
        ? [
            { x, y: y1 },
            { x: x + s, y: y1 },
            { x: x + s / 2, y: y0 },
          ]
        : [
            { x, y: y0 },
            { x: x + s, y: y0 },
            { x: x + s / 2, y: y1 },
          ];
      cells.push({
        poly: orient(poly),
        dirs: [0, 60 * DEG, 120 * DEG],
        key: [i, k, 0],
        parity: (((i + 2 * k) % 3) + 3) % 3,
      });
    }
  }
  return cells;
}

/**
 * Voronoi cells from a jittered grid of seeded sites, optionally relaxed
 * toward even sizes (Lloyd). Every cell is convex, so the same slot and
 * fabrication machinery works unchanged.
 */
function voronoi(st: Settings, R: number): Cell[] {
  const s = st.pattern.scale;
  const jit = st.pattern.vJitter;
  const lim = R + 2 * s;
  const N = Math.ceil(lim / s) + 1;
  type Site = { x: number; y: number; i: number; j: number };
  let sites: Site[] = [];
  for (let j = -N; j <= N; j++)
    for (let i = -N; i <= N; i++) {
      const ox = (hash01(st.seed, i, j, 11) - 0.5) * jit * s;
      const oy = (hash01(st.seed, i, j, 12) - 0.5) * jit * s;
      sites.push({ x: (i + (j & 1 ? 0.5 : 0)) * s + ox, y: j * s * 0.866 + oy, i, j });
    }
  const B = lim + s;
  const box: V[] = orient([
    { x: -B, y: -B },
    { x: B, y: -B },
    { x: B, y: B },
    { x: -B, y: B },
  ]);
  const cellsOf = (ss: Site[]) => {
    // Spatial hash for neighbor lookup.
    const g = new Map<string, number[]>();
    const key = (x: number, y: number) => `${Math.floor(x / s)},${Math.floor(y / s)}`;
    ss.forEach((p, k) => {
      const kk = key(p.x, p.y);
      (g.get(kk) ?? g.set(kk, []).get(kk)!).push(k);
    });
    return ss.map((p, k) => {
      let poly = box;
      const gx = Math.floor(p.x / s);
      const gy = Math.floor(p.y / s);
      for (let dy = -3; dy <= 3 && poly.length; dy++)
        for (let dx = -3; dx <= 3 && poly.length; dx++) {
          const bucket = g.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const m of bucket) {
            if (m === k) continue;
            const q = ss[m];
            const n = { x: q.x - p.x, y: q.y - p.y };
            poly = clipHalf(poly, n, (q.x * q.x + q.y * q.y - p.x * p.x - p.y * p.y) / 2);
            if (!poly.length) break;
          }
        }
      return poly;
    });
  };
  let polys = cellsOf(sites);
  for (let it = 0; it < st.pattern.vRelax; it++) {
    sites = sites.map((p, k) => {
      const c = areaCentroid(polys[k]);
      // Sites on the outer ring stay put so the edge does not collapse.
      return Math.abs(p.x) > lim - s || Math.abs(p.y) > lim - s || !c ? p : { ...p, x: c.x, y: c.y };
    });
    polys = cellsOf(sites);
  }
  const out: Cell[] = [];
  sites.forEach((p, k) => {
    const poly = polys[k];
    if (poly.length < 3 || Math.abs(p.x) > lim || Math.abs(p.y) > lim) return;
    out.push({
      poly: orient(poly),
      dirs: [0, 60 * DEG, 120 * DEG],
      key: [p.i, p.j, 0],
      parity: (((p.i + 2 * p.j) % 3) + 3) % 3,
    });
  });
  return out;
}

function areaCentroid(p: V[]): V | null {
  const a = signedArea(p);
  if (Math.abs(a) < 1e-9) return null;
  let cx = 0,
    cy = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    const w = p[(i + 1) % p.length];
    const c = q.x * w.y - w.x * q.y;
    cx += (q.x + w.x) * c;
    cy += (q.y + w.y) * c;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}
