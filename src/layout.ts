import { ancestors, parse } from './dsl/parse';
import type { Doc, EdgeDef, EndPoint, NodeDef, Port, ShapeKind } from './dsl/types';
import {
  center,
  outline,
  pointAlong,
  portPoint,
  rayExit,
  shapePath,
  textBox,
  type Box,
  type Pt,
  type ShapeOpts,
  type TrapDir,
} from './geom/geom';
import { familyMeasure, fitText, richLines, wrap, LINE_HEIGHT, type FitResult, type Measure, type RichLine } from './text/fit';
import { layoutList, layoutTable, parseList, parseTable, type BlockLayout } from './text/blocks';

export interface NodeStyle {
  fill: string;
  stroke: string;
  text: string;
  lw: number;
  dash: 'solid' | 'dashed' | 'dotted';
  font?: number;
  weight: number;
  /** font family (`family=`, else `set family=`; undefined = the default) */
  family?: string;
  opacity: number;
  skew: number;
  radius: number;
  valign: 'top' | 'middle' | 'bottom';
  halign: 'left' | 'center' | 'right';
  /** trap orientation: the short side */
  dir: TrapDir;
  /** per-node text padding (overrides `set padding`) */
  pad?: number;
  /** text rotation in degrees, clockwise (0 | 90 | 180 | 270) */
  rotate: TextRotation;
  /** image: file path (relative to the .charpie file) or URL */
  src?: string;
  /** image: how the picture fills its box */
  fit: ImageFit;
}

export type ImageFit = 'contain' | 'cover' | 'fill';

export type TextRotation = 0 | 90 | 180 | 270;

export interface EdgeStyle {
  stroke: string;
  lw: number;
  dash: 'solid' | 'dashed' | 'dotted';
  route: 'straight' | 'curve' | 'ortho';
  bend: number;
  text: string;
  /** label colour was set explicitly (otherwise the UI may theme it) */
  textExplicit: boolean;
  font: number;
  family?: string;
  /** 0..1 position of the port along its side (fromat= / toat=) */
  fromAt?: number;
  toAt?: number;
}

export interface NodeLayout {
  id: string;
  def: NodeDef;
  kind: ShapeKind;
  box: Box;
  poly: Pt[];
  path: string;
  textBox: Box;
  /** area actually covered by the rendered text */
  textRect: Box;
  style: NodeStyle;
  text: FitResult;
  /** per-line runs when the label has `$...$` formulas */
  rich?: (RichLine | null)[];
  /** table / list: the content laid out (the label is not drawn) */
  blocks?: BlockLayout;
  /** image of another diagram (`src="x.charpie"` / `"x.charpie#page"`): drawn inline, scaled into the box */
  embed?: Embed;
  depth: number;
  parents: string[];
}

export interface EdgeHead {
  tip: Pt;
  angle: number;
}

export interface EdgeLayout {
  key: string;
  def: EdgeDef;
  /** polyline used for hit-testing / collision (curves sampled) */
  pts: Pt[];
  path: string;
  heads: EdgeHead[];
  style: EdgeStyle;
  label?: { box: Box; lines: string[]; size: number; center: Pt; rich?: (RichLine | null)[] };
  selfLoop: boolean;
  /** resolved free ends (written as (x, y) / +(dx, dy)); `base` is what a relative end is measured from */
  free: { from?: { pt: Pt; base?: Pt }; to?: { pt: Pt; base?: Pt } };
}

/** One end of an arrow: a laid-out shape or a free point. */
export type EdgeEnd = NodeLayout | Pt;
const isNode = (x: EdgeEnd): x is NodeLayout => 'poly' in x;
const endBox = (x: EdgeEnd): Box => (isNode(x) ? x.box : { x: x.x, y: x.y, w: 0, h: 0 });

export interface Layout {
  nodes: NodeLayout[];
  nodeMap: Map<string, NodeLayout>;
  edges: EdgeLayout[];
  edgeMap: Map<string, EdgeLayout>;
  /** the page (`set canvas=` / decks): exports cover exactly this box */
  frame?: Box;
}

