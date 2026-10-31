import './style.css';
import { buildPlate, Plate } from './plate';
import { drawPlate, fitView, renderToCanvas, View, ViewMode, FRAME_RAIL, FRAME_REVEAL } from './render';
import { DEFAULTS, Settings, THICKNESSES, clone, fabLimits, sanitize } from './settings';
import { autosave, decodeHash, deleteSaved, encodeHash, listSaved, loadAutosave, saveDesign } from './store';
import { baseName, download, settingsFromFile, toDXF, toJPG, toPNG, toSVG } from './export';
import { hash01 } from './rng';

// ---------------------------------------------------------------- state

let s: Settings;
let notes: string[] = [];
let plate: Plate;
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

const get = (path: Path): any => path.split('.').reduce((o: any, k) => o[k], s);
function set(path: Path, val: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const o = keys.reduce((acc: any, k) => acc[k], s);
  o[last] = val;
}

const numCtls: NumCtl[] = [];
const numEls = new Map<Path, { range: HTMLInputElement; num: HTMLInputElement; ctl: NumCtl }>();

function numRow(parent: HTMLElement, c: NumCtl) {
  numCtls.push(c);
  const row = document.createElement('div');
  row.className = 'row';
  const id = 'c-' + c.path.replace(/\./g, '-');
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
  parent.appendChild(row);
  if (c.hint) {
    const h = document.createElement('p');
    h.className = 'hint';
    h.textContent = c.hint;
    parent.appendChild(h);
  }
  numEls.set(c.path, { range, num, ctl: c });
}

const selEls = new Map<Path, HTMLSelectElement>();
function selectRow(parent: HTMLElement, path: Path, label: string, options: [string, string][], numeric = false) {
  const row = document.createElement('div');
  row.className = 'select-row';
  const id = 'c-' + path.replace(/\./g, '-');
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
    update();
  });
  row.appendChild(sel);
  parent.appendChild(row);
  selEls.set(path, sel);
  return row;
}

