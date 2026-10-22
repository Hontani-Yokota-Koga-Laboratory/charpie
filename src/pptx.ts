/**
 * PowerPoint (.pptx) export: one slide per page, built from the laid-out pages so it shows what
 * charpie drew — shapes, arrows, tables and lists as PowerPoint's own (editable) objects.
 *
 * - Text keeps charpie's font size and line breaks (one paragraph per drawn line, no wrapping, exact
 *   line spacing). With `set compat=pptx` the fonts are ones Office has, so the lines fit as checked.
 * - Formulas: a label / table / list holding `$...$` becomes a picture (SVG, with a PNG for older
 *   PowerPoint) on top of its native shape.
 * - Embedded diagrams become a group of native shapes; pictures stay pictures.
 * - Arrows: straight ones are connectors glued to their shapes, the others freeforms; arrowheads are
 *   PowerPoint's own line ends.
 *
 * Everything is pure except `raster` (SVG → PNG), which the caller provides (headless Chromium).
 */
import { diagramBounds } from './components/Diagram';
import { exportSvg } from './exportFormats';
import { isDiagramSrc, lineAnchor, type EdgeLayout, type Layout, type NodeLayout } from './layout';
import type { Box, Pt } from './geom/geom';
import { LINE_HEIGHT } from './text/fit';
import { splitInline } from './text/inline';
import { eastAsianFor } from './text/office';
import type { BlockSlot, TextPiece } from './text/blocks';
import { zip, type ZipEntry } from './zip';

export interface PptxImage {
  data: Uint8Array;
  mime: string;
}

export interface RasterJob {
  svg: string;
  /** size of the PNG in px */
  w: number;
  h: number;
}

export interface PptxOptions {
  /** the bytes of an image shape's `src=` (undefined: not found) */
  image: (src: string) => PptxImage | undefined;
  /** PNGs of SVGs, in order (fallback pictures for formulas, SVG images, formats PowerPoint can't read) */
  raster: (jobs: RasterJob[]) => Promise<Uint8Array[]>;
  title?: string;
}

/** resolution of the PNG fallbacks */
const RASTER_SCALE = 3;

// ───────────── units & XML ─────────────

/** 1 px (CSS, 96 dpi) = 9525 EMU, so a 1280×720 page is PowerPoint's 16:9 slide exactly */
const emu = (px: number) => Math.round(px * 9525);
/** font size in 1/100 pt */
const hpt = (px: number) => Math.max(100, Math.round(px * 75));
const pct = (v: number) => Math.round(v * 100000);

const esc = (s: string) =>
  s
    // characters XML 1.0 can't hold
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ───────────── colours ─────────────

const NAMED: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500',
  purple: '800080', gray: '808080', grey: '808080', silver: 'C0C0C0', navy: '000080', teal: '008080', maroon: '800000',
  olive: '808000', lime: '00FF00', aqua: '00FFFF', cyan: '00FFFF', fuchsia: 'FF00FF', magenta: 'FF00FF', pink: 'FFC0CB',
  brown: 'A52A2A', gold: 'FFD700', indigo: '4B0082', violet: 'EE82EE', crimson: 'DC143C', coral: 'FF7F50', salmon: 'FA8072',
  tomato: 'FF6347', orchid: 'DA70D6', khaki: 'F0E68C', beige: 'F5F5DC', ivory: 'FFFFF0', lavender: 'E6E6FA', tan: 'D2B48C',
  turquoise: '40E0D0', skyblue: '87CEEB', steelblue: '4682B4', royalblue: '4169E1', darkblue: '00008B', darkgreen: '006400',
  darkred: '8B0000', darkgray: 'A9A9A9', darkgrey: 'A9A9A9', lightgray: 'D3D3D3', lightgrey: 'D3D3D3', lightblue: 'ADD8E6',
  lightgreen: '90EE90', whitesmoke: 'F5F5F5', gainsboro: 'DCDCDC', dimgray: '696969', slategray: '708090', forestgreen: '228B22',
  seagreen: '2E8B57', firebrick: 'B22222', chocolate: 'D2691E', goldenrod: 'DAA520', plum: 'DDA0DD', wheat: 'F5DEB3',
};

/** `#rgb` / `#rrggbb(aa)` / `rgb(…)` / a CSS name → hex + alpha; undefined for `none` / transparent */
export function parseColor(c: string | undefined): { hex: string; alpha: number } | undefined {
  if (!c) return undefined;
  const s = c.trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return undefined;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return { hex: '000000', alpha: 1 };
    return { hex: h.slice(0, 6).toUpperCase(), alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const v = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (x: string) => Math.max(0, Math.min(255, Math.round(x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x)))) || 0;
    const a = v[3] === undefined ? 1 : v[3].endsWith('%') ? parseFloat(v[3]) / 100 : parseFloat(v[3]);
    return { hex: v.slice(0, 3).map((x) => ch(x).toString(16).padStart(2, '0')).join('').toUpperCase(), alpha: Number.isFinite(a) ? a : 1 };
  }
  return { hex: NAMED[s] ?? '000000', alpha: 1 };
}

function clr(c: string | undefined, opacity = 1): string | undefined {
  const p = parseColor(c);
  if (!p) return undefined;
  const a = p.alpha * opacity;
  return `<a:srgbClr val="${p.hex}">${a < 1 ? `<a:alpha val="${pct(Math.max(0, a))}"/>` : ''}</a:srgbClr>`;
}
const solid = (c: string | undefined, opacity = 1) => {
  const x = clr(c, opacity);
  return x ? `<a:solidFill>${x}</a:solidFill>` : '<a:noFill/>';
};

// ───────────── transforms (embedded diagrams are drawn scaled into their box) ─────────────