export const NODE_DEFAULTS: NodeStyle = {
  fill: '#ffffff',
  stroke: '#334155',
  text: '#0f172a',
  lw: 1.5,
  dash: 'solid',
  weight: 500,
  opacity: 1,
  skew: 0.2,
  radius: 12,
  valign: 'middle',
  halign: 'center',
  dir: 'up',
  rotate: 0,
  fit: 'contain',
};

export const EDGE_DEFAULTS: EdgeStyle = {
  stroke: '#64748b',
  lw: 1.5,
  dash: 'solid',
  route: 'straight',
  bend: 0,
  text: '#334155',
  textExplicit: false,
  font: 12,
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : d;
};
const dashOf = (v: string | undefined, d: NodeStyle['dash']): NodeStyle['dash'] => (v === 'dashed' || v === 'dotted' || v === 'solid' ? v : d);

function mergedProps(doc: Doc, classes: string[], attrs: Record<string, string>): Record<string, string> {
  const props: Record<string, string> = {};
  for (const c of classes) Object.assign(props, doc.styles.get(c)?.props ?? {});
  return Object.assign(props, attrs);
}

export function nodeStyle(doc: Doc, n: NodeDef): NodeStyle {
  const p = mergedProps(doc, n.classes, n.attrs);
  // text, image and list shapes have no frame unless one is asked for (a table's stroke colours its rules)
  const isText = n.kind === 'text' || n.kind === 'image' || n.kind === 'list';
  const font = p.font === undefined || p.font === 'auto' ? undefined : num(p.font, NaN);
  return {
    fill: p.fill ?? (isText || n.kind === 'table' ? 'none' : NODE_DEFAULTS.fill),
    stroke: p.stroke ?? (isText ? 'none' : NODE_DEFAULTS.stroke),
    text: p.text ?? NODE_DEFAULTS.text,
    lw: num(p.lw, NODE_DEFAULTS.lw),
    dash: dashOf(p.dash, 'solid'),
    font: font !== undefined && Number.isFinite(font) && font > 0 ? font : undefined,
    weight: p.weight === 'bold' ? 700 : p.weight === 'light' ? 400 : num(p.weight, NODE_DEFAULTS.weight),
    family: familyOf(doc, p),
    opacity: num(p.opacity, 1),
    skew: num(p.skew, NODE_DEFAULTS.skew),
    radius: num(p.radius, NODE_DEFAULTS.radius),
    valign: p.valign === 'top' || p.valign === 'bottom' ? p.valign : 'middle',
    halign: p.halign === 'left' || p.halign === 'right' ? p.halign : 'center',
    dir: p.dir === 'down' || p.dir === 'left' || p.dir === 'right' ? p.dir : 'up',
    pad: p.pad !== undefined && Number.isFinite(Number(p.pad)) && Number(p.pad) >= 0 ? Number(p.pad) : undefined,
    rotate: rotationOf(p.rotate),
    src: p.src || undefined,
    fit: p.fit === 'cover' || p.fit === 'fill' ? p.fit : 'contain',
  };
}

/** `family=` (shape / arrow / style) over `set family=`; `default` goes back to the built-in font. */
function familyOf(doc: Doc, p: Record<string, string>): string | undefined {
  const f = (p.family ?? doc.settings.family)?.trim();
  return f && f !== 'default' ? f : undefined;
}

function rotationOf(v: string | undefined): TextRotation {
  const r = (((Math.round(Number(v) / 90) * 90) % 360) + 360) % 360;
  return v !== undefined && Number.isFinite(r) ? (r as TextRotation) : 0;
}

/**
 * Alignment of lines inside a rotated text block, in the text's own frame.
 * halign / valign are always about the box on screen; along the reading
 * direction they decide where each line starts.
 */
