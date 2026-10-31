// PDF output, written by hand so the app needs no PDF library:
// - a 1:1 vector shop drawing with a title block and a scale bar,
// - a one-page edition certificate with the product render.
// Uses the standard PDF base fonts (no embedding) and Flate compression
// where the browser supports it.

import { RoundPoly, V, rpSegments } from './geom';
import type { Plate } from './plate';
import type { Settings } from './settings';

// ---------------------------------------------------------------- writer

const enc = new TextEncoder();

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class PdfDoc {
  private objs: Uint8Array[] = [];
  add(body: string | Uint8Array): number {
    this.objs.push(typeof body === 'string' ? enc.encode(body) : body);
    return this.objs.length;
  }
  set(id: number, body: string) {
    this.objs[id - 1] = enc.encode(body);
  }
  reserve(): number {
    this.objs.push(new Uint8Array());
    return this.objs.length;
  }
  async stream(dict: string, data: Uint8Array, compress = true): Promise<number> {
    const z = compress ? await deflate(data) : null;
    const bytes = z ?? data;
    const head = enc.encode(`<< ${dict} /Length ${bytes.length}${z ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
    const tail = enc.encode('\nendstream');
    const out = new Uint8Array(head.length + bytes.length + tail.length);
    out.set(head, 0);
    out.set(bytes, head.length);
    out.set(tail, head.length + bytes.length);
    return this.add(out);
  }
  build(rootId: number, info: Record<string, string>): Blob {
    const chunks: Uint8Array[] = [];
    let pos = 0;
    const push = (b: Uint8Array | string) => {
      const u = typeof b === 'string' ? enc.encode(b) : b;
      chunks.push(u);
      pos += u.length;
    };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const infoId = this.add(
      '<< ' + Object.entries(info).map(([k, v]) => `/${k} ${str(v)}`).join(' ') + ' >>',
    );
    const offsets: number[] = [];
    this.objs.forEach((body, i) => {
      offsets.push(pos);
      push(`${i + 1} 0 obj\n`);
      push(body);
      push('\nendobj\n');
    });
    const xref = pos;
    push(`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`);
    for (const o of offsets) push(`${String(o).padStart(10, '0')} 00000 n \n`);
    push(`trailer\n<< /Size ${this.objs.length + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
  }
}

/** PDF literal string, limited to printable ASCII. */
function str(t: string): string {
  const clean = t
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/°/g, ' deg')
    .replace(/[^\x20-\x7E]/g, '');
  return '(' + clean.replace(/[\\()]/g, (c) => '\\' + c) + ')';
}

const n = (x: number) => (Math.round(x * 1000) / 1000).toString();

const FONTS = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Times-Roman',
  F4: 'Times-Italic',
};

async function fontResources(doc: PdfDoc): Promise<string> {
  const parts = Object.entries(FONTS).map(([k, base]) => {
    const id = doc.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
    return `/${k} ${id} 0 R`;
  });
  return `/Font << ${parts.join(' ')} >>`;
}

// ---------------------------------------------------------------- content helpers

class Content {
  out: string[] = [];
  op(s: string) {
    this.out.push(s);
  }
  text(x: number, y: number, size: number, font: keyof typeof FONTS, t: string, gray = 0) {
    this.out.push(`BT /${font} ${n(size)} Tf ${n(gray)} g ${n(x)} ${n(y)} Td ${str(t)} Tj ET`);
  }
  bytes() {
    return enc.encode(this.out.join('\n'));
  }
}

/** Append a RoundPoly outline as PDF path operators (arcs as cubic Beziers). */
function roundPolyPath(c: Content, rp: RoundPoly, T: (p: V) => V) {
  const segs = rpSegments(rp);
  let first = true;
  const moveOrLine = (p: V) => {
    const q = T(p);
    c.op(`${n(q.x)} ${n(q.y)} ${first ? 'm' : 'l'}`);
    first = false;
  };
  for (const sg of segs) {
    if (sg.k === 'L') {
      if (first) moveOrLine(sg.a);
      moveOrLine(sg.b);
      continue;
    }
    const steps = Math.max(1, Math.ceil((sg.a1 - sg.a0) / (Math.PI / 2)));
    const d = (sg.a1 - sg.a0) / steps;
    const k = (4 / 3) * Math.tan(d / 4);
    for (let i = 0; i < steps; i++) {
      const a = sg.a0 + i * d,
        b = a + d;
      const p0 = { x: sg.c.x + sg.r * Math.cos(a), y: sg.c.y + sg.r * Math.sin(a) };
      const p3 = { x: sg.c.x + sg.r * Math.cos(b), y: sg.c.y + sg.r * Math.sin(b) };
      const p1 = { x: p0.x - k * sg.r * Math.sin(a), y: p0.y + k * sg.r * Math.cos(a) };
      const p2 = { x: p3.x + k * sg.r * Math.sin(b), y: p3.y - k * sg.r * Math.cos(b) };
      if (first) moveOrLine(p0);
      const [q1, q2, q3] = [T(p1), T(p2), T(p3)];
      c.op(`${n(q1.x)} ${n(q1.y)} ${n(q2.x)} ${n(q2.y)} ${n(q3.x)} ${n(q3.y)} c`);
    }
  }
  c.op('h');
}

