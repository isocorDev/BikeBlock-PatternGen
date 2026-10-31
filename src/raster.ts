// Raster tools for field patterns: exact Euclidean distance transforms,
// morphological opening, island labeling and bridging, and contour tracing.
// Masks are Uint8Array with 1 = cut (hole), 0 = brass.

import type { V } from './geom';

const INF = 1e20;

/** Felzenszwalb-Huttenlocher 1D squared distance transform with argmin. */
function dt1(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
    arg[q] = v[k];
  }
}

/**
 * Squared distance (in pixels) from every pixel center to the nearest pixel
 * where sites[p] === siteValue. Optionally returns the index of that pixel.
 */
export function edt(
  mask: Uint8Array,
  W: number,
  H: number,
  siteValue: number,
  wantIndex = false,
): { d2: Float64Array; idx: Int32Array | null } {
  const N = Math.max(W, H);
  const f = new Float64Array(N);
  const d = new Float64Array(N);
  const arg = new Int32Array(N);
  const v = new Int32Array(N);
  const z = new Float64Array(N + 1);
  const colD = new Float64Array(W * H);
  const colArg = wantIndex ? new Int32Array(W * H) : null;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = mask[y * W + x] === siteValue ? 0 : INF;
    dt1(f, H, d, arg, v, z);
    for (let y = 0; y < H; y++) {
      colD[y * W + x] = d[y];
      if (colArg) colArg[y * W + x] = arg[y];
    }
  }
  const d2 = new Float64Array(W * H);
  const idx = wantIndex ? new Int32Array(W * H) : null;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = colD[row + x];
    dt1(f, W, d, arg, v, z);
    for (let x = 0; x < W; x++) {
      d2[row + x] = d[x];
      if (idx && colArg) {
        const ax = arg[x];
        idx[row + x] = colArg[row + ax] * W + ax;
      }
    }
  }
  return { d2, idx };
}

/**
 * Morphological opening of the set where mask === value, by radius r pixels:
 * removes every part of the set narrower than 2r and rounds its corners.
 * Returns a new mask; pixels removed from the set get the other value.
 */
export function openSet(mask: Uint8Array, W: number, H: number, value: number, r: number): Uint8Array {
  const other = value ? 0 : 1;
  const t = (r + 0.5) * (r + 0.5);
  const { d2: toOther } = edt(mask, W, H, other);
  const eroded = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) eroded[i] = mask[i] === value && toOther[i] >= t ? 1 : 0;
  const { d2: toEroded } = edt(eroded, W, H, 1);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] === value && toEroded[i] < t ? value : other;
  return out;
}

/** Label 4-connected components of pixels equal to value. Returns labels (0 = none) and sizes. */
export function label(mask: Uint8Array, W: number, H: number, value: number) {
  const lab = new Int32Array(W * H);
  const sizes: number[] = [0];
  const q = new Int32Array(W * H);
  let next = 1;
  for (let s = 0; s < W * H; s++) {
    if (mask[s] !== value || lab[s]) continue;
    let head = 0,
      tail = 0;
    q[tail++] = s;
    lab[s] = next;
    let count = 0;
    while (head < tail) {
      const p = q[head++];
      count++;
      const x = p % W;
      const y = (p - x) / W;
      if (x > 0 && mask[p - 1] === value && !lab[p - 1]) {
        lab[p - 1] = next;
        q[tail++] = p - 1;
      }
      if (x < W - 1 && mask[p + 1] === value && !lab[p + 1]) {
        lab[p + 1] = next;
        q[tail++] = p + 1;
      }
      if (y > 0 && mask[p - W] === value && !lab[p - W]) {
        lab[p - W] = next;
        q[tail++] = p - W;
      }
      if (y < H - 1 && mask[p + W] === value && !lab[p + W]) {
        lab[p + W] = next;
        q[tail++] = p + W;
      }
    }
    sizes.push(count);
    next++;
  }
  return { lab, sizes };
}

/**
 * Find brass islands (brass not connected to pixel 0, which is always brass)
 * and either remove them or tie each one to the main body with a straight
 * bridge of width bw pixels. Small islands are always removed.
 * Mutates mask. Returns counts.
 */
export function fixIslands(
  mask: Uint8Array,
  W: number,
  H: number,
  mode: 'bridge' | 'remove',
  bw: number,
  minKeepPx: number,
): { islands: number; bridges: number; removed: number } {
  const { lab, sizes } = label(mask, W, H, 0);
  const main = lab[0];
  const islandCount = sizes.length - 2; // minus the dummy 0 and the main body
  if (islandCount <= 0) return { islands: 0, bridges: 0, removed: 0 };

  let removed = 0;
  const bridgeIds: number[] = [];
  for (let L = 1; L < sizes.length; L++) {
    if (L === main) continue;
    if (mode === 'remove' || sizes[L] < minKeepPx) removed++;
    else bridgeIds.push(L);
  }
  // Remove first so removed islands are not bridge targets.
  for (let i = 0; i < W * H; i++) {
    const L = lab[i];
    if (L && L !== main && (mode === 'remove' || sizes[L] < minKeepPx)) mask[i] = 1;
  }
  if (!bridgeIds.length) return { islands: islandCount, bridges: 0, removed };

  const mainMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mainMask[i] = lab[i] === main ? 1 : 0;
  const { d2, idx } = edt(mainMask, W, H, 1, true);
  const best = new Map<number, { p: number; d: number }>();
  for (const L of bridgeIds) best.set(L, { p: -1, d: Infinity });
  for (let i = 0; i < W * H; i++) {
    const b = best.get(lab[i]);
    if (b && d2[i] < b.d) {
      b.d = d2[i];
      b.p = i;
    }
  }
  const hw = bw / 2 + 0.5;
  for (const { p } of best.values()) {
    if (p < 0) continue;
    const qi = idx![p];
    let ax = p % W,
      ay = (p - ax) / W,
      bx = qi % W,
      by = (qi - bx) / W;
    // Push both ends a little into solid brass for a sound joint.
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len,
      uy = (by - ay) / len;
    ax -= ux * hw;
    ay -= uy * hw;
    bx += ux * hw;
    by += uy * hw;
    stampCapsule(mask, W, H, ax, ay, bx, by, hw);
  }
  return { islands: islandCount, bridges: bridgeIds.length, removed };
}