interface Tf {
  s: number;
  dx: number;
  dy: number;
}
const X = (t: Tf, x: number) => x * t.s + t.dx;
const Y = (t: Tf, y: number) => y * t.s + t.dy;
const P = (t: Tf, p: Pt): Pt => ({ x: X(t, p.x), y: Y(t, p.y) });
const B = (t: Tf, b: Box): Box => ({ x: X(t, b.x), y: Y(t, b.y), w: b.w * t.s, h: b.h * t.s });
/** `inner` maps into `outer`'s space */
const compose = (outer: Tf, inner: Tf): Tf => ({ s: outer.s * inner.s, dx: X(outer, inner.dx), dy: Y(outer, inner.dy) });

const xfrm = (b: Box, extra = '') =>
  `<a:xfrm${extra}><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${Math.max(0, emu(b.w))}" cy="${Math.max(0, emu(b.h))}"/></a:xfrm>`;

// ───────────── package parts ─────────────

interface Media {
  name: string;
  data?: Uint8Array;
  /** index into the raster jobs (filled in after the slides are built) */
  job?: number;
}

class Package {
  media: Media[] = [];
  jobs: RasterJob[] = [];
  private byKey = new Map<string, Media>();

  add(key: string, ext: string, data?: Uint8Array, job?: RasterJob): Media {
    const hit = this.byKey.get(key);
    if (hit) return hit;
    const m: Media = { name: `image${this.media.length + 1}.${ext}`, data };
    if (job) m.job = this.jobs.push(job) - 1;
    this.media.push(m);
    this.byKey.set(key, m);
    return m;
  }
}

class Slide {
  private rels: { id: string; type: string; target: string }[] = [{ id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }];
  private nextId = 2;
  constructor(readonly pkg: Package) {}

  /** a fresh shape id (1 is the slide's tree) */
  id(): number {
    return this.nextId++;
  }

  rel(m: Media): string {
    const target = `../media/${m.name}`;
    const hit = this.rels.find((r) => r.target === target);
    if (hit) return hit.id;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type: `${REL}/image`, target });
    return id;
  }

  relsXml(): string {
    return XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">` + this.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('') + '</Relationships>';
  }
}

// ───────────── text ─────────────

interface RunFont {
  size: number;
  weight: number;
  family?: string;
  color: string;
  opacity: number;
}

/** latin / East Asian typefaces of a family (the default font: Inter + a Japanese sans) */
function typefaces(family: string | undefined): { latin: string; ea: string } {
  if (!family) return { latin: 'Inter', ea: 'Noto Sans JP' };
  return { latin: family, ea: eastAsianFor(family) ?? family };
}

function rPr(f: RunFont, bold: boolean, tag = 'a:rPr'): string {
  const t = typefaces(f.family);
  const fill = solid(f.color, f.opacity);
  return `<${tag} lang="ja-JP" altLang="en-US" sz="${hpt(f.size)}" b="${bold || f.weight >= 600 ? 1 : 0}" dirty="0">${fill}<a:latin typeface="${esc(t.latin)}"/><a:ea typeface="${esc(t.ea)}"/><a:cs typeface="${esc(t.latin)}"/></${tag}>`;
}

/** A drawn line as runs (`**bold**` spans; formulas never get here) */
function runs(line: string, f: RunFont): string {
  return splitInline(line)
    .filter((g) => g.s)
    .map((g) => `<a:r>${rPr(f, g.bold)}<a:t>${esc(g.s)}</a:t></a:r>`)
    .join('');
}

const ALGN = { left: 'l', center: 'ctr', right: 'r' } as const;

/** One paragraph; `pPrAttrs` / `bullet` add indents and a bullet (lists) */
function para(lines: string[], f: RunFont, o: { algn: 'left' | 'center' | 'right'; lh: number; before?: number; pPrAttrs?: string; bullet?: string }): string {
  const spc = `<a:lnSpc><a:spcPts val="${Math.round(f.size * o.lh * 75)}"/></a:lnSpc><a:spcBef><a:spcPts val="${Math.round((o.before ?? 0) * 75)}"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>`;
  const body = lines.map((l) => runs(l, f)).join('<a:br>' + rPr(f, false) + '</a:br>');
  return `<a:p><a:pPr algn="${ALGN[o.algn]}"${o.pPrAttrs ?? ''}>${spc}${o.bullet ?? '<a:buNone/>'}</a:pPr>${body}${rPr(f, false, 'a:endParaRPr')}</a:p>`;
}

const hasMath = (lines: string[]) => lines.some((l) => l.includes('$') && splitInline(l).some((g) => g.math));

interface BodyPr {
  l: number;
  t: number;
  r: number;
  b: number;
  anchor: 't' | 'ctr' | 'b';
  vert?: 'vert' | 'vert270';
  rot?: number;
}
const bodyPr = (o: BodyPr) =>
  `<a:bodyPr wrap="none" lIns="${emu(Math.max(0, o.l))}" tIns="${emu(Math.max(0, o.t))}" rIns="${emu(Math.max(0, o.r))}" bIns="${emu(Math.max(0, o.b))}" anchor="${o.anchor}" anchorCtr="0" rtlCol="0"${o.vert ? ` vert="${o.vert}"` : ''}${o.rot ? ` rot="${o.rot * 60000}"` : ''}><a:noAutofit/></a:bodyPr>`;

// ───────────── shapes ─────────────

type Geom = { xml: string; /** text area PowerPoint uses inside the box (insets are added to it) */ inner: Box };

