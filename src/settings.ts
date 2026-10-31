// Design settings: the single source of truth for a plate.
// Everything a design needs to regenerate exactly lives in this object.

export const APP_ID = 'bikeblock-patterngen';
export const SETTINGS_VERSION = 3;

export type Kind = 'cells' | 'circles' | 'life' | 'lattice' | 'noise' | 'rd';
export type Layout = 'tumbling' | 'parquet' | 'triangles' | 'voronoi' | 'single';
export type Fill = 'hatch' | 'concentric' | 'open';
export type Sizing = 'noise' | 'radial' | 'gradient' | 'random';
export type FieldMode = 'region' | 'band';
export type RDPreset = 'coral' | 'labyrinth' | 'fingerprint' | 'spots' | 'worms';
export type IslandMode = 'bridge' | 'remove';
export type HatchRule = 'random' | 'first' | 'second' | 'alternate' | 'flow';
export type Process = 'waterjet' | 'laser';
export type Motif = 'asanoha' | 'kagome' | 'star8' | 'star6' | 'star4';
export type BlendMode = 'off' | 'crossfade' | 'mask' | 'union' | 'intersect' | 'subtract' | 'warp' | 'grow';
export type BlendSource = 'gradient' | 'radial' | 'noise' | 'band';

export interface Pattern {
  kind: Kind; // which generator
  layout: Layout; // cells: how the plate is divided
  fill: Fill; // cells: what goes in each cell
  scale: number; // main size, in: cell size, feature size, life cell, noise scale, lattice tile
  rot: number; // degrees
  line: number; // brass line width, in
  gap: number; // cut (slot) width, in
  seam: number; // brass band between cells, or bridge width, in
  rule: HatchRule;
  variation: number; // 0..1, used by the random rule
  phase: number; // 0..1, slides stripes within each cell
  minSlot: number; // drop slots shorter than this, in
  vJitter: number; // voronoi: 0 = grid, 1 = fully random sites
  vRelax: number; // voronoi: Lloyd relaxation passes
  cMin: number; // circles: smallest hole diameter, in
  cMax: number; // circles: largest hole diameter, in
  cSizing: Sizing; // circles: what drives hole size
  lifeDensity: number; // life: share of cells alive at the start
  lifeGens: number; // life: generations to run
  round: number; // life: 0 = square holes, 1 = round holes
  motif: Motif; // lattice: which strap pattern
  starAngle: number; // lattice stars: contact angle, degrees
  fieldMode: FieldMode; // noise and rd: blobs or contour bands
  open: number; // noise and rd region mode: target open share before fabrication fixes
  octaves: number; // noise: detail layers
  warp: number; // noise: domain warp strength
  rd: RDPreset; // reaction diffusion character
  islands: IslandMode; // raster patterns: what to do with brass that would fall out
}

export interface Blend {
  mode: BlendMode;
  source: BlendSource; // what decides where B shows, or how strongly
  amount: number; // 0..1 strength (crossfade, warp, grow)
  center: number; // 0..1 where the transition sits
  width: number; // 0..1 band width, as a share of the plate
  soft: number; // 0..1 how gradual the transition is
  angle: number; // degrees, for gradient and band
  nscale: number; // in, noise source feature size
  solidB: boolean; // mask: B side is solid brass instead of pattern B
}

export interface Settings {
  v: number;
  app: string;
  name: string;
  edition: number;
  seed: number;
  plate: {
    w: number; // in
    h: number; // in
    border: number; // solid brass band around the pattern, in
    corner: number; // outer corner radius, in
    holeD: number; // mounting hole diameter, in (0 = none)
  };
  material: {
    t: number; // thickness, in
    process: Process;
  };
  pattern: Pattern; // layer A
  patternB: Pattern; // layer B, used when blending
  blend: Blend;
}

const PATTERN_DEFAULT: Pattern = {
  kind: 'cells',
  layout: 'tumbling',
  fill: 'hatch',
  scale: 3.4,
  rot: 0,
  line: 0.14,
  gap: 0.22,
  seam: 0.14,
  rule: 'random',
  variation: 0.5,
  phase: 0,
  minSlot: 0.45,
  vJitter: 0.8,
  vRelax: 2,
  cMin: 0.2,
  cMax: 0.9,
  cSizing: 'noise',
  lifeDensity: 0.35,
  lifeGens: 6,
  round: 0.4,
  motif: 'star8',
  starAngle: 67.5,
  fieldMode: 'region',
  open: 0.42,
  octaves: 2,
  warp: 0.25,
  rd: 'coral',
  islands: 'bridge',
};

