import './style.css';
import { buildPlate, finishPlate, isFieldKind, Plate } from './plate';
import { drawPlate, fitView, renderToCanvas, View, ViewMode, FRAME_RAIL, FRAME_REVEAL } from './render';
import { DEFAULTS, Kind, Settings, THICKNESSES, clone, fabLimits, sanitize } from './settings';
import { autosave, decodeHash, deleteSaved, encodeHash, listSaved, loadAutosave, saveDesign } from './store';
import { baseName, download, settingsFromFile, toDXF, toJPG, toPNG, toSVG } from './export';
import { hash01 } from './rng';

// ---------------------------------------------------------------- state

let s: Settings;
let notes: string[] = [];
let plate!: Plate;
let mode: ViewMode = 'brass';
let showFrame = true;
let view: View = { scale: 40, ox: 0, oy: 0 };
let userMovedView = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;

function initialSettings(): Settings {
  const fromHash = decodeHash(location.hash);
  if (fromHash) return sanitize(fromHash).s;
  const saved = loadAutosave();
  if (saved) return sanitize(saved).s;
  return clone(DEFAULTS);
}

// ---------------------------------------------------------------- controls

type Path = string;
interface NumCtl {
  path: Path;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  digits: number;
  hint?: string;
}

// The Pattern tab edits layer A or layer B; 'pattern.*' paths follow it.
let editing: 'A' | 'B' = 'A';
const route = (path: Path) => (editing === 'B' && path.startsWith('pattern.') ? 'patternB.' + path.slice(8) : path);
/** Settings as the controls see them: the edited layer in the pattern slot. */
const viewOf = (st: Settings): Settings => (editing === 'B' ? { ...st, pattern: st.patternB } : st);
const get = (path: Path): any => route(path).split('.').reduce((o: any, k) => o[k], s);
function set(path: Path, val: unknown) {
  const keys = route(path).split('.');
  const last = keys.pop()!;
  const o = keys.reduce((acc: any, k) => acc[k], s);
  o[last] = val;
}

type When = (s: Settings) => boolean;
const always: When = () => true;
const kindIs =
  (...k: Kind[]): When =>
  (st) =>
    k.includes(st.pattern.kind);
const conditional: { el: HTMLElement; when: When }[] = [];
function gate(el: HTMLElement, when: When) {
  if (when !== always) conditional.push({ el, when });
}

const numEls: { path: Path; range: HTMLInputElement; num: HTMLInputElement; ctl: NumCtl }[] = [];

function numRow(parent: HTMLElement, c: NumCtl, when: When = always) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'row';
  const id = 'c' + numEls.length + '-' + c.path.replace(/\./g, '-');
  row.innerHTML = `<label for="${id}">${c.label} <span class="unit">${c.unit}</span></label>`;
  const num = document.createElement('input');
  num.type = 'number';
  num.id = id;
  num.step = String(c.step);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(c.min);
  range.max = String(c.max);
  range.step = String(c.step);
  range.setAttribute('aria-label', c.label);
  range.addEventListener('input', () => {
    set(c.path, parseFloat(range.value));
    update();
  });
  num.addEventListener('change', () => {
    const vv = parseFloat(num.value);
    if (Number.isFinite(vv)) {
      set(c.path, vv);
      update();
    } else syncControls();
  });
  row.append(num, range);
  wrap.appendChild(row);
  if (c.hint) {
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = c.hint;
    wrap.appendChild(h);
  }
  parent.appendChild(wrap);
  gate(wrap, when);
  numEls.push({ path: c.path, range, num, ctl: c });
}

const selEls: { path: Path; sel: HTMLSelectElement }[] = [];
function selectRow(
  parent: HTMLElement,
  path: Path,
  label: string,
  options: [string, string][],
  numeric = false,
  when: When = always,
) {
  const row = document.createElement('div');
  row.className = 'select-row';
  const id = 'c' + selEls.length + '-' + path.replace(/\./g, '-');
  row.innerHTML = `<label for="${id}">${label}</label>`;
  const sel = document.createElement('select');
  sel.id = id;
  for (const [val, text] of options) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    set(path, numeric ? parseFloat(sel.value) : sel.value);
    userMovedView = userMovedView && path !== 'pattern.kind';
    update();
  });
  row.appendChild(sel);
  parent.appendChild(row);
  gate(row, when);
  selEls.push({ path, sel });
  return row;
}

function title(parent: HTMLElement, text: string, hint?: string, when: When = always) {
  const h = document.createElement('h3');
  h.className = 'group-title';
  h.textContent = text;
  parent.appendChild(h);
  gate(h, when);
  if (hint) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = hint;
    parent.appendChild(p);
    gate(p, when);
  }
}

function chips(parent: HTMLElement, items: [string, () => void][]) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  }
  parent.appendChild(wrap);
  return wrap;
}

