// Strap patterns: networks of lines that become brass straps of the line
// width, with everything between them cut.
//
// Japanese kumiko-style motifs:
//   asanoha  hemp leaf: a triangle grid with lines from each triangle's
//            center to its corners, giving six-petal "leaves".
//   kagome   basket weave: three families of parallel lines offset so they
//            never meet at one point, giving hexagons ringed by triangles.
// Islamic star patterns, by Hankin's polygons-in-contact method: from the
// midpoint of every tile edge two rays leave at the contact angle; each ray
// stops where it meets its neighbour's. Across the shared edge the rays carry
// on into the next tile, so straps run continuously through the pattern.
//   star8    octagon and square tiling (4.8.8): eight-point stars.
//   star6    hexagon tiling: six-point stars.
//   star4    square tiling: four-point stars and octagons.

import { V, orient } from './geom';
import type { Settings } from './settings';

export type Seg = [number, number, number, number]; // ax, ay, bx, by in plate inches

const DEG = Math.PI / 180;

function rot(v: V, a: number): V {
  const c = Math.cos(a),
    s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Hankin rays for one convex tile. */
function hankin(tile: V[], theta: number, out: [V, V][]) {
  const p = orient(tile);
  const n = p.length;
  const mids: V[] = [];
  const fwd: V[] = [];
  const back: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[i],
      b = p[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const d = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
    mids.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    fwd.push(rot(d, theta));
    back.push(rot({ x: -d.x, y: -d.y }, -theta));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const m1 = mids[i],
      r1 = fwd[i],
      m2 = mids[j],
      r2 = back[j];
    const den = r1.x * r2.y - r1.y * r2.x;
    if (Math.abs(den) < 1e-9) continue;
    const dx = m2.x - m1.x,
      dy = m2.y - m1.y;
    const t = (dx * r2.y - dy * r2.x) / den;
    const u = (dx * r1.y - dy * r1.x) / den;
    if (t <= 0 || u <= 0) continue;
    const X = { x: m1.x + r1.x * t, y: m1.y + r1.y * t };
    out.push([m1, X], [X, m2]);
  }
}

function regular(cx: number, cy: number, R: number, n: number, a0: number): V[] {
  return Array.from({ length: n }, (_, k) => ({
    x: cx + R * Math.cos(a0 + (2 * Math.PI * k) / n),
    y: cy + R * Math.sin(a0 + (2 * Math.PI * k) / n),
  }));
}

/** Line segments of the chosen motif in pattern space, covering radius R. */
function motifSegments(s: Settings, R: number): [V, V][] {
  const p = s.pattern;
  const sc = p.scale;
  const theta = p.starAngle * DEG;
  const out: [V, V][] = [];
  const lim = R + 2 * sc;

  switch (p.motif) {
    case 'star8': {
      const a = sc;
      const t = a / (1 + Math.SQRT2);
      const Ro = t / (2 * Math.sin(Math.PI / 8));
      const N = Math.ceil(lim / a) + 1;
      for (let j = -N; j <= N; j++)
        for (let i = -N; i <= N; i++) {
          hankin(regular(i * a, j * a, Ro, 8, Math.PI / 8), theta, out);
          hankin(regular((i + 0.5) * a, (j + 0.5) * a, t / Math.SQRT2, 4, 0), theta, out);
        }
      break;
    }
    case 'star6': {
      const Rh = sc / Math.sqrt(3); // flat-to-flat width = scale
      const N = Math.ceil(lim / (1.5 * Rh)) + 2;
      const M = Math.ceil(lim / (Math.sqrt(3) * Rh)) + N;
      for (let r = -N; r <= N; r++)
        for (let q = -M; q <= M; q++) {
          const cx = Math.sqrt(3) * Rh * (q + r / 2);
          const cy = 1.5 * Rh * r;
          if (Math.abs(cx) > lim || Math.abs(cy) > lim) continue;
          hankin(regular(cx, cy, Rh, 6, 30 * DEG), theta, out);
        }
      break;
    }
    case 'star4': {
      const N = Math.ceil(lim / sc) + 1;
      for (let j = -N; j <= N; j++)
        for (let i = -N; i <= N; i++) hankin(regular(i * sc, j * sc, sc / Math.SQRT2, 4, 45 * DEG), theta, out);
      break;
    }
    case 'asanoha': {
      const h = (sc * Math.sqrt(3)) / 2;
      const K = Math.ceil(lim / h) + 1;
      const I = Math.ceil((2 * lim) / sc) + 2;
      for (let k = -K; k <= K; k++) {
        const y0 = k * h,
          y1 = y0 + h;
        for (let i = -I; i <= I; i++) {
          const x = (i * sc) / 2;
          const up = ((i + k) & 1) === 0;
          const tri: V[] = up
            ? [{ x, y: y1 }, { x: x + sc, y: y1 }, { x: x + sc / 2, y: y0 }]
            : [{ x, y: y0 }, { x: x + sc, y: y0 }, { x: x + sc / 2, y: y1 }];
          const c = { x: (tri[0].x + tri[1].x + tri[2].x) / 3, y: (tri[0].y + tri[1].y + tri[2].y) / 3 };
          for (let e = 0; e < 3; e++) {
            out.push([tri[e], tri[(e + 1) % 3]]);
            out.push([c, tri[e]]);
          }
        }
      }
      break;
    }
    case 'kagome': {
      const h = (sc * Math.sqrt(3)) / 2;
      const offsets = [0, 0, h / 2];
      for (let f = 0; f < 3; f++) {
        const a = (90 + 60 * f) * DEG;
        const n = { x: Math.cos(a), y: Math.sin(a) };
        const d = { x: -n.y, y: n.x };
        const K = Math.ceil(lim / h) + 1;
        for (let k = -K; k <= K; k++) {
          const c = k * h + offsets[f];
          const base = { x: n.x * c, y: n.y * c };
          out.push([
            { x: base.x - d.x * lim, y: base.y - d.y * lim },
            { x: base.x + d.x * lim, y: base.y + d.y * lim },
          ]);
        }
      }
      break;
    }
  }
  return out;
}

/** Strap centerlines in plate inches. */
export function latticeSegments(s: Settings): Seg[] {
  const { w, h } = s.plate;
  const rotA = (s.pattern.rot * Math.PI) / 180;
  const c = Math.cos(rotA),
    sn = Math.sin(rotA);
  const cx = w / 2,
    cy = h / 2;
  const R = Math.hypot(w, h) / 2;
  const tr = (q: V): V => ({ x: cx + q.x * c - q.y * sn, y: cy + q.x * sn + q.y * c });
  const segs: Seg[] = [];
  for (const [a, b] of motifSegments(s, R)) {
    const A = tr(a),
      B = tr(b);
    if (Math.max(A.x, B.x) < -1 || Math.min(A.x, B.x) > w + 1) continue;
    if (Math.max(A.y, B.y) < -1 || Math.min(A.y, B.y) > h + 1) continue;
    segs.push([A.x, A.y, B.x, B.y]);
  }
  return segs;
}