export function lineAnchor(s: NodeStyle): 'left' | 'center' | 'right' {
  const flip = (a: 'top' | 'middle' | 'bottom' | 'left' | 'center' | 'right') =>
    a === 'top' || a === 'left' ? 'left' : a === 'bottom' || a === 'right' ? 'right' : 'center';
  switch (s.rotate) {
    case 0:
      return s.halign;
    case 180:
      return s.halign === 'left' ? 'right' : s.halign === 'right' ? 'left' : 'center';
    case 90: // reads top → bottom
      return flip(s.valign);
    case 270: {
      // reads bottom → top
      const a = flip(s.valign);
      return a === 'left' ? 'right' : a === 'right' ? 'left' : 'center';
    }
  }
}

export function edgeStyle(doc: Doc, e: EdgeDef): EdgeStyle {
  const p = mergedProps(doc, e.classes, e.attrs);
  const route = p.route === 'curve' || p.route === 'ortho' ? p.route : 'straight';
  return {
    stroke: p.stroke ?? EDGE_DEFAULTS.stroke,
    lw: num(p.lw, EDGE_DEFAULTS.lw),
    dash: dashOf(p.dash, 'solid'),
    route,
    bend: num(p.bend, route === 'curve' ? 40 : 0),
    text: p.text ?? EDGE_DEFAULTS.text,
    textExplicit: p.text !== undefined,
    font: num(p.font, EDGE_DEFAULTS.font),
    family: familyOf(doc, p),
    fromAt: p.fromat !== undefined && Number.isFinite(Number(p.fromat)) ? Number(p.fromat) : undefined,
    toAt: p.toat !== undefined && Number.isFinite(Number(p.toat)) ? Number(p.toat) : undefined,
  };
}

export function layoutNode(doc: Doc, n: NodeDef, measureAny: Measure, geomOverride?: Box): NodeLayout {
  const style = nodeStyle(doc, n);
  const measure = familyMeasure(measureAny, style.family);
  const box = geomOverride ?? { x: n.x, y: n.y, w: n.w, h: n.h };
  const o: ShapeOpts = { skew: style.skew, radius: style.radius, dir: style.dir };
  const tb = textBox(n.kind, box, o, style.pad ?? doc.settings.padding);
  if (n.kind === 'table' || n.kind === 'list') return layoutBlockNode(doc, n, measure, box, tb, style, o);
  const sideways = style.rotate === 90 || style.rotate === 270;
  // an image's label is only its alt text: it is not drawn, so it never has to fit
  const text = fitText(n.kind === 'image' ? '' : n.label, sideways ? { w: tb.h, h: tb.w } : tb, {
    fixed: style.font,
    min: doc.settings.fontmin,
    max: doc.settings.fontmax,
    weight: style.weight,
    measure,
  });
  const parents = ancestors(doc, n.id);
  // on-screen extent of the text block
  const rw = sideways ? text.height : text.width,
    rh = sideways ? text.width : text.height;
  const ty = style.valign === 'top' ? tb.y : style.valign === 'bottom' ? tb.y + tb.h - rh : tb.y + (tb.h - rh) / 2;
  const tx = style.halign === 'left' ? tb.x : style.halign === 'right' ? tb.x + tb.w - rw : tb.x + (tb.w - rw) / 2;
  const textRect = { x: tx, y: ty, w: rw, h: rh };
  return {
    id: n.id,
    def: n,
    kind: n.kind,
    box,
    poly: outline(n.kind, box, o),
    path: shapePath(n.kind, box, o),
    textBox: tb,
    textRect,
    style,
    text,
    rich: richLines(text.lines, text.size, style.weight, measure),
    depth: parents.length,
    parents,
  };
}

const positive = (v: string | undefined) => (v !== undefined && Number(v) > 0 ? Number(v) : undefined);
const nonNegative = (v: string | undefined) => (v !== undefined && v !== '' && Number(v) >= 0 ? Number(v) : undefined);