type Preset = [string, Partial<Settings['pattern']>];
const PRESET_GROUPS: [string, Preset[]][] = [
  [
    'Geometric',
    [
      ['Tumbling blocks', { kind: 'cells', layout: 'tumbling', fill: 'hatch', scale: 3.4, rot: 0, line: 0.14, gap: 0.22, seam: 0.14, rule: 'random', variation: 0.5, phase: 0 }],
      ['Basketweave', { kind: 'cells', layout: 'parquet', fill: 'hatch', scale: 2, rot: 0, line: 0.14, gap: 0.2, seam: 0.2, rule: 'alternate', phase: 0 }],
      ['Triangle facets', { kind: 'cells', layout: 'triangles', fill: 'hatch', scale: 3, rot: 0, line: 0.14, gap: 0.2, seam: 0.14, rule: 'random', variation: 0.67, phase: 0 }],
      ['Nested rhombi', { kind: 'cells', layout: 'tumbling', fill: 'concentric', scale: 3.4, rot: 0, line: 0.14, gap: 0.18, seam: 0.16, phase: 0 }],
      ['Deco steps', { kind: 'cells', layout: 'parquet', fill: 'concentric', scale: 3.2, rot: 0, line: 0.14, gap: 0.2, seam: 0.2, phase: 0 }],
      ['Single field', { kind: 'cells', layout: 'single', fill: 'hatch', rot: 30, line: 0.14, gap: 0.22, rule: 'first', phase: 0 }],
    ],
  ],
  [
    'Japanese kumiko',
    [
      ['Asanoha', { kind: 'lattice', motif: 'asanoha', scale: 2.5, rot: 0, line: 0.14 }],
      ['Kagome', { kind: 'lattice', motif: 'kagome', scale: 1.6, rot: 0, line: 0.14 }],
    ],
  ],
  [
    'Islamic geometric',
    [
      ['Eight-point star', { kind: 'lattice', motif: 'star8', scale: 3, rot: 0, line: 0.14, starAngle: 67.5 }],
      ['Six-point star', { kind: 'lattice', motif: 'star6', scale: 3, rot: 0, line: 0.14, starAngle: 60 }],
      ['Four-point star', { kind: 'lattice', motif: 'star4', scale: 2.5, rot: 0, line: 0.14, starAngle: 67.5 }],
    ],
  ],
  [
    'Organic and generative',
    [
      ['Faceted stone', { kind: 'cells', layout: 'voronoi', fill: 'hatch', scale: 2.2, rot: 0, line: 0.14, gap: 0.2, seam: 0.16, rule: 'random', variation: 0.67, vJitter: 0.8, vRelax: 2 }],
      ['Flowing facets', { kind: 'cells', layout: 'voronoi', fill: 'hatch', scale: 1.6, rot: 0, line: 0.14, gap: 0.2, seam: 0.16, rule: 'flow', vJitter: 0.8, vRelax: 2 }],
      ['Stained glass', { kind: 'cells', layout: 'voronoi', fill: 'open', scale: 1.4, seam: 0.16, vJitter: 0.9, vRelax: 2 }],
      ['Coral', { kind: 'rd', rd: 'coral', scale: 0.7, open: 0.45, fieldMode: 'region', seam: 0.16, islands: 'bridge' }],
      ['Labyrinth', { kind: 'rd', rd: 'labyrinth', scale: 0.7, open: 0.45, fieldMode: 'region', seam: 0.16, islands: 'bridge' }],
      ['Topographic', { kind: 'noise', fieldMode: 'band', scale: 5, open: 0.5, octaves: 2, warp: 0.25, line: 0.14, gap: 0.2, seam: 0.16, islands: 'bridge' }],
      ['Perforated', { kind: 'circles', cSizing: 'noise', cMin: 0.15, cMax: 0.9, scale: 4, line: 0.14 }],
      ['Life', { kind: 'life', scale: 0.45, line: 0.14, round: 0.3, lifeDensity: 0.35, lifeGens: 6 }],
    ],
  ],
];

function applyPreset(name: string, pat: Partial<Settings['pattern']>) {
  Object.assign(editing === 'B' ? s.patternB : s.pattern, pat);
  if (editing === 'A') s.name = name;
  update();
}