export const DEFAULTS: Settings = {
  v: SETTINGS_VERSION,
  app: APP_ID,
  name: 'Tumbling Blocks',
  edition: 1,
  seed: 427,
  plate: { w: 18, h: 10, border: 0.5, corner: 0.25, holeD: 0.25 },
  material: { t: 0.125, process: 'waterjet' },
  pattern: { ...PATTERN_DEFAULT },
  patternB: { ...PATTERN_DEFAULT, kind: 'rd', rd: 'coral', scale: 0.7, open: 0.45, seam: 0.16 },
  blend: {
    mode: 'off',
    source: 'gradient',
    amount: 0.6,
    center: 0.5,
    width: 0.3,
    soft: 0.35,
    angle: 0,
    nscale: 5,
    solidB: false,
  },
};

/** Fabrication minimums derived from material and process. */
export interface FabLimits {
  minWeb: number; // narrowest brass allowed
  minCut: number; // narrowest cut allowed
  cornerR: number; // inside corner radius the cutter leaves
  kerf: number;
}

export function fabLimits(s: Settings): FabLimits {
  const t = s.material.t;
  // Rules of thumb from common sheet-cutting design guides:
  // web >= max(0.063 in, 1x thickness); slot >= max(0.040 in, 1x thickness).
  const minWeb = Math.max(0.063, t);
  const minCut = Math.max(0.04, t);
  if (s.material.process === 'waterjet') {
    return { minWeb, minCut, cornerR: 0.5 * t, kerf: 0.03 };
  }
  return { minWeb, minCut, cornerR: Math.min(0.5 * t, 0.03), kerf: 0.008 };
}

export const THICKNESSES = [0.0625, 0.09375, 0.125, 0.1875, 0.25];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
function pick<T extends string>(x: unknown, opts: T[], d: T): T {
  return opts.includes(x as T) ? (x as T) : d;
}
const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

function sanitizePattern(raw: unknown, d: Pattern): Pattern {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  return {
    kind: pick(r.kind, ['cells', 'circles', 'life', 'lattice', 'noise', 'rd'], d.kind),
    layout: pick(r.layout, ['tumbling', 'parquet', 'triangles', 'voronoi', 'single'], d.layout),
    fill: pick(r.fill, ['hatch', 'concentric', 'open'], d.fill),
    scale: clamp(num(r.scale, d.scale), 0.2, 24),
    rot: clamp(num(r.rot, d.rot), -180, 180),
    line: num(r.line, d.line),
    gap: num(r.gap, d.gap),
    seam: num(r.seam, d.seam),
    rule: pick(r.rule, ['random', 'first', 'second', 'alternate', 'flow'], d.rule),
    variation: clamp(num(r.variation, d.variation), 0, 1),
    phase: clamp(num(r.phase, d.phase), 0, 1),
    minSlot: clamp(num(r.minSlot, d.minSlot), 0, 6),
    vJitter: clamp(num(r.vJitter, d.vJitter), 0, 1),
    vRelax: Math.round(clamp(num(r.vRelax, d.vRelax), 0, 6)),
    cMin: clamp(num(r.cMin, d.cMin), 0.04, 6),
    cMax: clamp(num(r.cMax, d.cMax), 0.04, 8),
    cSizing: pick(r.cSizing, ['noise', 'radial', 'gradient', 'random'], d.cSizing),
    lifeDensity: clamp(num(r.lifeDensity, d.lifeDensity), 0.02, 0.9),
    lifeGens: Math.round(clamp(num(r.lifeGens, d.lifeGens), 0, 300)),
    round: clamp(num(r.round, d.round), 0, 1),
    motif: pick(r.motif, ['asanoha', 'kagome', 'star8', 'star6', 'star4'], d.motif),
    starAngle: clamp(num(r.starAngle, d.starAngle), 50, 80),
    fieldMode: pick(r.fieldMode, ['region', 'band'], d.fieldMode),
    open: clamp(num(r.open, d.open), 0.05, 0.85),
    octaves: Math.round(clamp(num(r.octaves, d.octaves), 1, 6)),
    warp: clamp(num(r.warp, d.warp), 0, 2),
    rd: pick(r.rd, ['coral', 'labyrinth', 'fingerprint', 'spots', 'worms'], d.rd),
    islands: pick(r.islands, ['bridge', 'remove'], d.islands),
  };
}