/** table / list: the body fitted into the text area at one font size. */
function layoutBlockNode(doc: Doc, n: NodeDef, measure: Measure, box: Box, tb: Box, style: NodeStyle, o: ShapeOpts): NodeLayout {
  const body = n.body?.text ?? '';
  const p = mergedProps(doc, n.classes, n.attrs);
  // a block hugs the top-left unless placed explicitly
  const opts = {
    fixed: style.font,
    min: doc.settings.fontmin,
    max: doc.settings.fontmax,
    weight: style.weight,
    measure,
    valign: p.valign ? style.valign : undefined,
    halign: p.halign ? style.halign : undefined,
    lineheight: positive(p.lineheight),
  };
  const blocks =
    n.kind === 'table'
      ? layoutTable(parseTable(body, p, (c) => doc.styles.get(c)?.props), tb, {
          ...opts,
          cols: p.cols
            ?.split(',')
            .map(Number)
            .filter((x) => x > 0),
          rules: p.rules === 'grid' || p.rules === 'none' ? p.rules : 'booktabs',
        })
      : layoutList(parseList(body), tb, {
          ...opts,
          levelscale: p.levelscale
            ?.split(',')
            .map(Number)
            .filter((x) => x > 0),
          itemgap: nonNegative(p.itemgap),
          indent: nonNegative(p.indent),
          markgap: nonNegative(p.markgap),
        });
  const parents = ancestors(doc, n.id);
  return {
    id: n.id,
    def: n,
    kind: n.kind,
    box,
    poly: outline(n.kind, box, o),
    path: shapePath(n.kind, box, o),
    textBox: tb,
    textRect: { x: blocks.x, y: blocks.y, w: blocks.width, h: blocks.height },
    style,
    text: { size: blocks.size, lines: [], width: blocks.width, height: blocks.height, overflow: blocks.overflow, auto: style.font === undefined },
    blocks,
    depth: parents.length,
    parents,
  };
}

/**
 * Smallest box (whole px) that still holds the label as written — explicit line breaks only — at the
 * node's current font size. Uses the same tolerances as fitText, so one pixel less no longer fits.
 */
export function fitSize(doc: Doc, l: NodeLayout, measureAny: Measure): { w: number; h: number } {
  const { style, kind } = l;
  const measure = familyMeasure(measureAny, style.family);
  if (l.blocks) {
    // table / list: the content's extent at the current size (lists reflow, so this is a lower bound)
    const pad = style.pad ?? doc.settings.padding;
    return { w: Math.ceil(l.blocks.width + pad * 2), h: Math.ceil(l.blocks.height + pad * 2 + 0.5) };
  }
  const size = l.text.size;
  const r = wrap(l.def.label, size, Infinity, style.weight, measure);
  const lineW = r.width,
    blockH = r.lines.length * size * LINE_HEIGHT;
  const sideways = style.rotate === 90 || style.rotate === 270;
  // a line must not wrap (+0.01, as in wrap); the block may poke out by half a pixel (as in fitText)
  const needW = sideways ? blockH : lineW,
    tolW = sideways ? 0.5 : 0.01;
  const needH = sideways ? lineW : blockH,
    tolH = sideways ? 0.01 : 0.5;
  const o: ShapeOpts = { skew: style.skew, radius: style.radius, dir: style.dir };
  const pad = style.pad ?? doc.settings.padding;
  const area = (w: number, h: number) => textBox(kind, { x: 0, y: 0, w, h }, o, pad);
  // the text height never depends on the width; the width can depend on the height (hex), so h goes first
  const h = least((v) => area(l.box.w, v).h + tolH >= needH);
  const w = least((v) => area(v, h).w + tolW >= needW);
  return { w, h };
}