function polyPath(c: Content, pts: V[], T: (p: V) => V) {
  pts.forEach((p, i) => {
    const q = T(p);
    c.op(`${n(q.x)} ${n(q.y)} ${i ? 'l' : 'm'}`);
  });
  c.op('h');
}

// ---------------------------------------------------------------- descriptions

const LAYOUTS: Record<string, string> = {
  tumbling: 'Tumbling blocks',
  parquet: 'Squares',
  triangles: 'Triangles',
  voronoi: 'Voronoi',
  single: 'One field',
};
const FILLS: Record<string, string> = { hatch: 'parallel lines', concentric: 'concentric bands', open: 'open cells' };
const MOTIFS: Record<string, string> = {
  asanoha: 'Asanoha (kumiko hemp leaf)',
  kagome: 'Kagome (kumiko basket weave)',
  star8: 'Islamic eight-point star',
  star6: 'Islamic six-point star',
  star4: 'Islamic four-point star',
};
const BLENDS: Record<string, string> = {
  crossfade: 'crossfaded into',
  mask: 'masked with',
  union: 'combined with',
  intersect: 'intersected with',
  subtract: 'minus',
  warp: 'warped',
  grow: 'graded',
};

function layerLabel(p: Settings['pattern']): string {
  switch (p.kind) {
    case 'cells':
      return `${LAYOUTS[p.layout]}, ${FILLS[p.fill]}`;
    case 'lattice':
      return MOTIFS[p.motif];
    case 'circles':
      return 'Circle packing';
    case 'life':
      return `Game of Life, ${p.lifeGens} generations`;
    case 'noise':
      return p.fieldMode === 'band' ? 'Noise field, contour bands' : 'Noise field';
    default:
      return `Reaction diffusion, ${p.rd}${p.fieldMode === 'band' ? ', contour bands' : ''}`;
  }
}

export function patternLabel(s: Settings): string {
  const a = layerLabel(s.pattern);
  const b = s.blend;
  if (b.mode === 'off') return a;
  if (b.mode === 'warp' || b.mode === 'grow') return `${a}, ${BLENDS[b.mode]}`;
  if (b.mode === 'mask' && b.solidB) return `${a}, with a solid brass zone`;
  return `${a}, ${BLENDS[b.mode]} ${layerLabel(s.patternB).toLowerCase()}`;
}

/** Short code identifying the geometry: same code, same plate. */
export function designCode(s: Settings): string {
  const json = JSON.stringify({ ...s, name: '', maker: '', edition: 0 });
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < json.length; i++) {
      h ^= json.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).toUpperCase().padStart(8, '0');
  };
  const a = fnv(2166136261),
    b = fnv(0x9e3779b9);
  return `${a.slice(0, 4)}-${a.slice(4)}-${b.slice(0, 4)}`;
}

const fraction = (t: number) =>
  ({ 0.0625: '1/16', 0.09375: '3/32', 0.125: '1/8', 0.1875: '3/16', 0.25: '1/4' })[t] ?? String(t);

const today = () =>
  new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

// ---------------------------------------------------------------- shop drawing