function buildPatternPanel() {
  const p = $('panel-pattern');
  const sw = document.createElement('div');
  sw.className = 'layer-switch seg';
  sw.setAttribute('role', 'radiogroup');
  sw.setAttribute('aria-label', 'Layer to edit');
  sw.innerHTML = '<button data-layer="A" aria-pressed="true">Layer A</button><button data-layer="B" aria-pressed="false">Layer B</button>';
  sw.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      editing = b.dataset.layer as 'A' | 'B';
      syncControls();
    }),
  );
  const swWrap = document.createElement('div');
  swWrap.className = 'layer-row';
  const swHint = document.createElement('p');
  swHint.className = 'hint';
  swHint.textContent = 'Blending is on. Choose which layer these controls edit.';
  swWrap.append(sw, swHint);
  p.appendChild(swWrap);
  conditional.push({ el: swWrap, when: (st) => st.blend.mode !== 'off' });

  title(p, 'Presets');
  for (const [group, items] of PRESET_GROUPS) {
    const g = document.createElement('p');
    g.className = 'chip-group';
    g.textContent = group;
    p.appendChild(g);
    chips(p, items.map(([name, pat]) => [name, () => applyPreset(name, pat)]));
  }

  title(p, 'Generator');
  selectRow(p, 'pattern.kind', 'Pattern', [
    ['cells', 'Cells and fills'],
    ['circles', 'Circle packing'],
    ['lattice', 'Lattice (kumiko, Islamic)'],
    ['life', 'Game of Life'],
    ['noise', 'Noise field'],
    ['rd', 'Reaction diffusion'],
  ]);

  // ---- cells
  const cells = kindIs('cells');
  const hatch: When = (st) => cells(st) && st.pattern.fill === 'hatch' && st.pattern.layout !== 'single';
  const lined: When = (st) => cells(st) && st.pattern.fill !== 'open';
  title(p, 'Cells', 'The plate is divided into cells, and each cell gets a fill.', cells);
  selectRow(p, 'pattern.layout', 'Layout', [
    ['tumbling', 'Tumbling blocks'],
    ['parquet', 'Squares'],
    ['triangles', 'Triangles'],
    ['voronoi', 'Voronoi'],
    ['single', 'One field'],
  ], false, cells);
  selectRow(p, 'pattern.fill', 'Fill', [
    ['hatch', 'Parallel lines'],
    ['concentric', 'Concentric bands'],
    ['open', 'Open cell'],
  ], false, cells);
  selectRow(p, 'pattern.rule', 'Line direction', [
    ['random', 'Random by seed'],
    ['alternate', 'Alternating'],
    ['flow', 'Flowing'],
    ['first', 'All the same'],
    ['second', 'All the same, turned'],
  ], false, hatch);
  numRow(p, { path: 'pattern.variation', label: 'Direction mix', unit: '', min: 0, max: 1, step: 0.01, digits: 2, hint: 'Share of cells turned. Only used by Random by seed.' }, (st) => hatch(st) && st.pattern.rule === 'random');
  numRow(p, { path: 'pattern.scale', label: 'Cell size', unit: 'in', min: 0.75, max: 12, step: 0.05, digits: 2 }, (st) => cells(st) && st.pattern.layout !== 'single');
  numRow(p, { path: 'pattern.rot', label: 'Rotation', unit: 'deg', min: -90, max: 90, step: 1, digits: 0 }, cells);
  numRow(p, { path: 'pattern.vJitter', label: 'Irregularity', unit: '', min: 0, max: 1, step: 0.01, digits: 2 }, (st) => cells(st) && st.pattern.layout === 'voronoi');
  numRow(p, { path: 'pattern.vRelax', label: 'Evenness', unit: 'passes', min: 0, max: 6, step: 1, digits: 0 }, (st) => cells(st) && st.pattern.layout === 'voronoi');
  title(p, 'Lines', 'Brass line and cut widths set the rhythm. Fabrication sets the minimums.', lined);
  numRow(p, { path: 'pattern.line', label: 'Brass line', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, lined);
  numRow(p, { path: 'pattern.gap', label: 'Cut gap', unit: 'in', min: 0.04, max: 0.75, step: 0.005, digits: 3 }, lined);
  numRow(p, { path: 'pattern.seam', label: 'Seam between cells', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, cells);
  numRow(p, { path: 'pattern.phase', label: 'Line offset', unit: '', min: 0, max: 1, step: 0.01, digits: 2, hint: 'Slides the lines within each cell.' }, lined);
  numRow(p, { path: 'pattern.minSlot', label: 'Drop cuts shorter than', unit: 'in', min: 0, max: 2, step: 0.05, digits: 2, hint: 'Removes stubs where lines meet a corner.' }, cells);

  // ---- circles
  const circ = kindIs('circles');
  title(p, 'Circles', 'Holes are packed as tightly as the spacing allows, sized by a field.', circ);
  selectRow(p, 'pattern.cSizing', 'Size follows', [
    ['noise', 'Soft noise'],
    ['radial', 'Center outward'],
    ['gradient', 'Side to side'],
    ['random', 'Nothing (random)'],
  ], false, circ);
  numRow(p, { path: 'pattern.cMin', label: 'Smallest hole', unit: 'in', min: 0.04, max: 2, step: 0.01, digits: 2 }, circ);
  numRow(p, { path: 'pattern.cMax', label: 'Largest hole', unit: 'in', min: 0.04, max: 4, step: 0.01, digits: 2 }, circ);
  numRow(p, { path: 'pattern.line', label: 'Spacing', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, circ);
  numRow(p, { path: 'pattern.scale', label: 'Noise size', unit: 'in', min: 0.75, max: 12, step: 0.05, digits: 2 }, (st) => circ(st) && st.pattern.cSizing === 'noise');
  numRow(p, { path: 'pattern.rot', label: 'Direction', unit: 'deg', min: -180, max: 180, step: 1, digits: 0 }, (st) => circ(st) && st.pattern.cSizing === 'gradient');

  // ---- life
  const life = kindIs('life');
  title(p, 'Game of Life', 'A seeded random start, run forward a number of generations. Live cells are cut.', life);
  numRow(p, { path: 'pattern.scale', label: 'Cell size', unit: 'in', min: 0.2, max: 3, step: 0.01, digits: 2 }, life);
  numRow(p, { path: 'pattern.line', label: 'Brass wall', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, life);
  numRow(p, { path: 'pattern.lifeDensity', label: 'Starting density', unit: '', min: 0.02, max: 0.9, step: 0.01, digits: 2 }, life);
  numRow(p, { path: 'pattern.lifeGens', label: 'Generations', unit: '', min: 0, max: 120, step: 1, digits: 0 }, life);
  numRow(p, { path: 'pattern.round', label: 'Roundness', unit: '', min: 0, max: 1, step: 0.01, digits: 2 }, life);

  // ---- lattice
  const lat = kindIs('lattice');
  const star: When = (st) => lat(st) && st.pattern.motif.startsWith('star');
  title(p, 'Lattice', 'Brass straps along a traditional line pattern, with everything between them cut.', lat);
  selectRow(p, 'pattern.motif', 'Motif', [
    ['asanoha', 'Asanoha (hemp leaf)'],
    ['kagome', 'Kagome (basket weave)'],
    ['star8', 'Islamic eight-point star'],
    ['star6', 'Islamic six-point star'],
    ['star4', 'Islamic four-point star'],
  ], false, lat);
  numRow(p, { path: 'pattern.scale', label: 'Tile size', unit: 'in', min: 0.8, max: 10, step: 0.05, digits: 2 }, lat);
  numRow(p, { path: 'pattern.line', label: 'Strap width', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, lat);
  numRow(p, { path: 'pattern.starAngle', label: 'Star angle', unit: 'deg', min: 50, max: 80, step: 0.5, digits: 1, hint: 'The angle the straps leave each tile edge. 67.5 is the classic eight-point star; 60 the classic six-point.' }, star);
  numRow(p, { path: 'pattern.rot', label: 'Rotation', unit: 'deg', min: -90, max: 90, step: 1, digits: 0 }, lat);

  // ---- fields
  const field = kindIs('noise', 'rd');
  const band: When = (st) => field(st) && st.pattern.fieldMode === 'band';
  title(p, 'Field', 'A smooth field is cut where it is high, or in bands that follow its outline.', field);
  selectRow(p, 'pattern.rd', 'Character', [
    ['coral', 'Coral'],
    ['labyrinth', 'Labyrinth'],
    ['fingerprint', 'Fingerprint'],
    ['spots', 'Spots'],
    ['worms', 'Worms'],
  ], false, kindIs('rd'));
  selectRow(p, 'pattern.fieldMode', 'Cut', [
    ['region', 'Shapes'],
    ['band', 'Contour bands'],
  ], false, field);
  numRow(p, { path: 'pattern.scale', label: 'Feature size', unit: 'in', min: 0.3, max: 12, step: 0.05, digits: 2 }, field);
  numRow(p, { path: 'pattern.open', label: 'Balance', unit: '', min: 0.05, max: 0.85, step: 0.01, digits: 2, hint: 'In Shapes, the share of the plate that is cut. In Contour bands, where the bands are centered.' }, field);
  numRow(p, { path: 'pattern.octaves', label: 'Detail', unit: 'layers', min: 1, max: 6, step: 1, digits: 0 }, kindIs('noise'));
  numRow(p, { path: 'pattern.warp', label: 'Warp', unit: '', min: 0, max: 2, step: 0.01, digits: 2 }, kindIs('noise'));
  numRow(p, { path: 'pattern.rot', label: 'Rotation', unit: 'deg', min: -90, max: 90, step: 1, digits: 0 }, kindIs('noise'));
  numRow(p, { path: 'pattern.line', label: 'Brass line', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, band);
  numRow(p, { path: 'pattern.gap', label: 'Cut gap', unit: 'in', min: 0.04, max: 0.75, step: 0.005, digits: 3 }, band);
  numRow(p, { path: 'pattern.phase', label: 'Band offset', unit: '', min: 0, max: 1, step: 0.01, digits: 2 }, band);
  title(p, 'Loose pieces', 'Brass enclosed by a cut would fall out. Bridge it to the plate, or cut it away.', field);
  selectRow(p, 'pattern.islands', 'Enclosed brass', [
    ['bridge', 'Add bridges'],
    ['remove', 'Cut away'],
  ], false, field);
  numRow(p, { path: 'pattern.seam', label: 'Bridge width', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 }, (st) => field(st) && st.pattern.islands === 'bridge');
}

type BlendPreset = [string, string, Partial<Settings['blend']>, Partial<Settings['pattern']>?];
const BLEND_PRESETS: BlendPreset[] = [
  ['Off', 'One pattern only.', { mode: 'off' }],
  ['Fade to coral', 'Layer A dissolves into coral from left to right.', { mode: 'crossfade', source: 'gradient', angle: 0, center: 0.5, soft: 0.6 }, { kind: 'rd', rd: 'coral', scale: 0.7, open: 0.45, fieldMode: 'region', seam: 0.16 }],
  ['Calm band', 'A solid brass band across the plate, for example behind the top tube.', { mode: 'mask', source: 'band', angle: 0, center: 0.5, width: 0.3, soft: 0, solidB: true }],
  ['Coral pools', 'Pools of coral open up inside layer A.', { mode: 'mask', source: 'noise', center: 0.55, soft: 0.1, nscale: 6, solidB: false }, { kind: 'rd', rd: 'coral', scale: 0.7, open: 0.45, fieldMode: 'region', seam: 0.16 }],
  ['Wood grain', 'Layer A bends as if following wood grain. Wider lines hold up best.', { mode: 'warp', source: 'noise', amount: 0.6, nscale: 6 }],
  ['Even glow', 'Smaller cuts in the middle, where the light is strongest, larger toward the edges. Needs line widths above the minimum to have room to work.', { mode: 'grow', source: 'radial', amount: 1, center: 0.5, soft: 1 }],
];

function buildBlendPanel() {
  const p = $('panel-blend');
  title(p, 'Blend presets', 'Combine layer A with a second pattern, or shape it with a gradient, band or noise.');
  const wrap = chips(
    p,
    BLEND_PRESETS.map(([name, , bl, pb]) => [
      name,
      () => {
        Object.assign(s.blend, bl);
        if (pb) Object.assign(s.patternB, pb);
        update();
      },
    ]),
  );
  wrap.querySelectorAll('button').forEach((b, i) => (b.title = BLEND_PRESETS[i][1]));

  const on: When = (st) => st.blend.mode !== 'off';
  const usesB: When = (st) => ['crossfade', 'union', 'intersect', 'subtract'].includes(st.blend.mode) || (st.blend.mode === 'mask' && !st.blend.solidB);
  const usesSource: When = (st) => ['crossfade', 'mask', 'warp', 'grow'].includes(st.blend.mode);
  title(p, 'Mode');
  selectRow(p, 'blend.mode', 'Blend', [
    ['off', 'Off'],
    ['crossfade', 'Crossfade A into B'],
    ['mask', 'Mask: A here, B there'],
    ['union', 'Combine: cut both'],
    ['intersect', 'Combine: cut where both cut'],
    ['subtract', 'Combine: A minus B'],
    ['warp', 'Warp A'],
    ['grow', 'Grow and shrink A'],
  ]);
  selectRow(p, 'blend.solidB', 'B side of the mask', [
    ['false', 'Layer B pattern'],
    ['true', 'Solid brass'],
  ], false, (st) => st.blend.mode === 'mask');
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'btn';
  edit.innerHTML = '<span>Edit layer B</span><small>opens the Pattern tab on layer B</small>';
  edit.addEventListener('click', () => {
    editing = 'B';
    (document.querySelector('.tabs button[data-tab="pattern"]') as HTMLButtonElement).click();
    syncControls();
  });
  p.appendChild(edit);
  conditional.push({ el: edit, when: usesB });

  title(p, 'Source', 'Decides where B shows, or how strongly the warp or growth applies.', usesSource);
  selectRow(p, 'blend.source', 'Shape', [
    ['gradient', 'Side to side'],
    ['radial', 'Center outward'],
    ['band', 'Band across'],
    ['noise', 'Noise'],
  ], false, usesSource);
  const src = (...k: string[]): When => (st) => usesSource(st) && k.includes(st.blend.source);
  numRow(p, { path: 'blend.center', label: 'Position', unit: '', min: 0, max: 1, step: 0.01, digits: 2 }, usesSource);
  numRow(p, { path: 'blend.width', label: 'Band width', unit: '', min: 0.05, max: 1, step: 0.01, digits: 2 }, src('band'));
  numRow(p, { path: 'blend.soft', label: 'Softness', unit: '', min: 0, max: 1, step: 0.01, digits: 2 }, usesSource);
  numRow(p, { path: 'blend.angle', label: 'Direction', unit: 'deg', min: -180, max: 180, step: 1, digits: 0 }, src('gradient', 'band'));
  numRow(p, { path: 'blend.nscale', label: 'Noise size', unit: 'in', min: 0.5, max: 30, step: 0.1, digits: 1 }, (st) => (usesSource(st) && st.blend.source === 'noise') || st.blend.mode === 'warp');
  numRow(p, { path: 'blend.amount', label: 'Strength', unit: '', min: 0, max: 1, step: 0.01, digits: 2 }, (st) => st.blend.mode === 'warp' || st.blend.mode === 'grow');
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = 'Blended plates are built and repaired like the field patterns: thin brass and cuts are fixed and loose pieces bridged. Check the Fabrication tab.';
  p.appendChild(note);
  conditional.push({ el: note, when: on });
}

function buildPlatePanel() {
  const p = $('panel-plate');
  title(p, 'Size', 'The plate sits inside the frame. Proportions set the height from the current width.');
  chips(p, [
    ['18 × 10 in', () => setSize(18, 10)],
    ['3:2', () => setSize(s.plate.w, s.plate.w / 1.5)],
    ['2:1', () => setSize(s.plate.w, s.plate.w / 2)],
    ['Golden', () => setSize(s.plate.w, s.plate.w / 1.618)],
    ['Square', () => setSize(s.plate.w, s.plate.w)],
  ]);
  numRow(p, { path: 'plate.w', label: 'Width', unit: 'in', min: 4, max: 48, step: 0.125, digits: 3 });
  numRow(p, { path: 'plate.h', label: 'Height', unit: 'in', min: 4, max: 36, step: 0.125, digits: 3 });
  title(p, 'Edge');
  numRow(p, { path: 'plate.border', label: 'Solid border', unit: 'in', min: 0.0625, max: 2, step: 0.0625, digits: 3 });
  numRow(p, { path: 'plate.corner', label: 'Corner radius', unit: 'in', min: 0, max: 2, step: 0.0625, digits: 3 });
  numRow(p, { path: 'plate.holeD', label: 'Mounting holes', unit: 'in', min: 0, max: 1, step: 0.0625, digits: 3, hint: 'Four corner holes centered in the border. Set to 0 for none.' });
}

function setSize(w: number, h: number) {
  s.plate.w = Math.round(w * 8) / 8;
  s.plate.h = Math.round(h * 8) / 8;
  userMovedView = false;
  update();
}

let limitsEl: HTMLElement;
function buildFabPanel() {
  const p = $('panel-fab');
  title(p, 'Material');
  selectRow(
    p,
    'material.t',
    'Brass thickness',
    THICKNESSES.map((t) => [String(t), fraction(t)]),
    true,
  );
  selectRow(p, 'material.process', 'Cutting', [
    ['waterjet', 'Waterjet'],
    ['laser', 'Fiber laser'],
  ]);
  title(p, 'Limits and checks');
  limitsEl = document.createElement('div');
  p.appendChild(limitsEl);
  const h = document.createElement('p');
  h.className = 'hint';
  h.textContent =
    'Cells, circles and Life: every cut is rounded to the cutter radius and no cut touches another, so the brass is always one piece. Noise and reaction diffusion: thin brass and thin cuts are repaired, loose pieces are bridged or cut away, and the checks below report anything left.';
  p.appendChild(h);
}

function fraction(t: number) {
  const map: Record<string, string> = { '0.0625': '1/16 in', '0.09375': '3/32 in', '0.125': '1/8 in', '0.1875': '3/16 in', '0.25': '1/4 in' };
  return map[String(t)] ?? `${t} in`;
}

function buildFilesPanel() {
  const p = $('panel-files');
  title(p, 'Cutting files', 'True scale, in inches. Each file carries its settings, so you can drop it back here to reopen the design.');
  const list1 = document.createElement('div');
  list1.className = 'btn-list';
  list1.append(
    fileBtn('Download DXF', 'for the waterjet shop', true, () => withFinal((pl) => download(baseName(s) + '.dxf', toDXF(pl, s), 'application/dxf'))),
    fileBtn('Download SVG', 'for laser, Illustrator, Fusion 360', false, () => withFinal((pl) => download(baseName(s) + '.svg', toSVG(pl, s), 'image/svg+xml'))),
  );
  p.appendChild(list1);

  title(p, 'Images');
  const list2 = document.createElement('div');
  list2.className = 'btn-list';
  list2.append(
    fileBtn('Product render', 'PNG, 2400 px, in the frame', false, () => withFinal(async (pl) => download(baseName(s) + '.png', await toPNG(pl, s, 'brass', 2400, true)))),
    fileBtn('Black and white', 'PNG, 2400 px, plate only', false, () => withFinal(async (pl) => download(baseName(s) + '-bw.png', await toPNG(pl, s, 'bw', 2400, false)))),
    fileBtn('Thumbnail', 'JPG, 1200 px', false, () => withFinal(async (pl) => download(baseName(s) + '.jpg', await toJPG(pl, s, 1200)))),
  );
  p.appendChild(list2);

  title(p, 'Settings');
  const list3 = document.createElement('div');
  list3.className = 'btn-list';
  const fileIn = document.createElement('input');
  fileIn.type = 'file';
  fileIn.accept = '.json,.svg,.dxf,.png,application/json,image/svg+xml,image/png';
  fileIn.hidden = true;
  fileIn.addEventListener('change', () => {
    if (fileIn.files?.[0]) loadFromFile(fileIn.files[0]);
    fileIn.value = '';
  });
  list3.append(
    fileBtn('Copy share link', 'opens this exact plate', false, copyLink),
    fileBtn('Download settings', 'JSON', false, () => download(baseName(s) + '.json', JSON.stringify(s, null, 2), 'application/json')),
    fileBtn('Open a file', 'JSON, SVG, DXF or PNG from this app', false, () => fileIn.click()),
    fileIn,
  );
  p.appendChild(list3);

  title(p, 'Saved designs', 'Saved in this browser only. Use files or links to share.');
  const save = fileBtn('Save this design', '', false, () => {
    saveDesign(s);
    renderSaved();
    toast('Design saved');
  });
  p.appendChild(save);
  savedEl = document.createElement('ul');
  savedEl.className = 'saved';
  p.appendChild(savedEl);
  renderSaved();
}

let savedEl: HTMLUListElement;
function renderSaved() {
  const items = listSaved();
  savedEl.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No saved designs yet.';
    savedEl.appendChild(li);
    return;
  }
  for (const d of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = d.name;
    const when = document.createElement('small');
    when.textContent = new Date(d.savedAt).toLocaleDateString();
    const open = document.createElement('button');
    open.textContent = 'Open';
    open.addEventListener('click', () => {
      s = sanitize(d.settings).s;
      userMovedView = false;
      update();
      toast(`Opened ${d.name}`);
    });
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      deleteSaved(d.id);
      renderSaved();
    });
    li.append(name, when, open, del);
    savedEl.appendChild(li);
  }
}

function fileBtn(label: string, sub: string, primary: boolean, fn: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn' + (primary ? ' primary' : '');
  b.innerHTML = `<span></span><small></small>`;
  b.querySelector('span')!.textContent = label;
  b.querySelector('small')!.textContent = sub;
  b.addEventListener('click', fn);
  return b;
}

// ---------------------------------------------------------------- plaque, tabs, view tools

function wireChrome() {
  const name = $<HTMLInputElement>('nameInput');
  name.addEventListener('input', () => {
    s.name = name.value;
    persistSoon();
  });
  const ed = $<HTMLInputElement>('editionInput');
  ed.addEventListener('change', () => {
    s.edition = parseInt(ed.value, 10) || 1;
    update();
  });
  const seed = $<HTMLInputElement>('seedInput');
  seed.addEventListener('change', () => {
    s.seed = parseInt(seed.value, 10) || 0;
    update();
  });
  $('seedPrev').addEventListener('click', () => {
    s.seed = Math.max(0, s.seed - 1);
    update();
  });
  $('seedNext').addEventListener('click', () => {
    s.seed += 1;
    update();
  });
  $('seedRandom').addEventListener('click', () => {
    s.seed = Math.floor(Math.random() * 1000000);
    update();
  });

  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      document.querySelectorAll<HTMLElement>('.tabpanel').forEach((pnl) => (pnl.hidden = pnl.dataset.panel !== b.dataset.tab));
    }),
  );

  document.querySelectorAll<HTMLButtonElement>('.stage-tools .seg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as ViewMode;
      document.querySelectorAll<HTMLButtonElement>('.stage-tools .seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (!userMovedView) fit();
      draw();
    }),
  );
  const frame = $<HTMLInputElement>('frameToggle');
  frame.addEventListener('change', () => {
    showFrame = frame.checked;
    if (!userMovedView) fit();
    draw();
  });
  $('fitBtn').addEventListener('click', () => {
    userMovedView = false;
    fit();
    draw();
  });
  $('actualBtn').addEventListener('click', () => {
    const r = canvas.getBoundingClientRect();
    view = { scale: 96, ox: r.width / 2 - (plate.w * 96) / 2, oy: r.height / 2 - (plate.h * 96) / 2 };
    userMovedView = true;
    draw();
  });

  $('exploreBtn').addEventListener('click', () => openExplore());
  $('exploreMore').addEventListener('click', () => {
    exploreRound++;
    fillExplore();
  });
  $('exploreClose').addEventListener('click', closeExplore);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('exploreOverlay').hidden) closeExplore();
  });

  // Drag a file anywhere to load it.
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) $('dropHint').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    $('dropHint').hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFromFile(f);
  });

  window.addEventListener('hashchange', () => {
    const h = decodeHash(location.hash);
    if (h && location.hash.slice(1) !== lastHash) {
      s = sanitize(h).s;
      userMovedView = false;
      update();
    }
  });
}