/** Least positive integer satisfying a monotone predicate. */
function least(ok: (v: number) => boolean): number {
  let hi = 1;
  while (!ok(hi) && hi < 1e6) hi *= 2;
  let lo = 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function headLen(lw: number) {
  return 7 + lw * 2.2;
}

/** Auto-pick ports for orthogonal routing. */
function autoPorts(a: Box, b: Box): [Port, Port] {
  const ca = center(a),
    cb = center(b);
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  if (gapX >= gapY) return cb.x >= ca.x ? ['e', 'w'] : ['w', 'e'];
  return cb.y >= ca.y ? ['s', 'n'] : ['n', 's'];
}

const horiz = (p: Port) => p === 'e' || p === 'w';

function orthoPoints(p1: Pt, s1: Port, p2: Pt, s2: Port): Pt[] {
  const stub = 16;
  const out = (p: Pt, s: Port, d: number): Pt => ({ x: p.x + (s === 'e' ? d : s === 'w' ? -d : 0), y: p.y + (s === 's' ? d : s === 'n' ? -d : 0) });
  let pts: Pt[];
  if (s1 === s2) {
    // U-route: go out past both ends on the same side
    if (horiz(s1)) {
      const x = s1 === 'e' ? Math.max(p1.x, p2.x) + stub * 1.5 : Math.min(p1.x, p2.x) - stub * 1.5;
      pts = [p1, { x, y: p1.y }, { x, y: p2.y }, p2];
    } else {
      const y = s1 === 's' ? Math.max(p1.y, p2.y) + stub * 1.5 : Math.min(p1.y, p2.y) - stub * 1.5;
      pts = [p1, { x: p1.x, y }, { x: p2.x, y }, p2];
    }
  } else if (horiz(s1) && horiz(s2)) {
    const ok = s1 === 'e' ? p2.x > p1.x : p2.x < p1.x;
    if (ok && s1 !== s2) {
      const mx = (p1.x + p2.x) / 2;
      pts = [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
    } else {
      const a = out(p1, s1, stub),
        b = out(p2, s2, stub);
      const my = (p1.y + p2.y) / 2;
      pts = [p1, a, { x: a.x, y: my }, { x: b.x, y: my }, b, p2];
    }
  } else if (!horiz(s1) && !horiz(s2)) {
    const ok = s1 === 's' ? p2.y > p1.y : p2.y < p1.y;
    if (ok && s1 !== s2) {
      const my = (p1.y + p2.y) / 2;
      pts = [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
    } else {
      const a = out(p1, s1, stub),
        b = out(p2, s2, stub);
      const mx = (p1.x + p2.x) / 2;
      pts = [p1, a, { x: mx, y: a.y }, { x: mx, y: b.y }, b, p2];
    }
  } else if (horiz(s1)) {
    pts = [p1, { x: p2.x, y: p1.y }, p2];
  } else {
    pts = [p1, { x: p1.x, y: p2.y }, p2];
  }
  // drop duplicate / collinear points
  const clean: Pt[] = [];
  for (const p of pts) {
    const l = clean[clean.length - 1];
    if (l && Math.abs(l.x - p.x) < 0.01 && Math.abs(l.y - p.y) < 0.01) continue;
    clean.push(p);
  }
  for (let i = clean.length - 2; i > 0; i--) {
    const a = clean[i - 1],
      b = clean[i],
      c = clean[i + 1];
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) clean.splice(i, 1);
  }
  return clean;
}

function roundedPolylinePath(pts: Pt[], r: number): string {
  if (pts.length < 3) return 'M' + pts.map((p) => `${p.x} ${p.y}`).join('L');
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1],
      b = pts[i],
      c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y),
      l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p1 = { x: b.x + ((a.x - b.x) / l1) * rr, y: b.y + ((a.y - b.y) / l1) * rr };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * rr, y: b.y + ((c.y - b.y) / l2) * rr };
    d += `L${p1.x} ${p1.y}Q${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${last.x} ${last.y}`;
}

/** Shorten the polyline ends so the stroke doesn't poke through arrowheads. */
function trimEnds(pts: Pt[], start: number, end: number): Pt[] {
  const out = pts.map((p) => ({ ...p }));
  const trim = (i: number, j: number, d: number) => {
    const a = out[i],
      b = out[j];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l < 1e-6) return;
    const k = Math.min(d, l * 0.9) / l;
    a.x += (b.x - a.x) * k;
    a.y += (b.y - a.y) * k;
  };
  if (start) trim(0, 1, start);
  if (end) trim(out.length - 1, out.length - 2, end);
  return out;
}