/** Path of a custom geometry, in EMU relative to `box`; `rect` = the text area */
function custGeom(box: Box, cmds: string, rect: Box, open = false): string {
  const w = Math.max(1, emu(box.w)),
    h = Math.max(1, emu(box.h));
  const r = { l: emu(rect.x - box.x), t: emu(rect.y - box.y), r: emu(rect.x + rect.w - box.x), b: emu(rect.y + rect.h - box.y) };
  // the text area through guides, as fractions of the shape (LibreOffice drops the text of a literal or `val` rect)
  const gd = Object.entries(r)
    .map(([k, v]) => `<a:gd name="tx${k}" fmla="*/ ${k === 'l' || k === 'r' ? `w ${v} ${w}` : `h ${v} ${h}`}"/>`)
    .join('');
  return `<a:custGeom><a:avLst/><a:gdLst>${gd}</a:gdLst><a:ahLst/><a:cxnLst/><a:rect l="txl" t="txt" r="txr" b="txb"/><a:pathLst><a:path w="${w}" h="${h}"${open ? ' fill="none"' : ''}>${cmds}</a:path></a:pathLst></a:custGeom>`;
}
const pt = (p: Pt, o: Box) => `<a:pt x="${emu(p.x - o.x)}" y="${emu(p.y - o.y)}"/>`;
const polyCmds = (pts: Pt[], o: Box, close: boolean) =>
  `<a:moveTo>${pt(pts[0], o)}</a:moveTo>` + pts.slice(1).map((p) => `<a:lnTo>${pt(p, o)}</a:lnTo>`).join('') + (close ? '<a:close/>' : '');

/** The shape's outline: a preset where PowerPoint has the same one, else the exact polygon */
function geometry(n: NodeLayout, box: Box, tb: Box, poly: Pt[]): Geom {
  const prst = (name: string, av = '', inner: Box = box) => ({ xml: `<a:prstGeom prst="${name}"><a:avLst>${av}</a:avLst></a:prstGeom>`, inner });
  const ss = Math.min(box.w, box.h) || 1;
  const inscribed = (): Box => {
    // ellipse-like presets: the text area is the inscribed rectangle
    const iw = box.w / Math.SQRT2,
      ih = box.h / Math.SQRT2;
    return { x: box.x + (box.w - iw) / 2, y: box.y + (box.h - ih) / 2, w: iw, h: ih };
  };
  switch (n.kind) {
    case 'rect':
    case 'text':
    case 'image':
    case 'table':
    case 'list':
      return prst('rect');
    case 'round': {
      const r = Math.min(n.style.radius * (box.w / (n.box.w || 1)), ss / 2);
      const a = Math.min(50000, Math.round((r / ss) * 100000));
      // roundRect's text area is inset by 29.3% of the radius
      const i = r * 0.29289;
      return prst('roundRect', `<a:gd name="adj" fmla="val ${a}"/>`, { x: box.x + i, y: box.y + i, w: box.w - 2 * i, h: box.h - 2 * i });
    }
    case 'ellipse':
      return prst('ellipse', '', inscribed());
    case 'cross':
      return prst('flowChartSummingJunction', '', inscribed());
    case 'plus':
      return prst('flowChartOr', '', inscribed());
    case 'diamond':
      return prst('diamond', '', { x: box.x + box.w / 4, y: box.y + box.h / 4, w: box.w / 2, h: box.h / 2 });
    default:
      // trap / para / hex: the polygon itself, with charpie's text area (presets put theirs elsewhere)
      return { xml: custGeom(box, polyCmds(poly, box, true), tb), inner: tb };
  }
}

function line(stroke: string | undefined, lw: number, dash: 'solid' | 'dashed' | 'dotted', opacity: number, ends = ''): string {
  const c = clr(stroke, opacity);
  if (!c || lw <= 0) return '<a:ln><a:noFill/></a:ln>';
  const d = dash === 'dashed' ? '<a:prstDash val="dash"/>' : dash === 'dotted' ? '<a:custDash><a:ds d="1000" sp="240000"/></a:custDash>' : '';
  return `<a:ln w="${emu(lw)}" cap="rnd"><a:solidFill>${c}</a:solidFill>${d}<a:round/>${ends}</a:ln>`;
}

interface Ctx {
  slide: Slide;
  pkg: Package;
  opt: PptxOptions;
  /** node id → shape id (arrows glue to them) */
  ids: Map<string, number>;
  out: string[];
}

const spXml = (id: number, name: string, spPr: string, txBody = '', txBox = false) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr>${spPr}</p:spPr>${txBody ? `<p:txBody>${txBody}</p:txBody>` : ''}</p:sp>`;

const EMPTY_TEXT = '<a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP"/></a:p>';

/** A picture: PNG (or JPEG / GIF) with an SVG beside it when there is one */
function picXml(c: Ctx, name: string, box: Box, png: Media, svg?: Media, o: { crop?: { l: number; t: number; r: number; b: number }; opacity?: number; descr?: string } = {}): string {
  const id = c.slide.id();
  const svgExt = svg ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${c.slide.rel(svg)}"/></a:ext></a:extLst>` : '';
  const alpha = o.opacity !== undefined && o.opacity < 1 ? `<a:alphaModFix amt="${pct(o.opacity)}"/>` : '';
  const crop = o.crop ? `<a:srcRect l="${pct(o.crop.l)}" t="${pct(o.crop.t)}" r="${pct(o.crop.r)}" b="${pct(o.crop.b)}"/>` : '';
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}"${o.descr ? ` descr="${esc(o.descr)}"` : ''}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${c.slide.rel(png)}">${alpha}${svgExt}</a:blip>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

/** Part of the drawing as a picture: an SVG of `sub` cropped to `region`, plus its PNG */
function svgPicture(c: Ctx, name: string, sub: Omit<Layout, 'frame'>, region: Box, at: Box, key: string): string {
  const svg = exportSvg({ ...sub, frame: region }, null);
  const svgMedia = c.pkg.add('svg:' + key + svg, 'svg', new TextEncoder().encode(svg));
  const png = c.pkg.add('png:' + key + svg, 'png', undefined, { svg, w: Math.ceil(region.w * RASTER_SCALE), h: Math.ceil(region.h * RASTER_SCALE) });
  return picXml(c, name, at, png, svgMedia);
}

const grow = (b: Box, d: number): Box => ({ x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d });
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x),
    y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const single = (nodes: NodeLayout[], edges: EdgeLayout[] = []): Omit<Layout, 'frame'> => ({
  nodes,
  edges,
  nodeMap: new Map(nodes.map((n) => [n.id, n])),
  edgeMap: new Map(edges.map((e) => [e.key, e])),
});

