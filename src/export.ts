// File exports: SVG and DXF (true scale, inches), PNG with embedded settings,
// and settings JSON. Every file carries the settings so it can be dropped
// back onto the app to restore the exact design.

import { RoundPoly, V, arcPoint, clean, clipRect, perimeter, rpArea, rpLength, rpPerimeter, rpSegments, signedArea } from './geom';
import type { Plate } from './plate';
import { renderToCanvas, ViewMode } from './render';
import type { Settings } from './settings';

const f = (x: number) => {
  const s = x.toFixed(5);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

export function baseName(s: Settings): string {
  const ed = String(s.edition).padStart(4, '0');
  const slug = (s.name || s.pattern.layout)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `plate-${ed}-${slug || 'design'}-seed${s.seed}-${f(s.plate.w)}x${f(s.plate.h)}in`;
}

// ---------- SVG ----------

function svgPath(rp: RoundPoly): string {
  const segs = rpSegments(rp);
  let d = '';
  segs.forEach((sg, i) => {
    if (sg.k === 'A') {
      const p0 = arcPoint(sg.c, sg.r, sg.a0);
      const p1 = arcPoint(sg.c, sg.r, sg.a1);
      if (i === 0) d += `M${f(p0.x)} ${f(p0.y)}`;
      const large = sg.a1 - sg.a0 > Math.PI + 1e-9 ? 1 : 0;
      d += `A${f(sg.r)} ${f(sg.r)} 0 ${large} 1 ${f(p1.x)} ${f(p1.y)}`;
    } else {
      if (i === 0) d += `M${f(sg.a.x)} ${f(sg.a.y)}`;
      d += `L${f(sg.b.x)} ${f(sg.b.y)}`;
    }
  });
  return d + 'Z';
}

function svgPoly(p: V[]): string {
  return p.map((q, i) => `${i ? 'L' : 'M'}${f(q.x)} ${f(q.y)}`).join('') + 'Z';
}

export function toSVG(plate: Plate, s: Settings): string {
  const json = JSON.stringify(s);
  const cuts = [...plate.holes, ...plate.slots].map(svgPath).join('') + plate.paths.map(svgPoly).join('');
  const st = plate.stats;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(plate.w)}in" height="${f(plate.h)}in" viewBox="0 0 ${f(plate.w)} ${f(plate.h)}">
<title>${esc(s.name || 'BikeBlock plate')} No. ${s.edition}</title>
<desc>Units: inches, 1:1. ${s.material.t} in brass, ${s.material.process}. Seed ${s.seed}. ${st.slots} slots, ${st.pierces} pierces, cut length ${st.cutLength.toFixed(1)} in, open area ${(st.openArea * 100).toFixed(1)}%.</desc>
<metadata id="bikeblock-settings"><![CDATA[${json}]]></metadata>
<g id="preview" fill="#b8913f" fill-rule="evenodd" stroke="none"><path d="${svgPath(plate.outline)}${cuts}"/></g>
<g id="cut-outline" fill="none" stroke="#0000ff" stroke-width="0.003"><path d="${svgPath(plate.outline)}"/></g>
<g id="cut-interior" fill="none" stroke="#ff0000" stroke-width="0.003"><path d="${cuts}"/></g>
</svg>
`;
}

function esc(x: string) {
  return x.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

// ---------- DXF (R12, inches, closed polylines with arc bulges) ----------

export function toDXF(plate: Plate, s: Settings): string {
  const out: string[] = [];
  const g = (code: number, val: string | number) => {
    out.push(String(code));
    out.push(typeof val === 'number' ? f(val) : val);
  };
  const H = plate.h;
  // Comment header with the full settings for round-tripping.
  g(999, `BikeBlock plate No. ${s.edition}, seed ${s.seed}, units inches`);
  g(999, `bikeblock-settings ${JSON.stringify(s)}`);
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$INSUNITS');
  g(70, 1);
  g(9, '$MEASUREMENT');
  g(70, 0);
  g(9, '$EXTMIN');
  g(10, 0);
  g(20, 0);
  g(9, '$EXTMAX');
  g(10, plate.w);
  g(20, plate.h);
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, 2);
  for (const [name, color] of [
    ['OUTLINE', 5],
    ['CUTS', 1],
  ] as const) {
    g(0, 'LAYER');
    g(2, name);
    g(70, 0);
    g(62, color);
    g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');

  const poly = (rp: RoundPoly, layer: string) => {
    g(0, 'POLYLINE');
    g(8, layer);
    g(66, 1);
    g(10, 0);
    g(20, 0);
    g(30, 0);
    g(70, 1); // closed
    for (const sg of rpSegments(rp)) {
      // Flip y so the DXF is y-up; that turns our arcs clockwise (negative bulge).
      let x: number, y: number, bulge = 0;
      if (sg.k === 'A') {
        const p = arcPoint(sg.c, sg.r, sg.a0);
        x = p.x;
        y = H - p.y;
        bulge = -Math.tan((sg.a1 - sg.a0) / 4);
      } else {
        x = sg.a.x;
        y = H - sg.a.y;
      }
      g(0, 'VERTEX');
      g(8, layer);
      g(10, x);
      g(20, y);
      g(30, 0);
      if (bulge !== 0) g(42, bulge);
    }
    g(0, 'SEQEND');
    g(8, layer);
  };

  const plain = (pts: V[], layer: string) => {
    g(0, 'POLYLINE');
    g(8, layer);
    g(66, 1);
    g(10, 0);
    g(20, 0);
    g(30, 0);
    g(70, 1);
    for (const q of pts) {
      g(0, 'VERTEX');
      g(8, layer);
      g(10, q.x);
      g(20, H - q.y);
      g(30, 0);
    }
    g(0, 'SEQEND');
    g(8, layer);
  };

  poly(plate.outline, 'OUTLINE');
  for (const rp of plate.holes) poly(rp, 'CUTS');
  for (const rp of plate.slots) poly(rp, 'CUTS');
  for (const pth of plate.paths) plain(pth, 'CUTS');
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// ---------- PNG with an embedded tEXt chunk ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_KEY = 'bikeblock';

function withTextChunk(png: Uint8Array, text: string): Uint8Array {
  const enc = new TextEncoder();
  const data = new Uint8Array([...enc.encode(PNG_KEY), 0, ...enc.encode(text)]);
  const typeData = new Uint8Array(4 + data.length);
  typeData.set(enc.encode('tEXt'), 0);
  typeData.set(data, 4);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk.set(typeData, 4);
  dv.setUint32(8 + data.length, crc32(typeData));
  // Insert before IEND (the last 12 bytes).
  const at = png.length - 12;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

function readTextChunk(png: Uint8Array): string | null {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  const dec = new TextDecoder();
  while (p + 8 <= png.length) {
    const len = dv.getUint32(p);
    const type = dec.decode(png.subarray(p + 4, p + 8));
    if (type === 'tEXt') {
      const body = png.subarray(p + 8, p + 8 + len);
      const z = body.indexOf(0);
      if (z > 0 && dec.decode(body.subarray(0, z)) === PNG_KEY) return dec.decode(body.subarray(z + 1));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return null;
}

export async function toPNG(
  plate: Plate,
  s: Settings,
  mode: ViewMode,
  pxWidth: number,
  frame: boolean,
): Promise<Blob> {
  const bg = mode === 'brass' ? (frame ? '#e4e1db' : '#1c1916') : '#ffffff';
  const c = renderToCanvas(plate, pxWidth, mode, s.material.t, bg, frame);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Blob([withTextChunk(bytes, JSON.stringify(s)) as BlobPart], { type: 'image/png' });
}

export async function toJPG(plate: Plate, s: Settings, pxWidth: number): Promise<Blob> {
  const c = renderToCanvas(plate, pxWidth, 'brass', s.material.t, '#e4e1db', true);
  return new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.9));
}

/** Pull settings out of any file this app exports (or a plain JSON file). */
export async function settingsFromFile(file: File): Promise<unknown | null> {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const t = readTextChunk(buf);
    return t ? JSON.parse(t) : null;
  }
  const text = new TextDecoder().decode(buf);
  const svg = text.match(/<metadata id="bikeblock-settings"><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/);
  if (svg) return JSON.parse(svg[1]);
  const dxf = text.match(/bikeblock-settings (\{.*\})/);
  if (dxf) return JSON.parse(dxf[1]);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function download(name: string, data: Blob | string, type = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- test coupon

/**
 * A small square cut from the middle of the real plate: every cut that lies
 * fully inside the window (with a minimum-web margin) keeps its exact shape.
 * Cut it first to check the shop's minimums on this exact pattern.
 */
export function couponPlate(plate: Plate, size: number): Plate {
  const c = Math.min(size, plate.w, plate.h);
  const x0 = (plate.w - c) / 2,
    y0 = (plate.h - c) / 2;
  const m = plate.limits.minWeb;
  const inside = (pts: V[], r: number) =>
    pts.every((q) => q.x - r >= x0 + m && q.x + r <= x0 + c - m && q.y - r >= y0 + m && q.y + r <= y0 + c - m);
  const shift = (q: V): V => ({ x: q.x - x0, y: q.y - y0 });
  // Convex cuts are trimmed to the window: their core is clipped so the
  // rounded end stays a minimum web away from the coupon edge.
  const slots: RoundPoly[] = [];
  for (const rp of plate.slots) {
    if (inside(rp.pts, rp.r)) {
      slots.push({ pts: rp.pts.map(shift), r: rp.r });
      continue;
    }
    if (rp.pts.length < 2) continue;
    const e = m + rp.r;
    const core = clean(clipRect(rp.pts, x0 + e, y0 + e, x0 + c - e, y0 + c - e));
    if (!core.length) continue;
    const trimmed = { pts: core.map(shift), r: rp.r };
    if (rpLength(trimmed) >= 3 * rp.r) slots.push(trimmed);
  }
  const paths = plate.paths.filter((p) => inside(p, 0)).map((p) => p.map(shift));
  const cr = Math.min(0.125, c / 4);
  const outline: RoundPoly = {
    pts: [
      { x: cr, y: cr },
      { x: c - cr, y: cr },
      { x: c - cr, y: c - cr },
      { x: cr, y: c - cr },
    ],
    r: cr,
  };
  let cut = rpPerimeter(outline),
    open = 0;
  for (const rp of slots) {
    cut += rpPerimeter(rp);
    open += rpArea(rp);
  }
  for (const p of paths) {
    cut += perimeter(p);
    open += Math.abs(signedArea(p));
  }
  open /= rpArea(outline);
  return {
    ...plate,
    w: c,
    h: c,
    outline,
    holes: [],
    slots,
    paths,
    stats: {
      ...plate.stats,
      slots: slots.length + paths.length,
      pierces: slots.length + paths.length,
      cutLength: cut,
      openArea: open,
    },
  };
}