export function layoutEdge(doc: Doc, e: EdgeDef, a: EdgeEnd, b: EdgeEnd, measureAny: Measure, free: EdgeLayout['free'] = {}): EdgeLayout {
  const style = edgeStyle(doc, e);
  const measure = familyMeasure(measureAny, style.family);
  const ca = center(endBox(a)),
    cb = center(endBox(b));
  let pts: Pt[];
  let path: string;
  let samples: Pt[];
  const selfLoop = isNode(a) && isNode(b) && a.id === b.id;
  /** where the line meets an end: a port, the outline towards `toward`, or the point itself */
  const attach = (end: EdgeEnd, port: Port | undefined, at: number | undefined, toward: Pt): Pt =>
    !isNode(end) ? end : port ? portPoint(end.poly, end.box, port, at) : rayExit(end.poly, center(end.box), toward);

  if (selfLoop) {
    const n = a as NodeLayout;
    const p1 = portPoint(n.poly, n.box, 'e');
    const p2 = portPoint(n.poly, n.box, 'n');
    const r = 28;
    pts = [p1, { x: p1.x + r, y: p1.y }, { x: p1.x + r, y: p2.y - r }, { x: p2.x, y: p2.y - r }, p2];
    samples = pts;
  } else if (style.route === 'ortho') {
    const [d1, d2] = autoPorts(endBox(a), endBox(b));
    const s1 = e.fromPort ?? d1,
      s2 = e.toPort ?? d2;
    const p1 = isNode(a) ? portPoint(a.poly, a.box, s1, style.fromAt) : a;
    const p2 = isNode(b) ? portPoint(b.poly, b.box, s2, style.toAt) : b;
    pts = orthoPoints(p1, s1, p2, s2);
    samples = pts;
  } else if (style.bend !== 0) {
    const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2 };
    const dx = cb.x - ca.x,
      dy = cb.y - ca.y;
    const len = Math.hypot(dx, dy) || 1;
    // control point so that the curve's apex is `bend` px from the chord
    const ctrl = { x: mid.x + (-dy / len) * style.bend * 2, y: mid.y + (dx / len) * style.bend * 2 };
    const p1 = attach(a, e.fromPort, style.fromAt, ctrl);
    const p2 = attach(b, e.toPort, style.toAt, ctrl);
    samples = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24,
        u = 1 - t;
      samples.push({ x: u * u * p1.x + 2 * u * t * ctrl.x + t * t * p2.x, y: u * u * p1.y + 2 * u * t * ctrl.y + t * t * p2.y });
    }
    pts = samples;
  } else {
    const p1 = attach(a, e.fromPort, style.fromAt, isNode(b) && e.toPort ? portPoint(b.poly, b.box, e.toPort, style.toAt) : cb);
    const p2 = attach(b, e.toPort, style.toAt, p1);
    pts = [p1, p2];
    samples = pts;
  }

  const hl = headLen(style.lw);
  const startHead = e.op === '<-' || e.op === '<->';
  const endHead = e.op === '->' || e.op === '<->';
  const heads: EdgeHead[] = [];
  if (endHead) {
    const n = samples.length;
    const p = samples[n - 1],
      q = samples[n - 2];
    heads.push({ tip: p, angle: Math.atan2(p.y - q.y, p.x - q.x) });
  }
  if (startHead) {
    const p = samples[0],
      q = samples[1];
    heads.push({ tip: p, angle: Math.atan2(p.y - q.y, p.x - q.x) });
  }
  const drawn = trimEnds(samples, startHead ? hl * 0.8 : 0, endHead ? hl * 0.8 : 0);
  if (style.route === 'ortho' || selfLoop) path = roundedPolylinePath(drawn, 8);
  else if (drawn.length > 2) path = 'M' + drawn.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('L');
  else path = `M${drawn[0].x} ${drawn[0].y}L${drawn[1].x} ${drawn[1].y}`;

  let label: EdgeLayout['label'];
  if (e.label) {
    const size = style.font;
    const r = wrap(e.label, size, 220, 500, measure);
    const w = r.width + 12,
      h = r.lines.length * size * LINE_HEIGHT + 6;
    const { p } = pointAlong(samples, 0.5);
    label = { box: { x: p.x - w / 2, y: p.y - h / 2, w, h }, lines: r.lines, size, center: p, rich: richLines(r.lines, size, 500, measure) };
  }

  return { key: e.key, def: e, pts: samples, path, heads, style, label, selfLoop, free };
}

