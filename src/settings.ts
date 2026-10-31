// Design settings: the single source of truth for a plate.
// Everything a design needs to regenerate exactly lives in this object.

export const APP_ID = 'bikeblock-patterngen';
export const SETTINGS_VERSION = 2;

export type Kind = 'cells' | 'circles' | 'life' | 'noise' | 'rd';
export type Layout = 'tumbling' | 'parquet' | 'triangles' | 'voronoi' | 'single';
export type Fill = 'hatch' | 'concentric' | 'open';
export type Sizing = 'noise' | 'radial' | 'gradient' | 'random';
export type FieldMode = 'region' | 'band';
export type RDPreset = 'coral' | 'labyrinth' | 'fingerprint' | 'spots' | 'worms';
export type IslandMode = 'bridge' | 'remove';
export type HatchRule = 'random' | 'first' | 'second' | 'alternate';
export type Process = 'waterjet' | 'laser';

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
  pattern: {
    kind: Kind; // which generator
    layout: Layout; // cells: how the plate is divided
    fill: Fill; // cells: what goes in each cell
    scale: number; // main size, in: cell size, feature size, life cell, noise scale
    rot: number; // degrees
    line: number; // brass line width, in
    gap: number; // cut (slot) width, in
    seam: number; // brass band between cells, in
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
    fieldMode: FieldMode; // noise and rd: blobs or contour bands
    open: number; // noise and rd region mode: target open share before fabrication fixes
    octaves: number; // noise: detail layers
    warp: number; // noise: domain warp strength
    rd: RDPreset; // reaction diffusion character
    islands: IslandMode; // fields: what to do with brass that would fall out
  };
}

export const DEFAULTS: Settings = {
  v: SETTINGS_VERSION,
  app: APP_ID,
  name: 'Tumbling Hatch',
  edition: 1,
  seed: 427,
  plate: { w: 18, h: 10, border: 0.5, corner: 0.25, holeD: 0.25 },
  material: { t: 0.125, process: 'waterjet' },
  pattern: {
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
    fieldMode: 'region',
    open: 0.42,
    octaves: 2,
    warp: 0.25,
    rd: 'coral',
    islands: 'bridge',
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
  const rpat = r.pattern ?? {};

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
    pattern: {
      kind: pick(rpat.kind, ['cells', 'circles', 'life', 'noise', 'rd'], d.pattern.kind),
      layout: pick(rpat.layout, ['tumbling', 'parquet', 'triangles', 'voronoi', 'single'], d.pattern.layout),
      fill: pick(rpat.fill, ['hatch', 'concentric', 'open'], d.pattern.fill),
      scale: clamp(num(rpat.scale, d.pattern.scale), 0.5, 24),
      rot: clamp(num(rpat.rot, d.pattern.rot), -180, 180),
      line: num(rpat.line, d.pattern.line),
      gap: num(rpat.gap, d.pattern.gap),
      seam: num(rpat.seam, d.pattern.seam),
      rule: pick(rpat.rule, ['random', 'first', 'second', 'alternate'], d.pattern.rule),
      variation: clamp(num(rpat.variation, d.pattern.variation), 0, 1),
      phase: clamp(num(rpat.phase, d.pattern.phase), 0, 1),
      minSlot: clamp(num(rpat.minSlot, d.pattern.minSlot), 0, 6),
      vJitter: clamp(num(rpat.vJitter, d.pattern.vJitter), 0, 1),
      vRelax: Math.round(clamp(num(rpat.vRelax, d.pattern.vRelax), 0, 6)),
      cMin: clamp(num(rpat.cMin, d.pattern.cMin), 0.04, 6),
      cMax: clamp(num(rpat.cMax, d.pattern.cMax), 0.04, 8),
      cSizing: pick(rpat.cSizing, ['noise', 'radial', 'gradient', 'random'], d.pattern.cSizing),
      lifeDensity: clamp(num(rpat.lifeDensity, d.pattern.lifeDensity), 0.02, 0.9),
      lifeGens: Math.round(clamp(num(rpat.lifeGens, d.pattern.lifeGens), 0, 300)),
      round: clamp(num(rpat.round, d.pattern.round), 0, 1),
      fieldMode: pick(rpat.fieldMode, ['region', 'band'], d.pattern.fieldMode),
      open: clamp(num(rpat.open, d.pattern.open), 0.05, 0.85),
      octaves: Math.round(clamp(num(rpat.octaves, d.pattern.octaves), 1, 6)),
      warp: clamp(num(rpat.warp, d.pattern.warp), 0, 2),
      rd: pick(rpat.rd, ['coral', 'labyrinth', 'fingerprint', 'spots', 'worms'], d.pattern.rd),
      islands: pick(rpat.islands, ['bridge', 'remove'], d.pattern.islands),
    },
  };

  const lim = fabLimits(s);
  const p = s.pattern;
  const f3 = (x: number) => x.toFixed(3);
  if (p.line < lim.minWeb) {
    notes.push(`Line width raised to ${f3(lim.minWeb)} in (minimum brass web).`);
    p.line = lim.minWeb;
  }
  if (p.gap < lim.minCut) {
    notes.push(`Gap raised to ${f3(lim.minCut)} in (minimum cut width).`);
    p.gap = lim.minCut;
  }
  if (p.seam < lim.minWeb) {
    notes.push(`Seam raised to ${f3(lim.minWeb)} in (minimum brass web).`);
    p.seam = lim.minWeb;
  }
  if (p.cMin < lim.minCut) p.cMin = lim.minCut;
  if (p.cMax < p.cMin) p.cMax = p.cMin;
  p.line = Math.min(p.line, 3);
  p.gap = Math.min(p.gap, 3);
  p.seam = Math.min(p.seam, 3);

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

export function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}