function enforcePattern(p: Pattern, lim: FabLimits, notes: string[], label: string) {
  const f3 = (x: number) => x.toFixed(3);
  if (p.line < lim.minWeb) {
    notes.push(`${label}line width raised to ${f3(lim.minWeb)} in (minimum brass web).`);
    p.line = lim.minWeb;
  }
  if (p.gap < lim.minCut) {
    notes.push(`${label}gap raised to ${f3(lim.minCut)} in (minimum cut width).`);
    p.gap = lim.minCut;
  }
  if (p.seam < lim.minWeb) {
    notes.push(`${label}seam raised to ${f3(lim.minWeb)} in (minimum brass web).`);
    p.seam = lim.minWeb;
  }
  if (p.cMin < lim.minCut) p.cMin = lim.minCut;
  if (p.cMax < p.cMin) p.cMax = p.cMin;
  p.line = Math.min(p.line, 3);
  p.gap = Math.min(p.gap, 3);
  p.seam = Math.min(p.seam, 3);
  // Life and lattice need room for a cut inside each cell.
  if (p.kind === 'life' && p.scale < p.line + lim.minCut) p.scale = p.line + lim.minCut;
  if (p.kind === 'lattice' && p.scale < 4 * (p.line + lim.minCut)) p.scale = 4 * (p.line + lim.minCut);
}

/**
 * Merge an untrusted object (URL, file, storage) over the defaults and
 * enforce fabrication rules. Returns the clean settings plus notes about
 * anything that had to change.
 */
export function sanitize(raw: unknown): { s: Settings; notes: string[] } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as any;
  const d = DEFAULTS;
  const notes: string[] = [];
  const rp = r.plate ?? {};
  const rm = r.material ?? {};
  const rb = r.blend ?? {};

  const s: Settings = {
    v: SETTINGS_VERSION,
    app: APP_ID,
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : d.name,
    edition: Math.round(clamp(num(r.edition, d.edition), 1, 99999)),
    seed: Math.round(clamp(num(r.seed, d.seed), 0, 999999999)),
    plate: {
      w: clamp(num(rp.w, d.plate.w), 2, 72),
      h: clamp(num(rp.h, d.plate.h), 2, 72),
      border: num(rp.border, d.plate.border),
      corner: Math.max(0, num(rp.corner, d.plate.corner)),
      holeD: Math.max(0, num(rp.holeD, d.plate.holeD)),
    },
    material: {
      t: clamp(num(rm.t, d.material.t), 0.0625, 0.25),
      process: rm.process === 'laser' ? 'laser' : 'waterjet',
    },
    pattern: sanitizePattern(r.pattern, d.pattern),
    patternB: sanitizePattern(r.patternB, d.patternB),
    blend: {
      mode: pick(rb.mode, ['off', 'crossfade', 'mask', 'union', 'intersect', 'subtract', 'warp', 'grow'], d.blend.mode),
      source: pick(rb.source, ['gradient', 'radial', 'noise', 'band'], d.blend.source),
      amount: clamp(num(rb.amount, d.blend.amount), 0, 1),
      center: clamp(num(rb.center, d.blend.center), 0, 1),
      width: clamp(num(rb.width, d.blend.width), 0.05, 1),
      soft: clamp(num(rb.soft, d.blend.soft), 0, 1),
      angle: clamp(num(rb.angle, d.blend.angle), -180, 180),
      nscale: clamp(num(rb.nscale, d.blend.nscale), 0.5, 30),
      solidB: rb.solidB === true || rb.solidB === 'true',
    },
  };

  const lim = fabLimits(s);
  enforcePattern(s.pattern, lim, notes, s.blend.mode === 'off' ? '' : 'A: ');
  enforcePattern(s.patternB, lim, s.blend.mode === 'off' ? [] : notes, 'B: ');
  notes.forEach((n, i) => (notes[i] = n.charAt(0).toUpperCase() + n.slice(1)));

  const f3 = (x: number) => x.toFixed(3);
  const pl = s.plate;
  const maxBorder = Math.min(pl.w, pl.h) / 3;
  if (pl.border < lim.minWeb) {
    notes.push(`Border raised to ${f3(lim.minWeb)} in.`);
    pl.border = lim.minWeb;
  }
  pl.border = Math.min(pl.border, maxBorder);
  pl.corner = Math.min(pl.corner, pl.border, Math.min(pl.w, pl.h) / 2);
  if (pl.holeD > 0) {
    const maxHole = pl.border - 2 * lim.minWeb;
    if (maxHole < lim.minCut) {
      notes.push('Mounting holes removed: border too narrow to hold them.');
      pl.holeD = 0;
    } else if (pl.holeD > maxHole) {
      notes.push(`Mounting holes reduced to ${f3(maxHole)} in to fit the border.`);
      pl.holeD = maxHole;
    } else if (pl.holeD < lim.minCut) {
      notes.push(`Mounting holes raised to ${f3(lim.minCut)} in.`);
      pl.holeD = lim.minCut;
    }
  }
  return { s, notes };
}

/** Settings with layer B promoted to the main pattern (and its own seed). */
export function layerB(s: Settings): Settings {
  return { ...s, seed: s.seed + 7919, pattern: s.patternB };
}

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}