function nodeXml(c: Ctx, n: NodeLayout, t: Tf) {
  const s = n.style;
  const box = B(t, n.box);
  const name = n.id;

  if (n.embed) {
    // another diagram: its shapes, scaled into the box, as one group
    const e = n.embed;
    const inner = compose(t, { s: e.scale, dx: e.dx, dy: e.dy });
    const sub: Ctx = { ...c, ids: new Map(), out: [] };
    if (e.layout.frame) sub.out.push(spXml(c.slide.id(), 'page', `${xfrm(B(inner, e.layout.frame))}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln>`));
    layoutXml(sub, e.layout, inner);
    const gid = c.slide.id();
    const g = `<a:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(box.w)}" cy="${emu(box.h)}"/><a:chOff x="${emu(box.x)}" y="${emu(box.y)}"/><a:chExt cx="${emu(box.w)}" cy="${emu(box.h)}"/></a:xfrm>`;
    c.out.push(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${gid}" name="${esc(name)}" descr="${esc(s.src ?? '')}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${g}</p:grpSpPr>${sub.out.join('')}</p:grpSp>`);
    frameOnly(c, n, t);
    return;
  }

  if (n.kind === 'image') {
    if (s.src && !isDiagramSrc(s.src)) imageXml(c, n, box);
    frameOnly(c, n, t);
    return;
  }

  if (n.blocks) {
    const texts = n.blocks.pieces.flatMap((p) => p.lines);
    if (hasMath(texts)) {
      // formulas inside: the whole block as a picture
      const region = grow(n.box, s.lw);
      c.out.push(svgPicture(c, name, single([n]), region, B(t, region), n.id));
    } else {
      if (parseColor(s.fill) || (n.kind === 'list' && parseColor(s.stroke))) frameOnly(c, n, t, n.kind === 'list');
      if (n.kind === 'table') tableXml(c, n, t);
      else listXml(c, n, t);
    }
    return;
  }

  const tb = B(t, n.textBox);
  const g = geometry(n, box, tb, n.poly.map((p) => P(t, p)));
  const spPr = xfrm(box) + g.xml + solid(s.fill, s.opacity) + line(s.stroke, s.lw * t.s, s.dash, s.opacity);
  const lines = n.text.lines;
  const math = hasMath(lines);
  let body = EMPTY_TEXT;
  if (n.def.label && lines.length && !math) {
    const f: RunFont = { size: n.text.size * t.s, weight: s.weight, family: s.family, color: s.text, opacity: s.opacity };
    const rot = s.rotate;
    // anchor: where the block sits across the lines (screen valign, or halign when the text is turned)
    const across = rot === 0 ? s.valign : rot === 180 ? (s.valign === 'top' ? 'bottom' : s.valign === 'bottom' ? 'top' : 'middle') : rot === 90 ? (s.halign === 'right' ? 'top' : s.halign === 'left' ? 'bottom' : 'middle') : s.halign === 'left' ? 'top' : s.halign === 'right' ? 'bottom' : 'middle';
    const anchor = across === 'top' ? 't' : across === 'bottom' ? 'b' : 'ctr';
    const ins = { l: tb.x - g.inner.x, t: tb.y - g.inner.y, r: g.inner.x + g.inner.w - (tb.x + tb.w), b: g.inner.y + g.inner.h - (tb.y + tb.h) };
    body =
      bodyPr({ ...ins, anchor, vert: rot === 90 ? 'vert' : rot === 270 ? 'vert270' : undefined, rot: rot === 180 ? 180 : undefined }) +
      '<a:lstStyle/>' +
      lines.map((l) => para([l], f, { algn: lineAnchor(s), lh: LINE_HEIGHT })).join('');
  }
  const id = c.slide.id();
  c.ids.set(n.id, id);
  c.out.push(spXml(id, name, spPr, body));
  if (n.def.label && math) {
    // the label as a picture over the (native) shape
    const bare = { ...n, style: { ...s, fill: 'none', stroke: 'none' } };
    const region = grow(union(n.box, n.textRect), 2);
    c.out.push(svgPicture(c, name + ' label', single([bare]), region, B(t, region), n.id + ':label'));
  }
}

/** A shape's frame on its own (pictures, embedded diagrams, blocks): fill and / or stroke, no text (drawn over a picture, as charpie does) */
function frameOnly(c: Ctx, n: NodeLayout, t: Tf, stroke = n.kind !== 'table') {
  const s = n.style;
  const fill = parseColor(s.fill);
  const st = stroke && parseColor(s.stroke) ? s.stroke : 'none';
  if (!fill && st === 'none') return;
  const box = B(t, n.box);
  const g = geometry(n, box, B(t, n.textBox), n.poly.map((p) => P(t, p)));
  c.out.push(spXml(c.slide.id(), n.id + ' frame', xfrm(box) + g.xml + solid(s.fill, s.opacity) + line(st, s.lw * t.s, s.dash, s.opacity), EMPTY_TEXT));
}

// ───────────── pictures ─────────────

/** Pixel size of a PNG / JPEG / GIF / SVG (undefined: unknown) */
export function imageSize(data: Uint8Array, mime: string): { w: number; h: number } | undefined {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    if (mime === 'image/png' && data.length >= 24) return { w: v.getUint32(16), h: v.getUint32(20) };
    if (mime === 'image/gif' && data.length > 10) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
    if (mime === 'image/jpeg') {
      let p = 2;
      while (p + 9 < data.length) {
        if (data[p] !== 0xff) return undefined;
        const m = data[p + 1];
        const len = v.getUint16(p + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: v.getUint16(p + 7), h: v.getUint16(p + 5) };
        p += 2 + len;
      }
      return undefined;
    }
    if (mime === 'image/svg+xml') {
      const head = new TextDecoder().decode(data.subarray(0, 4096));
      const tag = /<svg\b[^>]*>/.exec(head)?.[0] ?? '';
      const num = (a: string) => {
        const m = new RegExp(`\\s${a}="\\s*([\\d.]+)(px)?\\s*"`).exec(tag);
        return m ? Number(m[1]) : undefined;
      };
      const vb = /viewBox="([^"]+)"/.exec(tag)?.[1].trim().split(/[\s,]+/).map(Number);
      const w = num('width') ?? vb?.[2],
        h = num('height') ?? vb?.[3];
      return w && h ? { w, h } : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const NATIVE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif' };

function b64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

function imageXml(c: Ctx, n: NodeLayout, box: Box) {
  const s = n.style;
  const img = c.opt.image(s.src!);
  if (!img) return;
  const fit = s.fit;
  const native = NATIVE[img.mime];
  const size = imageSize(img.data, img.mime);
  const key = s.src!;
  let media: Media;
  let svg: Media | undefined;
  let at = box;
  let crop: { l: number; t: number; r: number; b: number } | undefined;
  if (native || (img.mime === 'image/svg+xml' && size)) {
    if (img.mime === 'image/svg+xml') {
      svg = c.pkg.add('img-svg:' + key, 'svg', img.data);
      const sw = Math.ceil(size!.w * RASTER_SCALE),
        sh = Math.ceil(size!.h * RASTER_SCALE);
      const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${size!.w}" height="${size!.h}" viewBox="0 0 ${size!.w} ${size!.h}"><image href="data:image/svg+xml;base64,${b64(img.data)}" width="${size!.w}" height="${size!.h}"/></svg>`;
      media = c.pkg.add('img-png:' + key, 'png', undefined, { svg: wrapper, w: sw, h: sh });
    } else media = c.pkg.add('img:' + key, native, img.data);
    if (size && fit !== 'fill') {
      const ia = size.w / size.h,
        ba = box.w / box.h;
      if (fit === 'contain') {
        const w = ia > ba ? box.w : box.h * ia,
          h = ia > ba ? box.w / ia : box.h;
        at = { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
      } else if (ia > ba) {
        const k = (1 - ba / ia) / 2;
        crop = { l: k, t: 0, r: k, b: 0 };
      } else {
        const k = (1 - ia / ba) / 2;
        crop = { l: 0, t: k, r: 0, b: k };
      }
    }
  } else {
    // a format PowerPoint may not read (webp, avif, …) or of unknown size: drawn into the box as a PNG
    const preserve = { contain: 'xMidYMid meet', cover: 'xMidYMid slice', fill: 'none' }[fit];
    const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" width="${n.box.w}" height="${n.box.h}"><image href="data:${img.mime};base64,${b64(img.data)}" width="${n.box.w}" height="${n.box.h}" preserveAspectRatio="${preserve}"/></svg>`;
    media = c.pkg.add('img-raster:' + key + fit + n.box.w + 'x' + n.box.h, 'png', undefined, { svg: wrapper, w: Math.ceil(n.box.w * 2), h: Math.ceil(n.box.h * 2) });
  }
  c.out.push(picXml(c, n.id, at, media, svg, { crop, opacity: s.opacity, descr: n.def.label }));
}

// ───────────── tables ─────────────

const close = (a: number, b: number) => Math.abs(a - b) < 0.6;

function tableXml(c: Ctx, n: NodeLayout, t: Tf) {
  const bl = n.blocks!;
  const s = n.style;
  const slots = bl.slots.filter((x) => x.cell);
  if (!slots.length) return;
  const uniq = (vs: number[]) => vs.sort((a, b) => a - b).filter((v, i, a) => i === 0 || !close(v, a[i - 1]));
  const xs = uniq(slots.flatMap((x) => [x.cell!.x, x.cell!.x + x.cell!.w]));
  const ys = uniq(slots.flatMap((x) => [x.cell!.y, x.cell!.y + x.cell!.h]));
  const colAt = (x: number) => xs.findIndex((v) => close(v, x));
  const rowAt = (y: number) => ys.findIndex((v) => close(v, y));
  const nr = ys.length - 1,
    nc = xs.length - 1;
  const grid: (BlockSlot | 'merged' | undefined)[][] = Array.from({ length: nr }, () => Array(nc).fill(undefined));
  const textOf = new Map<BlockSlot, TextPiece>();
  bl.pieces.forEach((p) => p.slot !== undefined && textOf.set(bl.slots[p.slot], p));
  for (const sl of slots) {
    const r = rowAt(sl.cell!.y),
      c0 = colAt(sl.cell!.x),
      c1 = colAt(sl.cell!.x + sl.cell!.w);
    if (r < 0 || c0 < 0 || c1 <= c0) continue;
    grid[r][c0] = sl;
    for (let k = c0 + 1; k < c1; k++) grid[r][k] = 'merged';
  }
  const ruleColor = parseColor(s.stroke) ? s.stroke : s.text;
  /** a rule along one side of a cell */
  const ruleOn = (side: 'L' | 'R' | 'T' | 'B', cell: Box) => {
    const r = bl.rules.find((ru) => {
      const horiz = close(ru.y1, ru.y2);
      if (side === 'T' || side === 'B') {
        const y = side === 'T' ? cell.y : cell.y + cell.h;
        return horiz && close(ru.y1, y) && Math.min(ru.x1, ru.x2) <= cell.x + 0.6 && Math.max(ru.x1, ru.x2) >= cell.x + cell.w - 0.6;
      }
      const x = side === 'L' ? cell.x : cell.x + cell.w;
      return !horiz && close(ru.x1, x) && Math.min(ru.y1, ru.y2) <= cell.y + 0.6 && Math.max(ru.y1, ru.y2) >= cell.y + cell.h - 0.6;
    });
    const tag = `a:ln${side}`;
    if (!r) return `<${tag} w="0"><a:noFill/></${tag}>`;
    return `<${tag} w="${emu(r.lw * t.s)}" cap="flat" cmpd="sng" algn="ctr">${solid(ruleColor, s.opacity)}<a:prstDash val="solid"/><a:round/></${tag}>`;
  };
  const fillOf = (cell: Box) => {
    const cx = cell.x + cell.w / 2,
      cy = cell.y + cell.h / 2;
    let f: string | undefined;
    for (const x of bl.fills) if (cx >= x.x && cx <= x.x + x.w && cy >= x.y && cy <= x.y + x.h) f = x.fill;
    return f;
  };
  const rows: string[] = [];
  for (let r = 0; r < nr; r++) {
    const cells: string[] = [];
    for (let k = 0; k < nc; k++) {
      const sl = grid[r][k];
      if (sl === 'merged' || !sl) {
        cells.push(`<a:tc${sl === 'merged' ? ' hMerge="1"' : ''}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ja-JP" dirty="0"/></a:p></a:txBody><a:tcPr/></a:tc>`);
        continue;
      }
      const cell = sl.cell!;
      const span = colAt(cell.x + cell.w) - k;
      const p = textOf.get(sl);
      const f: RunFont = { size: (p?.size ?? sl.size) * t.s, weight: p?.weight ?? sl.weight, family: s.family, color: p?.color ?? sl.color ?? s.text, opacity: s.opacity };
      const lh = p?.lh ?? sl.lh ?? LINE_HEIGHT;
      const body = p ? p.lines.map((l) => para([l], f, { algn: sl.align, lh })).join('') : para([''], f, { algn: sl.align, lh });
      // PowerPoint wraps table text: a little room on the side the text grows towards
      const ml = sl.x - cell.x,
        mr = cell.x + cell.w - (sl.x + sl.w);
      const slack = Math.min(ml, mr, f.size * 0.25 / t.s);
      const l = sl.align === 'left' ? ml : sl.align === 'center' ? ml - slack : ml - slack * 2;
      const rr = sl.align === 'right' ? mr : sl.align === 'center' ? mr - slack : mr - slack * 2;
      const fill = fillOf(cell);
      const tcPr = `<a:tcPr marL="${emu(Math.max(0, l) * t.s)}" marR="${emu(Math.max(0, rr) * t.s)}" marT="0" marB="0" anchor="ctr">${ruleOn('L', cell)}${ruleOn('R', cell)}${ruleOn('T', cell)}${ruleOn('B', cell)}${fill ? solid(fill, s.opacity) : '<a:noFill/>'}</a:tcPr>`;
      cells.push(`<a:tc${span > 1 ? ` gridSpan="${span}"` : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody>${tcPr}</a:tc>`);
    }
    rows.push(`<a:tr h="${emu((ys[r + 1] - ys[r]) * t.s)}">${cells.join('')}</a:tr>`);
  }
  const at = B(t, { x: xs[0], y: ys[0], w: xs[nc] - xs[0], h: ys[nr] - ys[0] });
  const cols = xs.slice(1).map((x, i) => `<a:gridCol w="${emu((x - xs[i]) * t.s)}"/>`).join('');
  const id = c.slide.id();
  c.ids.set(n.id, id);
  c.out.push(
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(n.id)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${emu(at.x)}" y="${emu(at.y)}"/><a:ext cx="${emu(at.w)}" cy="${emu(at.h)}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="0" bandRow="0"><a:tableStyleId>{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId></a:tblPr><a:tblGrid>${cols}</a:tblGrid>${rows.join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
  );
}

// ───────────── lists ─────────────

/** bullet characters for charpie's ● ○ ■ marks (size relative to the text) */
const BULLET = { disc: { char: '•', size: 100 }, circle: { char: '○', size: 70 }, square: { char: '■', size: 70 } } as const;

function listXml(c: Ctx, n: NodeLayout, t: Tf) {
  const bl = n.blocks!;
  const s = n.style;
  const box = B(t, n.box);
  const left = bl.x,
    top = bl.y;
  const paras: string[] = [];
  let prevBottom: number | undefined;
  bl.slots.forEach((sl, k) => {
    const piece = bl.pieces.find((p) => p.slot === k);
    const lines = piece?.lines ?? [''];
    const size = piece?.size ?? sl.size;
    const lh = piece?.lh ?? sl.lh ?? LINE_HEIGHT;
    const f: RunFont = { size: size * t.s, weight: piece?.weight ?? sl.weight, family: s.family, color: piece?.color ?? sl.color ?? s.text, opacity: s.opacity };
    const mark = bl.marks.find((m) => m.cy >= sl.y && m.cy <= sl.y + size * lh);
    const markX = sl.marker ? sl.marker.x : mark ? mark.cx - size * 0.3 : sl.x;
    const marL = sl.x - left;
    const indent = markX - sl.x;
    let bullet = '<a:buNone/>';
    const clrXml = clr(s.text, s.opacity) ?? '<a:srgbClr val="000000"/>';
    if (mark) {
      const b = BULLET[mark.kind];
      bullet = `<a:buClr>${clrXml}</a:buClr><a:buSzPct val="${b.size * 1000}"/><a:buFont typeface="Arial"/><a:buChar char="${b.char}"/>`;
    } else if (sl.marker) {
      const m = /^(\d+)([.)])$/.exec(sl.marker.text);
      bullet = m
        ? `<a:buClr>${clrXml}</a:buClr><a:buSzPct val="100000"/><a:buFont typeface="+mj-lt"/><a:buAutoNum type="${m[2] === ')' ? 'arabicParenR' : 'arabicPeriod'}" startAt="${m[1]}"/>`
        : `<a:buClr>${clrXml}</a:buClr><a:buChar char="${esc(sl.marker.text)}"/>`;
    }
    const before = prevBottom === undefined ? 0 : (sl.y - prevBottom) * t.s;
    prevBottom = sl.y + lines.length * size * lh;
    // nesting is in the indent (charpie's own steps), so every item stays at level 0
    paras.push(para(lines, f, { algn: 'left', lh, before: Math.max(0, before), pPrAttrs: ` marL="${emu(marL * t.s)}" indent="${emu(indent * t.s)}"`, bullet }));
  });
  const ins = { l: (left - n.box.x) * t.s, t: (top - n.box.y) * t.s, r: 0, b: 0 };
  const id = c.slide.id();
  c.ids.set(n.id, id);
  c.out.push(spXml(id, n.id, xfrm(box) + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>', bodyPr({ ...ins, anchor: 't' }) + '<a:lstStyle/>' + paras.join(''), true));
}

// ───────────── arrows ─────────────

/** PowerPoint's line-end sizes are multiples of the line width (sm 2, med 3, lg 5) */
function headEnd(tag: 'a:headEnd' | 'a:tailEnd', lw: number): string {
  const ratio = (7 + lw * 2.2) / Math.max(lw, 0.1);
  const sz = ratio >= 4 ? 'lg' : ratio >= 2.5 ? 'med' : 'sm';
  return `<${tag} type="stealth" w="${sz}" len="${sz}"/>`;
}

/** Connection sites of the presets arrows can glue to: top, left, bottom, right */
const GLUE = new Set(['rect', 'round', 'diamond', 'text']);
function site(n: NodeLayout, p: Pt): number {
  const b = n.box;
  const d = [Math.abs(p.y - b.y), Math.abs(p.x - b.x), Math.abs(p.y - (b.y + b.h)), Math.abs(p.x - (b.x + b.w))];
  return d.indexOf(Math.min(...d));
}

/** Path commands for an arrow (rounded corners for ortho, one quadratic for a bent arrow) */
function edgeCmds(e: EdgeLayout, pts: Pt[], o: Box, scale: number): string {
  const isCurve = e.style.route !== 'ortho' && !e.selfLoop && pts.length === 25;
  if (isCurve) {
    const a = pts[0],
      m = pts[12],
      b = pts[24];
    const ctrl = { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
    return `<a:moveTo>${pt(a, o)}</a:moveTo><a:quadBezTo>${pt(ctrl, o)}${pt(b, o)}</a:quadBezTo>`;
  }
  if ((e.style.route === 'ortho' || e.selfLoop) && pts.length > 2) {
    let d = `<a:moveTo>${pt(pts[0], o)}</a:moveTo>`;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1],
        b = pts[i],
        cc = pts[i + 1];
      const l1 = Math.hypot(a.x - b.x, a.y - b.y),
        l2 = Math.hypot(cc.x - b.x, cc.y - b.y);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const r = Math.min(8 * scale, l1 / 2, l2 / 2);
      const p1 = { x: b.x + ((a.x - b.x) / l1) * r, y: b.y + ((a.y - b.y) / l1) * r };
      const p2 = { x: b.x + ((cc.x - b.x) / l2) * r, y: b.y + ((cc.y - b.y) / l2) * r };
      d += `<a:lnTo>${pt(p1, o)}</a:lnTo><a:quadBezTo>${pt(b, o)}${pt(p2, o)}</a:quadBezTo>`;
    }
    return d + `<a:lnTo>${pt(pts[pts.length - 1], o)}</a:lnTo>`;
  }
  return polyCmds(pts, o, false);
}

function edgeXml(c: Ctx, e: EdgeLayout, t: Tf, nodes: Map<string, NodeLayout>) {
  const s = e.style;
  const pts = e.pts.map((p) => P(t, p));
  if (pts.length < 2) return;
  const lw = s.lw * t.s;
  const ends = (e.def.op === '<-' || e.def.op === '<->' ? headEnd('a:headEnd', lw) : '') + (e.def.op === '->' || e.def.op === '<->' ? headEnd('a:tailEnd', lw) : '');
  const ln = line(s.stroke, lw, s.dash, 1, ends);
  const id = c.slide.id();
  const name = `${e.def.from} ${e.def.op} ${e.def.to}`;
  if (s.route === 'straight' && s.bend === 0 && !e.selfLoop && pts.length === 2) {
    // a connector: glued to its shapes, so it follows them when they are moved
    const [a, b] = pts;
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    const flip = (a.x > b.x ? ' flipH="1"' : '') + (a.y > b.y ? ' flipV="1"' : '');
    const glue = (end: 'from' | 'to') => {
      if (e.free[end]) return '';
      const nid = end === 'from' ? e.def.from : e.def.to;
      const n = nodes.get(nid);
      const sid = c.ids.get(nid);
      if (!n || sid === undefined || !GLUE.has(n.kind)) return '';
      return `<a:${end === 'from' ? 'stCxn' : 'endCxn'} id="${sid}" idx="${site(n, end === 'from' ? e.pts[0] : e.pts[e.pts.length - 1])}"/>`;
    };
    const cxn = `<p:cNvCxnSpPr>${glue('from')}${glue('to')}</p:cNvCxnSpPr>`;
    c.out.push(`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${esc(name)}"/>${cxn}<p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(box, flip)}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:noFill/>${ln}</p:spPr></p:cxnSp>`);
  } else {
    const xs = pts.map((p) => p.x),
      ys = pts.map((p) => p.y);
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    c.out.push(spXml(id, name, xfrm(box) + custGeom(box, edgeCmds(e, pts, box, t.s), box, true) + '<a:noFill/>' + ln));
  }
}

function edgeLabelXml(c: Ctx, e: EdgeLayout, t: Tf) {
  const L = e.label;
  if (!L) return;
  const box = B(t, L.box);
  const name = `${e.def.from} ${e.def.op} ${e.def.to} label`;
  if (hasMath(L.lines)) {
    const bare = { ...e, path: '', heads: [] };
    c.out.push(svgPicture(c, name, single([], [bare]), L.box, box, e.key + ':label'));
    return;
  }
  const f: RunFont = { size: L.size * t.s, weight: 500, family: e.style.family, color: e.style.text, opacity: 1 };
  const r = Math.min(8, L.box.h / 2) * t.s;
  const a = Math.min(50000, Math.round((r / (Math.min(box.w, box.h) || 1)) * 100000));
  const spPr = xfrm(box) + `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${a}"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln>`;
  const body = bodyPr({ l: 0, t: 3 * t.s, r: 0, b: 3 * t.s, anchor: 'ctr' }) + '<a:lstStyle/>' + L.lines.map((l) => para([l], f, { algn: 'center', lh: LINE_HEIGHT })).join('');
  c.out.push(spXml(c.slide.id(), name, spPr, body, true));
}

/** Shapes, then arrows, then arrow labels — the order charpie draws them in */
function layoutXml(c: Ctx, l: Layout, t: Tf) {
  for (const n of l.nodes) nodeXml(c, n, t);
  for (const e of l.edges) edgeXml(c, e, t, l.nodeMap);
  for (const e of l.edges) edgeLabelXml(c, e, t);
}

// ───────────── the package ─────────────

function slideXml(c: Ctx): string {
  return (
    XML_HEAD +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    c.out.join('') +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/** The page of a layout: its frame, or the diagram's bounds with a margin (as the other exports) */
function pageBox(l: Layout): Box {
  if (l.frame) return l.frame;
  const b = diagramBounds(l);
  return { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 };
}

/** A .pptx (bytes) with one slide per layout; slides share the size of the first page */
export async function exportPptx(pages: Layout[], opt: PptxOptions): Promise<Uint8Array> {
  const pkg = new Package();
  const page = pageBox(pages[0] ?? { nodes: [], edges: [], nodeMap: new Map(), edgeMap: new Map() });
  const slides = pages.map((l) => {
    const slide = new Slide(pkg);
    const fr = pageBox(l);
    const c: Ctx = { slide, pkg, opt, ids: new Map(), out: [] };
    layoutXml(c, l, { s: 1, dx: -fr.x, dy: -fr.y });
    return { xml: slideXml(c), rels: slide.relsXml() };
  });
  if (pkg.jobs.length) {
    const pngs = await opt.raster(pkg.jobs);
    for (const m of pkg.media) if (m.job !== undefined) m.data = pngs[m.job];
  }
  return zip(packageParts(slides, pkg, { w: page.w, h: page.h }, opt.title ?? ''));
}

function packageParts(slides: { xml: string; rels: string }[], pkg: Package, size: { w: number; h: number }, title: string): ZipEntry[] {
  const n = slides.length;
  const exts = new Set(pkg.media.map((m) => m.name.split('.').pop()!));
  const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml' };
  const ct =
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    [...exts].map((e) => `<Default Extension="${e}" ContentType="${MIME[e]}"/>`).join('') +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>' +
    '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>' +
    '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  const rels = (items: [string, string][]) =>
    XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">` + items.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${type}" Target="${target}"/>`).join('') + '</Relationships>';
  const rootRels =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const presRels = rels([
    [`${REL}/slideMaster`, 'slideMasters/slideMaster1.xml'],
    ...slides.map((_, i): [string, string] => [`${REL}/slide`, `slides/slide${i + 1}.xml`]),
    [`${REL}/presProps`, 'presProps.xml'],
    [`${REL}/viewProps`, 'viewProps.xml'],
    [`${REL}/theme`, 'theme/theme1.xml'],
    [`${REL}/tableStyles`, 'tableStyles.xml'],
  ]);
  const pres =
    XML_HEAD +
    `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst>` +
    `<p:sldSz cx="${emu(size.w)}" cy="${emu(size.h)}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    '<p:defaultTextStyle><a:defPPr><a:defRPr lang="ja-JP"/></a:defPPr></p:defaultTextStyle>' +
    '</p:presentation>';
  const emptyTree =
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
  const master =
    XML_HEAD +
    `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree}</p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles>' +
    '</p:sldMaster>';
  const layout =
    XML_HEAD +
    `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title><dc:creator>Charpie</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app =
    XML_HEAD +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Charpie</Application><Slides>${n}</Slides></Properties>`;
  return [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'ppt/presentation.xml', data: pres },
    { name: 'ppt/_rels/presentation.xml.rels', data: presRels },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([[`${REL}/slideLayout`, '../slideLayouts/slideLayout1.xml'], [`${REL}/theme`, '../theme/theme1.xml']]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([[`${REL}/slideMaster`, '../slideMasters/slideMaster1.xml']]) },
    ...slides.flatMap((s, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, data: s.xml },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: s.rels },
    ]),
    ...pkg.media.map((m) => ({ name: `ppt/media/${m.name}`, data: m.data ?? new Uint8Array() })),
    { name: 'ppt/theme/theme1.xml', data: THEME },
    { name: 'ppt/presProps.xml', data: XML_HEAD + `<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>` },
    {
      name: 'ppt/viewProps.xml',
      data: XML_HEAD + `<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    },
    { name: 'ppt/tableStyles.xml', data: XML_HEAD + `<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
  ];
}

const THEME =
  XML_HEAD +
  `<a:theme xmlns:a="${NS_A}" name="Charpie"><a:themeElements>` +
  '<a:clrScheme name="Charpie"><a:dk1><a:srgbClr val="0F172A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="F1F5F9"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="6366F1"/></a:accent1><a:accent2><a:srgbClr val="0EA5E9"/></a:accent2><a:accent3><a:srgbClr val="10B981"/></a:accent3><a:accent4><a:srgbClr val="F59E0B"/></a:accent4><a:accent5><a:srgbClr val="EF4444"/></a:accent5><a:accent6><a:srgbClr val="8B5CF6"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>' +
  '<a:fontScheme name="Charpie"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface="BIZ UDPGothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="BIZ UDPGothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
  '<a:fmtScheme name="Charpie"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
  '<a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
  '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