export function arrowHeadPath(h: EdgeHead, lw: number): string {
  const L = headLen(lw),
    W = L * 0.42;
  const { tip, angle } = h;
  const cos = Math.cos(angle),
    sin = Math.sin(angle);
  const bx = tip.x - cos * L,
    by = tip.y - sin * L;
  const lx = bx - sin * W,
    ly = by + cos * W;
  const rx = bx + sin * W,
    ry = by - cos * W;
  const nx = tip.x - cos * L * 0.78,
    ny = tip.y - sin * L * 0.78;
  return `M${tip.x} ${tip.y}L${lx} ${ly}L${nx} ${ny}L${rx} ${ry}Z`;
}

/**
 * Resolve both ends of an arrow. A relative end `+(dx, dy)` is measured from the other
 * end: its port if one is given, else the shape's centre (or the other point).
 */
export function edgeEnds(doc: Doc, e: EdgeDef, nodeMap: Map<string, NodeLayout>): { a: EdgeEnd; b: EdgeEnd; free: EdgeLayout['free'] } | undefined {
  const fixed = (id: string, pt: EndPoint | undefined): EdgeEnd | undefined => (pt ? (pt.rel ? undefined : { x: pt.x, y: pt.y }) : nodeMap.get(id));
  let a = fixed(e.from, e.fromPt),
    b = fixed(e.to, e.toPt);
  const anchor = (end: EdgeEnd | undefined, port: Port | undefined, at: number | undefined): Pt | undefined =>
    !end ? undefined : !isNode(end) ? end : port ? portPoint(end.poly, end.box, port, at) : center(end.box);
  const free: EdgeLayout['free'] = {};
  const st = edgeStyle(doc, e);
  if (e.fromPt?.rel) {
    const base = anchor(b, e.toPort, st.toAt);
    if (!base) return undefined;
    a = { x: base.x + e.fromPt.x, y: base.y + e.fromPt.y };
    free.from = { pt: a, base };
  } else if (e.fromPt) free.from = { pt: a as Pt };
  if (e.toPt?.rel) {
    const base = anchor(a, e.fromPort, st.fromAt);
    if (!base) return undefined;
    b = { x: base.x + e.toPt.x, y: base.y + e.toPt.y };
    free.to = { pt: b, base };
  } else if (e.toPt) free.to = { pt: b as Pt };
  if (!a || !b) return undefined;
  return { a, b, free };
}

// ───────────────────────── embedded diagrams ─────────────────────────

export interface Embed {
  layout: Layout;
  /** maps the embedded diagram into the shape's box */
  scale: number;
  dx: number;
  dy: number;
  /** the embedded diagram's own extent (its page, or its bounds) */
  view: Box;
}

/**
 * Finds the text of a `.charpie` named in `src=`. `base` is the file the src is relative to
 * (undefined for the top level); it returns that text and the new base for nested embeds.
 */
export type EmbedResolver = (src: string, base: string | undefined) => { text: string; base: string } | undefined;
let resolver: EmbedResolver | undefined;
let embedBase: string | undefined;
let embedDepth = 0;

/** Set how embedded diagrams are found (server: files on disk; browser: fetched and cached). */
export function setEmbedResolver(r: EmbedResolver | undefined, base?: string) {
  resolver = r;
  embedBase = base;
}