function title(parent: HTMLElement, text: string, hint?: string) {
  const h = document.createElement('h3');
  h.className = 'group-title';
  h.textContent = text;
  parent.appendChild(h);
  if (hint) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = hint;
    parent.appendChild(p);
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

const PRESETS: [string, Partial<Settings['pattern']>][] = [
  ['Tumbling hatch', { layout: 'tumbling', scale: 3.4, rot: 0, line: 0.14, gap: 0.22, seam: 0.14, rule: 'random', variation: 0.5, phase: 0 }],
  ['Basketweave', { layout: 'parquet', scale: 2, rot: 0, line: 0.14, gap: 0.2, seam: 0.2, rule: 'alternate', phase: 0 }],
  ['Diagonal weave', { layout: 'parquet', scale: 2.4, rot: 45, line: 0.14, gap: 0.2, seam: 0.16, rule: 'alternate', phase: 0 }],
  ['Triangle facets', { layout: 'triangles', scale: 3, rot: 0, line: 0.14, gap: 0.2, seam: 0.14, rule: 'random', variation: 0.67, phase: 0 }],
  ['Large blocks', { layout: 'tumbling', scale: 5.5, rot: 90, line: 0.14, gap: 0.26, seam: 0.18, rule: 'alternate', phase: 0.5 }],
  ['Single field', { layout: 'single', rot: 30, line: 0.14, gap: 0.22, rule: 'first', phase: 0 }],
];

let ruleRow: HTMLElement;
let variationRow: HTMLElement[] = [];

function buildPatternPanel() {
  const p = $('panel-pattern');
  title(p, 'Presets');
  chips(
    p,
    PRESETS.map(([name, pat]) => [
      name,
      () => {
        Object.assign(s.pattern, pat);
        s.name = name;
        update();
      },
    ]),
  );

  title(p, 'Layout', 'How the plate is divided into cells. Each cell is hatched in one direction.');
  selectRow(p, 'pattern.layout', 'Cells', [
    ['tumbling', 'Tumbling blocks'],
    ['parquet', 'Squares'],
    ['triangles', 'Triangles'],
    ['single', 'One field'],
  ]);
  ruleRow = selectRow(p, 'pattern.rule', 'Hatch direction', [
    ['random', 'Random by seed'],
    ['alternate', 'Alternating'],
    ['first', 'All the same'],
    ['second', 'All the same, turned'],
  ]);
  const before = p.childElementCount;
  numRow(p, { path: 'pattern.variation', label: 'Direction mix', unit: '', min: 0, max: 1, step: 0.01, digits: 2, hint: 'Share of cells hatched the second way. Only used by Random by seed.' });
  variationRow = Array.from(p.children).slice(before) as HTMLElement[];
  numRow(p, { path: 'pattern.scale', label: 'Cell size', unit: 'in', min: 0.75, max: 12, step: 0.05, digits: 2 });
  numRow(p, { path: 'pattern.rot', label: 'Rotation', unit: 'deg', min: -90, max: 90, step: 1, digits: 0 });

  title(p, 'Lines', 'Brass line and cut widths set the rhythm. Fabrication sets the minimums.');
  numRow(p, { path: 'pattern.line', label: 'Brass line', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 });
  numRow(p, { path: 'pattern.gap', label: 'Cut gap', unit: 'in', min: 0.04, max: 0.75, step: 0.005, digits: 3 });
  numRow(p, { path: 'pattern.seam', label: 'Seam between cells', unit: 'in', min: 0.0625, max: 0.75, step: 0.005, digits: 3 });
  numRow(p, { path: 'pattern.phase', label: 'Line offset', unit: '', min: 0, max: 1, step: 0.01, digits: 2, hint: 'Slides the lines within each cell.' });
  numRow(p, { path: 'pattern.minSlot', label: 'Drop slots shorter than', unit: 'in', min: 0, max: 2, step: 0.05, digits: 2, hint: 'Removes stubs where lines meet a corner. Raise it for a cleaner look.' });
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
    'Every slot is rounded to the cutter radius, and no slot touches another or the border, so the brass is always one connected piece. Exported files are cut-ready at these settings.';
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
    fileBtn('Download DXF', 'for the waterjet shop', true, () => download(baseName(s) + '.dxf', toDXF(plate, s), 'application/dxf')),
    fileBtn('Download SVG', 'for laser, Illustrator, Fusion 360', false, () => download(baseName(s) + '.svg', toSVG(plate, s), 'image/svg+xml')),
  );
  p.appendChild(list1);

  title(p, 'Images');
  const list2 = document.createElement('div');
  list2.className = 'btn-list';
  list2.append(
    fileBtn('Product render', 'PNG, 2400 px, in the frame', false, async () => download(baseName(s) + '.png', await toPNG(plate, s, 'brass', 2400, true))),
    fileBtn('Black and white', 'PNG, 2400 px, plate only', false, async () => download(baseName(s) + '-bw.png', await toPNG(plate, s, 'bw', 2400, false))),
    fileBtn('Thumbnail', 'JPG, 1200 px', false, async () => download(baseName(s) + '.jpg', await toJPG(plate, s, 1200))),
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

  document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as ViewMode;
      document.querySelectorAll<HTMLButtonElement>('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
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
let exploreSeeds: number[] = [];
function openExplore() {
  $('exploreOverlay').hidden = false;
  fillExplore();
}
function closeExplore() {
  $('exploreOverlay').hidden = true;
}
function fillExplore() {
  const grid = $('exploreGrid');
  grid.innerHTML = '';
  exploreSeeds = [];
  const base = clone(s);
  if (base.pattern.rule !== 'random') base.pattern.rule = 'random';
  for (let i = 0; i < 9; i++) {
    const seed = Math.floor(hash01(s.seed, exploreRound, i) * 1000000);
    exploreSeeds.push(seed);
    const v = clone(base);
    v.seed = seed;
    const pl = buildPlate(v);
    const c = renderToCanvas(pl, 640, 'brass', v.material.t, '#1c1916', false);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Use seed ${seed}`);
    const img = document.createElement('img');
    img.alt = '';
    img.src = c.toDataURL('image/png');
    const lab = document.createElement('span');
    lab.textContent = `Seed ${seed}`;
    b.append(img, lab);
    b.addEventListener('click', () => {
      s.seed = seed;
      s.pattern.rule = 'random';
      closeExplore();
      update();
    });
    grid.appendChild(b);
  }
}

// ---------------------------------------------------------------- update + draw

function update() {
  const r = sanitize(s);
  s = r.s;
  notes = r.notes;
  plate = buildPlate(s);
  syncControls();
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
  };
  for (const [path, el] of numEls) {
    if (mins[path] !== undefined) el.range.min = String(mins[path]);
    if (path === 'plate.holeD') el.range.max = String(Math.max(0, s.plate.border - 2 * lim.minWeb));
    const vv = get(path) as number;
    el.range.value = String(vv);
    if (document.activeElement !== el.num) el.num.value = vv.toFixed(el.ctl.digits);
  }
  for (const [path, sel] of selEls) sel.value = String(get(path));
  const isRandom = s.pattern.rule === 'random';
  variationRow.forEach((e) => (e.hidden = !isRandom || s.pattern.layout === 'single'));
  ruleRow.hidden = s.pattern.layout === 'single';
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
    ['Slots', String(st.slots)],
  ];
  el.innerHTML = parts.map(([k, vv]) => `<span>${k} <b>${vv}</b></span>`).join('');
  if (notes.length) {
    const n = document.createElement('span');
    n.className = 'notes';
    n.textContent = notes.join(' ');
    el.appendChild(n);
  }

  const lim = plate.limits;
  const f3 = (x: number) => `${x.toFixed(3)} in`;
  const rows: [string, string][] = [
    ['Narrowest brass allowed', f3(lim.minWeb)],
    ['Narrowest cut allowed', f3(lim.minCut)],
    ['Inside corner radius', f3(lim.cornerR)],
    ['Typical kerf', f3(lim.kerf)],
    ['Brass line / seam', `${s.pattern.line.toFixed(3)} / ${s.pattern.seam.toFixed(3)} in`],
    ['Cut gap', f3(s.pattern.gap)],
    ['Open area', `${(st.openArea * 100).toFixed(1)}%`],
    ['Cut length', `${st.cutLength.toFixed(1)} in`],
    ['Pierces', String(st.pierces)],
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
buildPlatePanel();
buildFabPanel();
buildFilesPanel();
wireChrome();
wirePanZoom();
update();