async function loadFromFile(f: File) {
  try {
    const raw = await settingsFromFile(f);
    if (!raw) {
      toast(`No plate settings found in ${f.name}`);
      return;
    }
    const r = sanitize(raw);
    s = r.s;
    userMovedView = false;
    update();
    toast(`Opened ${f.name}`);
  } catch {
    toast(`Could not read ${f.name}`);
  }
}

async function copyLink() {
  const url = location.href.split('#')[0] + '#' + encodeHash(s);
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  } catch {
    history.replaceState(null, '', url);
    toast('Link is in the address bar');
  }
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2200);
}

// ---------------------------------------------------------------- explore

let exploreRound = 0;
let exploreToken = 0;
function openExplore() {
  $('exploreOverlay').hidden = false;
  fillExplore();
}
function closeExplore() {
  $('exploreOverlay').hidden = true;
  exploreToken++;
}
async function fillExplore() {
  const token = ++exploreToken;
  const grid = $('exploreGrid');
  grid.innerHTML = '';
  const base = clone(s);
  if (base.pattern.kind === 'cells' && base.pattern.rule !== 'random') base.pattern.rule = 'random';
  const tiles: { seed: number; img: HTMLImageElement; lab: HTMLSpanElement }[] = [];
  for (let i = 0; i < 9; i++) {
    const seed = Math.floor(hash01(s.seed, exploreRound, i) * 1000000);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Use seed ${seed}`);
    const img = document.createElement('img');
    img.alt = '';
    const lab = document.createElement('span');
    lab.textContent = `Seed ${seed}`;
    b.append(img, lab);
    b.addEventListener('click', () => {
      s.seed = seed;
      if (s.pattern.kind === 'cells') s.pattern.rule = 'random';
      closeExplore();
      update();
    });
    grid.appendChild(b);
    tiles.push({ seed, img, lab });
  }
  for (const t of tiles) {
    const v = clone(base);
    v.seed = t.seed;
    if (isFieldKind(v)) t.lab.textContent = `Seed ${t.seed}, growing`;
    const pl = isFieldKind(v) ? await buildField(v, 'draft') : buildPlate(v);
    if (token !== exploreToken) return;
    if (!pl) continue;
    t.img.src = renderToCanvas(pl, 640, 'brass', v.material.t, '#1c1916', false).toDataURL('image/png');
    t.lab.textContent = `Seed ${t.seed}`;
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------- background builds

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let reqSeq = 0;
const waiting = new Map<number, (p: Plate | null) => void>();
let statusFor = -1;
worker.onmessage = (e: MessageEvent) => {
  const { id, plate: pl, progress, error } = e.data;
  if (progress) {
    if (id === statusFor) setStatus(progress);
    return;
  }
  const cb = waiting.get(id);
  waiting.delete(id);
  if (error) console.error(error);
  cb?.(pl ?? null);
};

function buildField(st: Settings, quality: 'draft' | 'final'): Promise<Plate | null> {
  const id = ++reqSeq;
  return new Promise((res) => {
    waiting.set(id, res);
    worker.postMessage({ id, settings: st, quality });
  });
}

function setStatus(msg: string | null) {
  const el = $('status');
  el.hidden = !msg;
  if (msg) el.textContent = msg;
}

// The live preview: one build at a time, always for the newest settings.
// A quick draft comes first; a refined build follows once the sliders rest.
let busy = false;
let wanted: 'draft' | 'final' | null = null;
let finalTimer = 0;
let plateKey = '';
const keyOf = (st: Settings) => JSON.stringify({ ...st, name: '', edition: 0 });

function requestField() {
  wanted = 'draft';
  clearTimeout(finalTimer);
  pump();
}

async function pump() {
  if (busy || !wanted) return;
  const quality = wanted;
  wanted = null;
  busy = true;
  const st = clone(s);
  const key = keyOf(st);
  const id = reqSeq + 1;
  statusFor = id;
  setStatus(quality === 'draft' ? 'Building preview' : 'Refining for cutting');
  const pl = await buildField(st, quality);
  busy = false;
  if (pl && key === keyOf(s)) {
    plate = pl;
    plateKey = key;
    if (!userMovedView) fit();
    draw();
    renderReadouts();
  }
  if (wanted) return pump();
  setStatus(null);
  if (pl && pl.quality === 'draft' && key === keyOf(s)) {
    finalTimer = window.setTimeout(() => {
      wanted = 'final';
      pump();
    }, 450);
  }
}

/** Run an export with geometry refined for cutting. */
async function withFinal(fn: (pl: Plate) => void | Promise<void>) {
  if (!isFieldKind(s) || (plate.quality === 'final' && plateKey === keyOf(s))) return fn(plate);
  toast('Refining the plate for cutting');
  clearTimeout(finalTimer);
  const pl = await buildField(clone(s), 'final');
  if (!pl) return toast('Could not build the plate');
  return fn(pl);
}


// ---------------------------------------------------------------- update + draw

function update() {
  const r = sanitize(s);
  s = r.s;
  if (s.blend.mode === 'off') editing = 'A';
  notes = r.notes;
  syncControls();
  if (isFieldKind(s)) {
    if (!plate) plate = finishPlate(s, [], [], { dropped: 0, quality: 'draft' });
    requestField();
  } else {
    clearTimeout(finalTimer);
    wanted = null;
    setStatus(null);
    plate = buildPlate(s);
    plateKey = keyOf(s);
  }
  if (!userMovedView) fit();
  draw();
  renderReadouts();
  persistSoon();
}

function syncControls() {
  const lim = fabLimits(s);
  const mins: Record<string, number> = {
    'pattern.line': lim.minWeb,
    'pattern.seam': lim.minWeb,
    'pattern.gap': lim.minCut,
    'plate.border': lim.minWeb,
    'pattern.cMin': lim.minCut,
    'pattern.cMax': lim.minCut,
  };
  for (const el of numEls) {
    if (mins[el.path] !== undefined) el.range.min = String(mins[el.path]);
    if (el.path === 'plate.holeD') el.range.max = String(Math.max(0, s.plate.border - 2 * lim.minWeb));
    const vv = get(el.path) as number;
    el.range.value = String(vv);
    if (document.activeElement !== el.num) el.num.value = vv.toFixed(el.ctl.digits);
  }
  for (const { path, sel } of selEls) sel.value = String(get(path));
  const vs = viewOf(s);
  for (const c of conditional) c.el.hidden = !c.when(vs);
  document.querySelectorAll<HTMLButtonElement>('.layer-switch button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.layer === editing)),
  );
  const name = $<HTMLInputElement>('nameInput');
  if (document.activeElement !== name) name.value = s.name;
  const ed = $<HTMLInputElement>('editionInput');
  if (document.activeElement !== ed) ed.value = String(s.edition);
  const seed = $<HTMLInputElement>('seedInput');
  if (document.activeElement !== seed) seed.value = String(s.seed);
}

function renderReadouts() {
  const st = plate.stats;
  const el = $('readouts');
  const parts = [
    ['Open area', `${(st.openArea * 100).toFixed(1)}%`],
    ['Cut length', `${Math.round(st.cutLength).toLocaleString()} in`],
    ['Pierces', String(st.pierces)],
  ];
  if (st.bridges) parts.push(['Bridges', String(st.bridges)]);
  el.innerHTML = parts.map(([k, vv]) => `<span>${k} <b>${vv}</b></span>`).join('');
  if (isFieldKind(s) && plate.quality === 'draft') {
    const d = document.createElement('span');
    d.textContent = 'Preview; refining for cutting';
    el.appendChild(d);
  }
  const problems: string[] = [...notes];
  if (st.islands) problems.push(`${st.islands} loose brass piece${st.islands > 1 ? 's' : ''} remain.`);
  if (st.thinSpots) problems.push(`${st.thinSpots} spot${st.thinSpots > 1 ? 's are' : ' is'} still under the minimum width.`);
  if (st.pierces <= plate.holes.length + 0 && plate.quality === 'final') problems.push('No pattern cuts at these settings.');
  if (problems.length) {
    const n = document.createElement('span');
    n.className = 'notes';
    n.textContent = problems.join(' ');
    el.appendChild(n);
  }

  const lim = plate.limits;
  const f3 = (x: number) => `${x.toFixed(3)} in`;
  const rows: [string, string][] = [
    ['Narrowest brass allowed', f3(lim.minWeb)],
    ['Narrowest cut allowed', f3(lim.minCut)],
    ['Inside corner radius', f3(lim.cornerR)],
    ['Typical kerf', f3(lim.kerf)],
    ['Open area', `${(st.openArea * 100).toFixed(1)}%`],
    ['Cut length', `${st.cutLength.toFixed(1)} in`],
    ['Pierces', String(st.pierces)],
    ['Bridges added', String(st.bridges)],
    ['Loose pieces', String(st.islands)],
    ['Spots under minimum', String(st.thinSpots)],
    ['Stubs removed', String(st.dropped)],
  ];
  limitsEl.innerHTML = `<table class="limits"><tbody>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table>`;
}

let persistTimer = 0;
let lastHash = '';
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    autosave(s);
    lastHash = encodeHash(s);
    history.replaceState(null, '', '#' + lastHash);
  }, 350);
}


function canvasSize() {
  const r = canvas.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function fit() {
  const { w, h } = canvasSize();
  const pad = mode === 'brass' && showFrame ? FRAME_RAIL + FRAME_REVEAL + 0.3 : 0.4;
  const v = fitView(plate.w + 2 * pad, plate.h + 2 * pad, w, h, w < 500 ? 8 : 24);
  view = { scale: v.scale, ox: v.ox + pad * v.scale, oy: v.oy + pad * v.scale };
}

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const { w, h } = canvasSize();
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (mode !== 'brass') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    drawPlate(ctx, plate, view, {
      mode,
      thickness: s.material.t,
      frame: mode === 'brass' && showFrame,
      showDims: mode !== 'brass',
    });
  });
}

// ---------------------------------------------------------------- pan and zoom

function wirePanZoom() {
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; mx: number; my: number } | null = null;
  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const zoomAt = (x: number, y: number, k: number) => {
    const ns = Math.min(800, Math.max(4, view.scale * k));
    const kk = ns / view.scale;
    view = { scale: ns, ox: x - (x - view.ox) * kk, oy: y - (y - view.oy) * kk };
    userMovedView = true;
    draw();
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    const prev = pts.get(e.pointerId)!;
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      view = { ...view, ox: view.ox + p.x - prev.x, oy: view.oy + p.y - prev.y };
      userMovedView = true;
      draw();
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (pinch) {
        view = { ...view, ox: view.ox + mx - pinch.mx, oy: view.oy + my - pinch.my };
        zoomAt(mx, my, d / pinch.d);
      }
      pinch = { d, mx, my };
    }
  });
  const end = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
  canvas.addEventListener('dblclick', () => {
    userMovedView = false;
    fit();
    draw();
  });
  new ResizeObserver(() => {
    if (!userMovedView) fit();
    draw();
  }).observe(canvas);
}

// ---------------------------------------------------------------- boot

s = initialSettings();
buildPatternPanel();
buildBlendPanel();
buildPlatePanel();
buildFabPanel();
buildFilesPanel();
wireChrome();
wirePanZoom();
update();