/** Run `fn` with the top-level file for relative `src=` paths. */
export function withEmbedBase<T>(base: string | undefined, fn: () => T): T {
  const prev = embedBase;
  embedBase = base;
  try {
    return fn();
  } finally {
    embedBase = prev;
  }
}

export const isDiagramSrc = (src: string | undefined) => !!src && /\.charpie(#[^#]*)?$/i.test(src);

function layoutEmbed(n: NodeLayout, measure: Measure): Embed | undefined {
  const src = n.style.src;
  if (!resolver || !isDiagramSrc(src) || embedDepth >= 4) return undefined;
  const [file, page] = src!.split('#');
  const found = resolver(file, embedBase);
  if (!found) return undefined;
  const prev = embedBase;
  embedBase = found.base;
  embedDepth++;
  try {
    const layout = computeLayout(parse(found.text, page ? { page } : undefined), measure);
    // its pictures are relative to it: make them relative to the file that embeds it
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    if (dir) rebaseImages(layout, dir);
    const view = layout.frame ?? boundsOf(layout);
    const b = n.box;
    const sx = b.w / Math.max(1, view.w),
      sy = b.h / Math.max(1, view.h);
    const scale = n.style.fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
    return { layout, scale, view, dx: b.x + (b.w - view.w * scale) / 2 - view.x * scale, dy: b.y + (b.h - view.h * scale) / 2 - view.y * scale };
  } finally {
    embedDepth--;
    embedBase = prev;
  }
}

/** `dir/src` with `.` / `..` resolved (relative paths only; URLs and absolute paths stay). */
function joinPath(dir: string, src: string): string {
  if (/^(https?:|data:|\/)/.test(src)) return src;
  const parts: string[] = [];
  for (const p of `${dir}/${src}`.split('/')) {
    if (p === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

/** Prefix the `src=` of pictures (also in nested embeds) with `dir`. */
function rebaseImages(layout: Layout, dir: string) {
  for (const n of layout.nodes) {
    if (n.kind !== 'image') continue;
    if (n.embed) rebaseImages(n.embed.layout, dir);
    else if (n.style.src && !isDiagramSrc(n.style.src)) n.style = { ...n.style, src: joinPath(dir, n.style.src) };
  }
}

/** Extent of shapes, arrows and labels (with a little margin). */
export function boundsOf(layout: Layout): Box {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  const add = (x: number, y: number) => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  };
  for (const n of layout.nodes) {
    add(n.box.x - n.style.lw, n.box.y - n.style.lw);
    add(n.box.x + n.box.w + n.style.lw, n.box.y + n.box.h + n.style.lw);
  }
  for (const e of layout.edges) {
    for (const p of e.pts) add(p.x, p.y);
    if (e.label) {
      add(e.label.box.x, e.label.box.y);
      add(e.label.box.x + e.label.box.w, e.label.box.y + e.label.box.h);
    }
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 400, h: 300 };
  const m = 8;
  return { x: x1 - m, y: y1 - m, w: x2 - x1 + m * 2, h: y2 - y1 + m * 2 };
}

export function computeLayout(doc: Doc, measure: Measure, overrides?: Map<string, Box>): Layout {
  const nodes = doc.nodes.map((n) => layoutNode(doc, n, measure, overrides?.get(n.id)));
  for (const n of nodes) if (n.kind === 'image' && isDiagramSrc(n.style.src)) n.embed = layoutEmbed(n, measure);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edges: EdgeLayout[] = [];
  for (const e of doc.edges) {
    const ends = edgeEnds(doc, e, nodeMap);
    if (ends) edges.push(layoutEdge(doc, e, ends.a, ends.b, measure, ends.free));
  }
  // paint order: containers first, then the page's layout, then declaration order
  nodes.sort((p, q) => p.depth - q.depth || Number(!p.def.locked) - Number(!q.def.locked) || p.def.line - q.def.line);
  const frame = doc.canvas && { x: 0, y: 0, w: doc.canvas.w, h: doc.canvas.h };
  return { nodes, nodeMap, edges, edgeMap: new Map(edges.map((e) => [e.key, e])), frame };
}
