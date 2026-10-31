// Convex polygon geometry. Every cut in the plate is a "RoundPoly": a convex
// polygon grown outward by a radius r (a Minkowski sum with a disk). That one
// shape covers slots with rounded ends, circles (1 point), stadiums (2 points)
// and the rounded-rectangle outline, and it renders identically to canvas,
// SVG and DXF.

export type V = { x: number; y: number };

export const v = (x: number, y: number): V => ({ x, y });
export const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;

export function signedArea(p: V[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    const w = p[(i + 1) % p.length];
    a += q.x * w.y - w.x * q.y;
  }
  return a / 2;
}

/** Return the polygon with positive signed area. */
export function orient(p: V[]): V[] {
  return signedArea(p) < 0 ? p.slice().reverse() : p;
}

export function perimeter(p: V[]): number {
  if (p.length < 2) return 0;
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

/** Keep the part of polygon p where dot(n, x) <= c (Sutherland-Hodgman). */
export function clipHalf(p: V[], n: V, c: number): V[] {
  const out: V[] = [];
  const len = p.length;
  for (let i = 0; i < len; i++) {
    const a = p[i];
    const b = p[(i + 1) % len];
    const da = dot(n, a) - c;
    const db = dot(n, b) - c;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

export function clipRect(p: V[], x0: number, y0: number, x1: number, y1: number): V[] {
  let q = clipHalf(p, v(-1, 0), -x0);
  if (q.length) q = clipHalf(q, v(1, 0), x1);
  if (q.length) q = clipHalf(q, v(0, -1), -y0);
  if (q.length) q = clipHalf(q, v(0, 1), y1);
  return q;
}

/** Outward unit normal of edge a->b for a positively oriented polygon. */
export function outward(a: V, b: V): V {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  return { x: dy / l, y: -dx / l };
}

/**
 * Shrink a convex, positively oriented polygon by distance d.
 * Result is cleaned: [] when it vanishes, 1 point, 2 points (a segment) or
 * a proper convex polygon.
 */
export function inset(p: V[], d: number): V[] {
  if (p.length < 3) return [];
  let q = p;
  for (let i = 0; i < p.length && q.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const n = outward(a, b);
    q = clipHalf(q, n, dot(n, a) - d);
  }
  return clean(q);
}

const EPS = 1e-7;

/** Remove duplicate points and collapse slivers to a segment or a point. */
export function clean(p: V[]): V[] {
  const out: V[] = [];
  for (const pt of p) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 1e-6) out.push(pt);
  }
  while (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-6) out.pop();
    else break;
  }
  if (out.length < 3) return out;
  if (Math.abs(signedArea(out)) > EPS) return orient(out);
  // Zero-area: keep the two farthest points as a segment.
  let best = 0;
  let pa = out[0];
  let pb = out[0];
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++) {
      const dd = Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y);
      if (dd > best) {
        best = dd;
        pa = out[i];
        pb = out[j];
      }
    }
  return best > 1e-6 ? [pa, pb] : [pa];
}

export interface RoundPoly {
  pts: V[]; // convex core, positively oriented (1, 2 or 3+ points)
  r: number; // grow radius
}

export function rpArea(rp: RoundPoly): number {
  const a = rp.pts.length >= 3 ? signedArea(rp.pts) : 0;
  return a + rp.r * perimeter(rp.pts) + Math.PI * rp.r * rp.r;
}

export function rpPerimeter(rp: RoundPoly): number {
  return perimeter(rp.pts) + 2 * Math.PI * rp.r;
}

/** Longest extent of the shape (core diameter + 2r). */
export function rpLength(rp: RoundPoly): number {
  let best = 0;
  const p = rp.pts;
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++)
      best = Math.max(best, Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
  return best + 2 * rp.r;
}

/** One step of a closed contour: a straight line or a circular arc. */
export type Seg =
  | { k: 'L'; a: V; b: V }
  | { k: 'A'; c: V; r: number; a0: number; a1: number }; // a1 > a0, angle increasing

/**
 * Walk the boundary of a RoundPoly as alternating lines and arcs.
 * Arcs always run in the direction of increasing angle.
 */
export function rpSegments(rp: RoundPoly): Seg[] {
  const { pts, r } = rp;
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) {
    const c = pts[0];
    return [
      { k: 'A', c, r, a0: 0, a1: Math.PI },
      { k: 'A', c, r, a0: Math.PI, a1: 2 * Math.PI },
    ];
  }
  const normals: V[] = [];
  for (let i = 0; i < n; i++) normals.push(outward(pts[i], pts[(i + 1) % n]));
  // For a 2-point core both "edges" are the same segment, opposite ways.
  const segs: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nIn = normals[(i - 1 + n) % n];
    const nOut = normals[i];
    if (r > 0) {
      let a0 = Math.atan2(nIn.y, nIn.x);
      let a1 = Math.atan2(nOut.y, nOut.x);
      while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
      if (n === 2) a1 = a0 + Math.PI;
      if (a1 - a0 > 1e-9) segs.push({ k: 'A', c: p, r, a0, a1 });
    }
    const q = pts[(i + 1) % n];
    segs.push({
      k: 'L',
      a: { x: p.x + nOut.x * r, y: p.y + nOut.y * r },
      b: { x: q.x + nOut.x * r, y: q.y + nOut.y * r },
    });
  }
  return segs;
}

export function arcPoint(c: V, r: number, a: number): V {
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}
