// Stateless, order-independent hashing so a cell's random choice depends
// only on (seed, cell coordinates). Regenerating the same seed always
// produces the same plate, no matter what else changed or in what order
// cells are visited.

function mix(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform float in [0, 1) from integer inputs. */
export function hash01(...ints: number[]): number {
  let h = 0x9747b28c;
  for (const i of ints) h = mix(h, i | 0);
  return fmix(h ^ ints.length) / 4294967296;
}