function stampCapsule(mask: Uint8Array, W: number, H: number, ax: number, ay: number, bx: number, by: number, r: number) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
  const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
  const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r));
  const dx = bx - ax,
    dy = by - ay;
  const L2 = dx * dx + dy * dy || 1;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      let t = ((x - ax) * dx + (y - ay) * dy) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x,
        ey = ay + t * dy - y;
      if (ex * ex + ey * ey <= r * r) mask[y * W + x] = 0;
    }
}

/** Signed distance (pixels): positive inside cuts, negative in brass. */
export function signedDistance(mask: Uint8Array, W: number, H: number): Float32Array {
  const { d2: toBrass } = edt(mask, W, H, 0);
  const { d2: toCut } = edt(mask, W, H, 1);
  const s = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) s[i] = mask[i] ? Math.sqrt(toBrass[i]) - 0.5 : -(Math.sqrt(toCut[i]) - 0.5);
  return s;
}

/**
 * Trace closed contours where field > 0 using marching squares with linear
 * interpolation. Returns loops in pixel coordinates (pixel centers at integers).
 * The field's outer frame must be negative so every loop closes.
 */
export function contours(F: Float32Array, W: number, H: number): V[][] {
  const pts = new Map<number, V>();
  const link = new Map<number, number[]>();
  const hId = (i: number, j: number) => (j * (W + 1) + i) * 2;
  const vId = (i: number, j: number) => (j * (W + 1) + i) * 2 + 1;
  const val = (i: number, j: number) => F[j * W + i];
  const point = (id: number, ax: number, ay: number, av: number, bx: number, by: number, bv: number) => {
    if (!pts.has(id)) {
      const t = av / (av - bv);
      pts.set(id, { x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
    }
    return id;
  };
  const join = (a: number, b: number) => {
    (link.get(a) ?? link.set(a, []).get(a)!).push(b);
    (link.get(b) ?? link.set(b, []).get(b)!).push(a);
  };
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const a = val(i, j),
        b = val(i + 1, j),
        c = val(i + 1, j + 1),
        d = val(i, j + 1);
      const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const top = () => point(hId(i, j), i, j, a, i + 1, j, b);
      const right = () => point(vId(i + 1, j), i + 1, j, b, i + 1, j + 1, c);
      const bottom = () => point(hId(i, j + 1), i, j + 1, d, i + 1, j + 1, c);
      const left = () => point(vId(i, j), i, j, a, i, j + 1, d);
      switch (code) {
        case 1:
        case 14:
          join(left(), top());
          break;
        case 2:
        case 13:
          join(top(), right());
          break;
        case 3:
        case 12:
          join(left(), right());
          break;
        case 4:
        case 11:
          join(right(), bottom());
          break;
        case 6:
        case 9:
          join(top(), bottom());
          break;
        case 7:
        case 8:
          join(left(), bottom());
          break;
        case 5:
        case 10: {
          const center = (a + b + c + d) / 4;
          const corner = code === 5 ? center > 0 : center <= 0;
          // corner === true: a and c connected through the middle.
          if (corner) {
            join(left(), bottom());
            join(top(), right());
          } else {
            join(left(), top());
            join(right(), bottom());
          }
          break;
        }
      }
    }
  const loops: V[][] = [];
  const seen = new Set<number>();
  for (const start of link.keys()) {
    if (seen.has(start)) continue;
    const loop: V[] = [];
    let prev = -1;
    let cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push(pts.get(cur)!);
      const nb = link.get(cur)!;
      const nxt = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      if (nxt === undefined) break;
      cur = nxt;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Douglas-Peucker simplification of a closed loop. */
export function simplifyLoop(p: V[], tol: number): V[] {
  if (p.length < 8) return p;
  // Split at the point farthest from p[0] so both halves are open polylines.
  let far = 0,
    fd = -1;
  for (let i = 1; i < p.length; i++) {
    const d = (p[i].x - p[0].x) ** 2 + (p[i].y - p[0].y) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = dp(p.slice(0, far + 1), tol);
  const b = dp([...p.slice(far), p[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(p: V[], tol: number): V[] {
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = p[i0],
      b = p[i1];
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1e-12;
    let best = -1,
      bd = t2;
    for (let i = i0 + 1; i < i1; i++) {
      const t = Math.max(0, Math.min(1, ((p[i].x - a.x) * dx + (p[i].y - a.y) * dy) / L2));
      const ex = a.x + t * dx - p[i].x,
        ey = a.y + t * dy - p[i].y;
      const d = ex * ex + ey * ey;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  return p.filter((_, i) => keep[i]);
}