/** True-scale vector drawing of the plate with a title block. */
export async function shopDrawingPDF(plate: Plate, s: Settings): Promise<Blob> {
  const IN = 72;
  const margin = 0.75;
  const block = 2.15;
  const pageW = Math.max(plate.w + 2 * margin, 11) * IN;
  const pageH = (plate.h + 2 * margin + block) * IN;
  const ox = (pageW / IN - plate.w) / 2;
  const top = margin;
  const T = (p: V): V => ({ x: (p.x + ox) * IN, y: pageH - (p.y + top) * IN });

  const c = new Content();
  // Cut lines: outline in blue, interior cuts in red, hairline.
  c.op('0.35 w 1 J 1 j');
  c.op('0 0 0.8 RG');
  roundPolyPath(c, plate.outline, T);
  c.op('S');
  c.op('0.8 0 0 RG');
  for (const rp of plate.holes) roundPolyPath(c, rp, T);
  for (const rp of plate.slots) roundPolyPath(c, rp, T);
  for (const pth of plate.paths) polyPath(c, pth, T);
  c.op('S');

  // Dimensions.
  const yDim = pageH - (top + plate.h + 0.3) * IN;
  const x0 = ox * IN,
    x1 = (ox + plate.w) * IN;
  c.op('0 G 0.5 w');
  c.op(`${n(x0)} ${n(yDim)} m ${n(x1)} ${n(yDim)} l S`);
  c.op(`${n(x0)} ${n(yDim - 4)} m ${n(x0)} ${n(yDim + 4)} l S ${n(x1)} ${n(yDim - 4)} m ${n(x1)} ${n(yDim + 4)} l S`);
  c.text((x0 + x1) / 2 - 22, yDim + 4, 8, 'F1', `${plate.w.toFixed(3)} in`);
  const xDim = x0 - 0.3 * IN;
  const yA = pageH - top * IN,
    yB = pageH - (top + plate.h) * IN;
  c.op(`${n(xDim)} ${n(yA)} m ${n(xDim)} ${n(yB)} l S`);
  c.op(`BT /F1 8 Tf 0 g 0 1 -1 0 ${n(xDim - 4)} ${n((yA + yB) / 2 - 22)} Tm ${str(`${plate.h.toFixed(3)} in`)} Tj ET`);

  // Title block.
  const bx = margin * IN,
    by = margin * IN * 0.5,
    bw = pageW - 2 * margin * IN,
    bh = (block - 0.6) * IN;
  c.op(`0 G 0.75 w ${n(bx)} ${n(by)} ${n(bw)} ${n(bh)} re S`);
  const st = plate.stats;
  const lim = plate.limits;
  c.text(bx + 12, by + bh - 24, 15, 'F2', s.name || 'BikeBlock plate');
  c.text(bx + 12, by + bh - 40, 10, 'F1', `Plate No. ${String(s.edition).padStart(4, '0')}   ${patternLabel(s)}`, 0.25);
  const rows: [string, string][] = [
    ['Size', `${plate.w.toFixed(3)} x ${plate.h.toFixed(3)} in`],
    ['Material', `${fraction(s.material.t)} in brass`],
    ['Process', s.material.process === 'waterjet' ? 'Waterjet' : 'Fiber laser'],
    ['Min brass / cut', `${lim.minWeb.toFixed(3)} / ${lim.minCut.toFixed(3)} in`],
    ['Cut length', `${st.cutLength.toFixed(1)} in`],
    ['Pierces', String(st.pierces)],
    ['Open area', `${(st.openArea * 100).toFixed(1)}%`],
    ['Seed', String(s.seed)],
    ['Design code', designCode(s)],
    ['Date', today()],
  ];
  const colW = Math.min(150, (bw - 24) / 5);
  rows.forEach(([k, v], i) => {
    const col = i % 5,
      row = Math.floor(i / 5);
    const x = bx + 12 + col * colW,
      y = by + bh - 64 - row * 26;
    c.text(x, y + 9, 6.5, 'F1', k, 0.4);
    c.text(x, y, 8.5, 'F1', v);
  });
  c.text(bx + 12, by + 8, 7, 'F1', 'Scale 1:1, units inches. Blue: outline. Red: interior cuts. Confirm the scale bar measures 1 in before using a print.', 0.35);
  // 1 inch scale bar.
  const sx = bx + bw - 12 - IN,
    sy = by + 12;
  c.op(`0 g ${n(sx)} ${n(sy)} ${n(IN / 2)} 4 re f`);
  c.op(`0 G 0.5 w ${n(sx)} ${n(sy)} ${n(IN)} 4 re S`);
  c.text(sx, sy + 8, 7, 'F1', '1 in scale bar');

  const doc = new PdfDoc();
  const pagesId = doc.reserve();
  const fonts = await fontResources(doc);
  const contentId = await doc.stream('', c.bytes());
  const pageId = doc.add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] /Resources << ${fonts} >> /Contents ${contentId} 0 R >>`,
  );
  doc.set(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const root = doc.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return doc.build(root, {
    Title: `${s.name} No. ${s.edition}`,
    Subject: 'Brass backplate shop drawing, 1:1',
    Creator: 'BikeBlock Pattern Generator',
  });
}

// ---------------------------------------------------------------- certificate

export interface Jpeg {
  bytes: Uint8Array;
  w: number;
  h: number;
}

/** Letter landscape certificate of origin for one numbered plate. */
export async function certificatePDF(plate: Plate, s: Settings, render: Jpeg): Promise<Blob> {
  const W = 11 * 72,
    H = 8.5 * 72;
  const c = new Content();
  const m = 54;

  // Thin double rule around the page.
  c.op('0.55 0.42 0.13 RG 0.75 w');
  c.op(`${m - 14} ${m - 14} ${W - 2 * (m - 14)} ${H - 2 * (m - 14)} re S`);
  c.op('0.4 w');
  c.op(`${m - 10} ${m - 10} ${W - 2 * (m - 10)} ${H - 2 * (m - 10)} re S`);

  // Everything inside the border is laid out top-down, then shifted so the
  // composition sits centered on the page.
  const groupStart = c.out.length;

  // Product render on the left.
  const imgW = 5 * 72;
  const imgH = (imgW * render.h) / render.w;
  const ix = m + 6,
    iy = H - m - 40 - imgH;
  c.op(`q ${n(imgW)} 0 0 ${n(imgH)} ${n(ix)} ${n(iy)} cm /Im1 Do Q`);

  // Text on the right.
  const tx = ix + imgW + 34;
  let y = H - m - 60;
  c.text(tx, y, 13, 'F4', 'Certificate of origin', 0.35);
  y -= 50;
  c.text(tx, y, 40, 'F3', `No. ${String(s.edition).padStart(4, '0')}`);
  y -= 30;
  c.text(tx, y, 17, 'F3', s.name || 'BikeBlock plate');
  y -= 18;
  const label = patternLabel(s);
  for (const line of wrap(label, 46)) {
    c.text(tx, y, 10, 'F1', line, 0.3);
    y -= 13;
  }
  y -= 14;
  const st = plate.stats;
  const rows: [string, string][] = [
    ['Plate', `${plate.w.toFixed(2)} x ${plate.h.toFixed(2)} in, ${fraction(s.material.t)} in brass`],
    ['Cut by', s.material.process === 'waterjet' ? 'Abrasive waterjet' : 'Fiber laser'],
    ['Open area', `${(st.openArea * 100).toFixed(1)}%`],
    ['Cut path', `${(st.cutLength / 12).toFixed(1)} ft, ${st.pierces} pierces`],
    ['Seed', String(s.seed)],
    ['Design code', designCode(s)],
    ['Issued', today()],
  ];
  for (const [k, v] of rows) {
    c.text(tx, y, 8, 'F1', k, 0.45);
    c.text(tx + 72, y, 10, 'F1', v);
    y -= 17;
  }

  // Statement across the bottom.
  const stmt =
    'This plate was generated from the seed and settings recorded here. They reproduce its cut pattern exactly, ' +
    'and the design code changes if any of them change.';
  let by = iy - 26;
  for (const line of wrap(stmt, 62)) {
    c.text(ix, by, 9.5, 'F4', line, 0.25);
    by -= 13;
  }
  // Signature line.
  const sigY = Math.min(y - 40, iy + 20);
  c.op(`0 G 0.5 w ${n(tx)} ${n(sigY)} m ${n(W - m - 6)} ${n(sigY)} l S`);
  c.text(tx, sigY - 12, 8, 'F1', s.maker ? `Signed, ${s.maker}` : 'Signed', 0.45);
  const groupTop = H - m - 40;
  const groupBottom = Math.min(by + 13, sigY - 12);
  const dy = (groupBottom - (H - groupTop)) / 2;
  c.out.splice(groupStart, 0, `q 1 0 0 1 0 ${n(-dy)} cm`);
  c.op('Q');

  const doc = new PdfDoc();
  const pagesId = doc.reserve();
  const fonts = await fontResources(doc);
  const imgId = await doc.stream(
    `/Type /XObject /Subtype /Image /Width ${render.w} /Height ${render.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    render.bytes,
    false,
  );
  const contentId = await doc.stream('', c.bytes());
  const pageId = doc.add(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << ${fonts} /XObject << /Im1 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  );
  doc.set(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
  const root = doc.add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return doc.build(root, {
    Title: `Certificate, ${s.name} No. ${s.edition}`,
    Creator: 'BikeBlock Pattern Generator',
  });
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width && line) {
      lines.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

