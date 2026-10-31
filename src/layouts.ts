// Layouts split the plate into convex cells. Each cell carries the hatch
// directions that suit it (usually its own edge directions) and the integer
// coordinates used to seed its random choices.

import { V, orient } from './geom';
import type { Layout } from './settings';

export interface Cell {
  poly: V[]; // pattern space, positively oriented
  dirs: number[]; // candidate stripe directions, radians, pattern space
  key: [number, number, number]; // integer cell id for hashing
  parity: number; // for the "alternate" rule
}

const DEG = Math.PI / 180;

/** Cells covering a disk of radius R around the origin. */
export function makeCells(layout: Layout, s: number, R: number): Cell[] {
  switch (layout) {
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
