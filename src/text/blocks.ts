/**
 * Shapes whose content is a block of lines instead of a label: `table` (Markdown-style rows)
 * and `list` (bullets). Both lay out into positioned text pieces + rule lines, fitted to the box
 * at one font size (the largest that fits, between fontmin and fontmax, or a fixed `font=`).
 */
import { LINE_HEIGHT, richLines, wrap, type Measure, type RichLine } from './fit';
import { boldClose } from './inline';

export interface TextPiece {
  /** anchor x (left / centre / right edge depending on `anchor`) and top of the first line */
  x: number;
  y: number;
  w: number;
  anchor: 'left' | 'center' | 'right';
  lines: string[];
  rich?: (RichLine | null)[];
  size: number;
  weight: number;
  /** text colour (default: the shape's `text=`) */
  color?: string;
  /** line height as a multiple of `size` (default LINE_HEIGHT) */
  lh?: number;
  /** index of the slot (table cell / list item) this text belongs to; a list's number marker has none */
  slot?: number;
}

export interface Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lw: number;
}

/** A filled background (table rows / cells), drawn under the text and rules. */
export interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** A list bullet drawn as a shape (same in every font and export): ● disc, ○ circle, ■ square. */
export interface Mark {
  kind: 'disc' | 'circle' | 'square';
  cx: number;
  cy: number;
  /** radius / half side */
  r: number;
}

/** Where the text of a list item / table cell sits, for editing it in place. */
export interface BlockSlot {
  /** list: item index; table: row */
  row: number;
  /** table: first column (and the columns it covers); list: 0 / 1 */
  col: number;
  span: number;
  /** the area the text wraps in: left edge, top, width, height (table: the row's height) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** table: the whole cell */
  cell?: Box;
  align: 'left' | 'center' | 'right';
  size: number;
  /** weight of the text outside `**` spans */
  weight: number;
  color?: string;
  /** line height as a multiple of `size` */
  lh: number;
  /** list: a numbered item's marker, drawn from `x` */
  marker?: { x: number; text: string };
}

export interface BlockLayout {
  pieces: TextPiece[];
  rules: Rule[];
  fills: Fill[];
  marks: Mark[];
  slots: BlockSlot[];
  size: number;
  overflow: boolean;
  /** area covered by the content (top-left, size) */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockOpts {
  fixed?: number;
  min: number;
  max: number;
  weight: number;
  measure: Measure;
  /** where the content sits when it is smaller than the box (only when written: `valign=` / `halign=`) */
  valign?: 'top' | 'middle' | 'bottom';
  halign?: 'left' | 'center' | 'right';
  /** `lineheight=`: line height as a multiple of the font size (default LINE_HEIGHT) */
  lineheight?: number;
}

const empty = (o: BlockOpts, box: Box): BlockLayout => ({ pieces: [], rules: [], fills: [], marks: [], slots: [], size: o.fixed ?? o.max, overflow: false, x: box.x, y: box.y, width: 0, height: 0 });

/** Largest half-pixel size in [min, max] for which `at(size)` fits (or the fixed size). */
function fitSize(o: BlockOpts, at: (size: number) => BlockLayout): BlockLayout {
  if (o.fixed !== undefined) return at(o.fixed);
  const min = Math.max(1, Math.min(o.min, o.max));
  let lo = Math.round(min * 2),
    hi = Math.round(o.max * 2);
  const top = at(hi / 2);
  if (!top.overflow) return top;
  let best: BlockLayout | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = at(mid / 2);
    if (!r.overflow) {
      best = r;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best ?? at(min);
}

/** Moves the content inside the box by `valign` / `halign` (when it is smaller than the box). */
function place(b: BlockLayout, box: Box, o: BlockOpts): BlockLayout {
  const room = (free: number, a: 'start' | 'middle' | 'end') => (free <= 0 ? 0 : a === 'middle' ? free / 2 : a === 'end' ? free : 0);
  const dy = room(box.h - b.height, o.valign === 'middle' ? 'middle' : o.valign === 'bottom' ? 'end' : 'start');
  const dx = room(box.w - b.width, o.halign === 'center' ? 'middle' : o.halign === 'right' ? 'end' : 'start');
  if (!dx && !dy) return b;
  return {
    ...b,
    x: b.x + dx,
    y: b.y + dy,
    pieces: b.pieces.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    rules: b.rules.map((r) => ({ ...r, x1: r.x1 + dx, x2: r.x2 + dx, y1: r.y1 + dy, y2: r.y2 + dy })),
    fills: b.fills.map((f) => ({ ...f, x: f.x + dx, y: f.y + dy })),
    marks: b.marks.map((m) => ({ ...m, cx: m.cx + dx, cy: m.cy + dy })),
    slots: b.slots.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy, ...(t.cell ? { cell: { ...t.cell, x: t.cell.x + dx, y: t.cell.y + dy } } : {}), ...(t.marker ? { marker: { ...t.marker, x: t.marker.x + dx } } : {}) })),
  };
}

/** `**text**` → bold text (whole cell / item only; inner `**` spans stay inline markup). */
function strong(s: string): { text: string; bold: boolean } {
  const t = s.trim();
  const m = /^\*\*(.+)\*\*$/.exec(t);
  return m && boldClose(m[1], 0) < 0 && !m[1].endsWith('\\') ? { text: m[1], bold: true } : { text: t, bold: false };
}

const lineW = (lines: string[], size: number, weight: number, measure: Measure) => Math.max(0, ...lines.map((l) => wrap(l, size, Infinity, weight, measure).width));

// ───────────────────────────── table ─────────────────────────────

/** Formatting of a cell or a row: `{fill=#eee text=#666 weight=bold scale=0.85 indent=1 align=l .class}`. */
export interface CellStyle {
  fill?: string;
  /** text colour (`text=` in the block) */
  color?: string;
  weight?: number;
  /** text size relative to the table's size */
  scale?: number;
  /** extra left inset, in em */
  indent?: number;
  align?: 'l' | 'c' | 'r';
}

export interface TableCell extends CellStyle {
  text: string;
  /** columns this cell covers (`||` after a cell widens it by one) */
  span: number;
}

export interface TableRow {
  cells: TableCell[];
  /** row background */
  fill?: string;
}

export interface TableSpec {
  rows: TableRow[];
  /** header rows (bold, rule below) */
  header: number;
  /** per column: l / c / r */
  align: ('l' | 'c' | 'r')[];
}

/** `style` lookup for `.class` inside `{...}` (the diagram's styles). */
export type StyleLookup = (name: string) => Record<string, string> | undefined;

const ATTR = String.raw`(?:\.[\w-]+|[\w-]+=(?:"[^"]*"|[^\s{}"]+))`;
const ATTR_BLOCK = new RegExp(String.raw`\s*\{\s*(${ATTR}(?:\s+${ATTR})*)\s*\}\s*$`);

/** A trailing `{...}` attribute block, split off the text (`undefined` when there is none). */
function trailingAttrs(s: string): { rest: string; attrs: Record<string, string>; classes: string[] } | undefined {
  const m = ATTR_BLOCK.exec(s);
  if (!m) return undefined;
  // a `{...}` inside a formula is TeX
  const before = s.slice(0, m.index);
  if ((before.match(/(?<!\\)\$/g)?.length ?? 0) % 2) return undefined;
  const attrs: Record<string, string> = {};
  const classes: string[] = [];
  for (const a of m[1].match(new RegExp(ATTR, 'g')) ?? []) {
    if (a.startsWith('.')) classes.push(a.slice(1));
    else {
      const k = a.slice(0, a.indexOf('='));
      attrs[k] = a.slice(k.length + 1).replace(/^"(.*)"$/, '$1');
    }
  }
  return { rest: before, attrs, classes };
}

function cellStyle(attrs: Record<string, string>, classes: string[], styles: StyleLookup): CellStyle {
  const p: Record<string, string> = {};
  for (const c of classes) Object.assign(p, styles(c) ?? {});
  Object.assign(p, attrs);
  const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const out: CellStyle = {};
  if (p.fill && p.fill !== 'none') out.fill = p.fill;
  if (p.text) out.color = p.text;
  if (p.weight) out.weight = p.weight === 'bold' ? 700 : p.weight === 'light' ? 400 : p.weight === 'normal' ? 500 : num(p.weight);
  const sc = num(p.scale);
  if (sc !== undefined && sc > 0) out.scale = sc;
  const ind = num(p.indent);
  if (ind !== undefined && ind >= 0) out.indent = ind;
  const al = p.align?.[0];
  if (al === 'l' || al === 'c' || al === 'r') out.align = al;
  return out;
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Markdown-style rows: `| a | b |`; a `|---|:--:|` line marks the rows above it as header and sets alignment.
 * `||` (nothing between the pipes) makes the cell before it span one more column. A `{...}` at the end
 * of a cell styles that cell; one after the last `|` styles the row (its `fill` paints the whole row,
 * its `indent` indents the first cell, the rest are defaults for every cell).
 */
export function parseTable(body: string, attrs: Record<string, string>, styles: StyleLookup = () => undefined): TableSpec {
  const rows: TableRow[] = [];
  let header = -1;
  let align: ('l' | 'c' | 'r')[] = [];
  for (const raw of body.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('# ') || line.startsWith('//')) continue;
    let rowStyle: CellStyle = {};
    const ra = line.includes('|') ? trailingAttrs(line) : undefined;
    if (ra && /\|\s*$/.test(ra.rest)) {
      rowStyle = cellStyle(ra.attrs, ra.classes, styles);
      line = ra.rest.trim();
    }
    const raws = splitRow(line);
    if (raws.every((c) => /^:?-+:?$/.test(c.trim()))) {
      if (header < 0) header = rows.length;
      align = raws.map((c) => c.trim()).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l'));
      continue;
    }
    const { fill, indent, ...inherit } = rowStyle;
    const cells: TableCell[] = [];
    for (const r of raws) {
      if (r === '' && cells.length) {
        cells[cells.length - 1].span++;
        continue;
      }
      const a = trailingAttrs(r);
      const own = a ? cellStyle(a.attrs, a.classes, styles) : {};
      const first = !cells.length && indent !== undefined ? { indent } : {};
      cells.push({ ...inherit, ...first, ...defined(own), text: (a ? a.rest : r).trim(), span: 1 });
    }
    rows.push({ cells, ...(fill ? { fill } : {}) });
  }
  const width = (r: TableRow) => r.cells.reduce((a, c) => a + c.span, 0);
  const ncol = Math.max(0, ...rows.map(width));
  for (const r of rows) for (let k = width(r); k < ncol; k++) r.cells.push({ text: '', span: 1 });
  const fromAttr = (attrs.align ?? '').split(',').map((a) => a.trim()[0]).filter(Boolean) as ('l' | 'c' | 'r')[];
  const al = Array.from({ length: ncol }, (_, i) => fromAttr[i] ?? align[i] ?? 'c');
  const h = attrs.header !== undefined ? Math.max(0, Number(attrs.header) || 0) : header >= 0 ? header : Math.min(1, rows.length);
  return { rows, header: h, align: al.map((a) => (a === 'l' || a === 'r' ? a : 'c')) };
}

/** Cells of a row as written (untrimmed: an empty string is `||`). */
function splitRow(line: string): string[] {
  let s = line;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  let math = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '$') {
      math = !math;
      cur += c;
    } else if (c === '|' && !math) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** `cols=2,1,1`: relative column widths (default: from the content). */
export function layoutTable(spec: TableSpec, box: Box, o: BlockOpts & { cols?: number[]; rules: 'booktabs' | 'grid' | 'none' }): BlockLayout {
  const nrow = spec.rows.length;
  const ncol = spec.align.length;
  if (!nrow || !ncol) return empty(o, box);
  const cells = spec.rows.map((r, ri) => {
    let col = 0;
    return r.cells.map((c) => {
      const s = strong(c.text);
      const out = { ...c, ...s, col, head: ri < spec.header, align: c.align ?? spec.align[col] };
      col += c.span;
      return out;
    });
  });
  type Cell = (typeof cells)[number][number];
  const baseWeight = (c: Cell) => (c.head && c.weight === undefined ? 700 : (c.weight ?? o.weight));
  const weightOf = (c: Cell) => (c.bold ? 700 : baseWeight(c));

  const at = (size: number): BlockLayout => {
    const padX = size * 0.6,
      padY = size * 0.3;
    const inset = (c: Cell) => padX * 2 + (c.indent ?? 0) * size;
    const natW = (c: Cell) => lineW(c.text.split('\n'), size * (c.scale ?? 1), weightOf(c), o.measure) + inset(c);
    // column widths: given ratios, or the content's natural widths (shrunk when they don't fit)
    const natural = Array.from({ length: ncol }, (_, j) => Math.max(0, ...cells.flatMap((r) => r.filter((c) => c.col === j && c.span === 1).map(natW))));
    // a spanning cell wider than its columns widens them evenly
    for (const r of cells)
      for (const c of r) {
        if (c.span === 1) continue;
        const have = natural.slice(c.col, c.col + c.span).reduce((a, b) => a + b, 0);
        const need = natW(c);
        if (need > have) for (let j = c.col; j < c.col + c.span; j++) natural[j] += (need - have) / c.span;
      }
    const ratios = o.cols && o.cols.length ? Array.from({ length: ncol }, (_, j) => o.cols![j] ?? o.cols![o.cols!.length - 1]) : natural;
    const sum = ratios.reduce((a, b) => a + b, 0) || 1;
    let widths: number[];
    if (!o.cols?.length && natural.reduce((a, b) => a + b, 0) <= box.w) {
      // room to spare: share it out evenly so short columns don't look cramped
      const extra = (box.w - natural.reduce((a, b) => a + b, 0)) / ncol;
      widths = natural.map((w) => w + extra);
    } else widths = ratios.map((r) => (r / sum) * box.w);
    const xs = [box.x];
    for (const w of widths) xs.push(xs[xs.length - 1] + w);

    let overflow = false;
    const laid = cells.map((r) =>
      r.map((c) => {
        const inner = Math.max(1, xs[c.col + c.span] - xs[c.col] - inset(c));
        const s = size * (c.scale ?? 1);
        const wr = wrap(c.text, s, inner, weightOf(c), o.measure);
        if (wr.broke) overflow = true;
        return { c, lines: c.text ? wr.lines : [], weight: weightOf(c), size: s };
      }),
    );
    const LH = o.lineheight ?? LINE_HEIGHT;
    const rowH = laid.map((r) => Math.max(size * LH, ...r.map((c) => c.lines.length * c.size * LH)) + padY * 2);
    const total = rowH.reduce((a, b) => a + b, 0);
    if (total > box.h + 0.5) overflow = true;
    // spare height goes evenly to the rows (unless the table is placed with valign=)
    const extraH = o.valign ? 0 : Math.max(0, (box.h - total) / nrow);
    const height = o.valign ? total : Math.max(total, box.h);
    const pieces: TextPiece[] = [];
    const rules: Rule[] = [];
    const fills: Fill[] = [];
    const slots: BlockSlot[] = [];
    let y = box.y;
    laid.forEach((r, i) => {
      const h = rowH[i] + extraH;
      const fill = spec.rows[i].fill;
      if (fill) fills.push({ x: box.x, y, w: box.w, h, fill });
      r.forEach(({ c, lines, weight, size: s }) => {
        const x1 = xs[c.col],
          x2 = xs[c.col + c.span];
        if (c.fill) fills.push({ x: x1, y, w: x2 - x1, h, fill: c.fill });
        const a = c.align;
        const anchor = a === 'l' ? 'left' : a === 'r' ? 'right' : 'center';
        const th = lines.length * s * LH;
        const left = x1 + padX + (c.indent ?? 0) * size,
          right = x2 - padX;
        slots.push({ row: i, col: c.col, span: c.span, x: left, y, w: right - left, h, cell: { x: x1, y, w: x2 - x1, h }, align: anchor, size: s, weight: baseWeight(c), ...(c.color ? { color: c.color } : {}), lh: LH });
        if (!lines.length) return;
        const x = a === 'l' ? left : a === 'r' ? right : (left + right) / 2;
        pieces.push({ x, y: y + (h - th) / 2, w: right - left, anchor, lines, rich: richLines(lines, s, weight, o.measure), size: s, weight, ...(c.color ? { color: c.color } : {}), ...(o.lineheight ? { lh: LH } : {}), slot: slots.length - 1 });
      });
      y += h;
      if (o.rules === 'grid' || (o.rules === 'booktabs' && i === spec.header - 1 && i < nrow - 1)) rules.push({ x1: box.x, y1: y, x2: box.x + box.w, y2: y, lw: o.rules === 'grid' ? 1 : 0.9 });
    });
    const bottom = box.y + height;
    if (o.rules !== 'none') {
      const lw = o.rules === 'grid' ? 1 : 1.6;
      rules.push({ x1: box.x, y1: box.y, x2: box.x + box.w, y2: box.y, lw });
      if (o.rules === 'booktabs') rules.push({ x1: box.x, y1: bottom, x2: box.x + box.w, y2: bottom, lw });
    }
    if (o.rules === 'grid') for (const x of xs) rules.push({ x1: x, y1: box.y, x2: x, y2: bottom, lw: 1 });
    return { pieces, rules, fills, marks: [], slots, size, overflow, x: box.x, y: box.y, width: box.w, height: Math.min(height, box.h) };
  };
  return place(fitSize(o, at), box, o);
}

// ───────────────────────────── list ─────────────────────────────

export interface ListItem {
  level: number;
  /** bullet (`●` `○` `■` by level), or the written number (`1.`) */
  marker: string | null;
  text: string;
  bold: boolean;
}

/** Bullets by level (then repeating), as in Google Slides. */
export const BULLETS = ['●', '○', '■'];
const MARK_KIND: Record<string, Mark['kind']> = { '●': 'disc', '○': 'circle', '■': 'square' };

/** `- item` / `* item` / `1. item`, nested by indentation (2 spaces); unmarked lines continue the item above. */
export function parseList(body: string): ListItem[] {
  const lines = body.split('\n').filter((l) => l.trim() && !/^\s*(# |\/\/)/.test(l));
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '  ').length;
  const base = Math.min(...lines.map(indent));
  const items: ListItem[] = [];
  for (const l of lines) {
    const lv = Math.max(0, Math.round((indent(l) - base) / 2));
    const t = l.trim();
    // a marker alone is an empty item (an item being typed)
    const m = /^([-*+]|\d+[.)])(?:\s+(.*))?$/.exec(t);
    if (m) {
      const s = strong(m[2] ?? '');
      items.push({ level: lv, marker: /\d/.test(m[1]) ? m[1] : BULLETS[lv % BULLETS.length], text: s.text, bold: s.bold });
    } else if (items.length && lv > items[items.length - 1].level) items[items.length - 1].text += '\n' + t;
    else {
      const s = strong(t);
      items.push({ level: lv, marker: null, text: s.text, bold: s.bold });
    }
  }
  return items;
}

export interface ListSpacing {
  /** `levelscale=1,1,0.85`: text size per level relative to the list's size (the last value repeats) */
  levelscale?: number[];
  /** `itemgap=`: extra space between items, in em (default 0.55 before a top-level item, 0.3 before a nested one) */
  itemgap?: number;
  /** `indent=`: indentation per level, in em (default 1.5) */
  indent?: number;
  /** `markgap=`: from the bullet's left edge to the text, in em (default 1.1, wider for numbers) */
  markgap?: number;
}

/** All spacing is in em of the list's font size, so it scales with the fitted size. */
export function layoutList(items: ListItem[], box: Box, o: BlockOpts & ListSpacing): BlockLayout {
  if (!items.length) return empty(o, box);
  const scaleOf = (lv: number) => (o.levelscale?.length ? o.levelscale[Math.min(lv, o.levelscale.length - 1)] : lv > 0 ? 0.9 : 1);
  const at = (size: number): BlockLayout => {
    const LH = o.lineheight ?? LINE_HEIGHT;
    const step = size * (o.indent ?? 1.5); // indentation per level
    const numW = Math.max(0, ...items.filter((i) => i.marker && /\d/.test(i.marker)).map((i) => wrap(i.marker!, size, Infinity, o.weight, o.measure).width));
    const markW = o.markgap !== undefined ? Math.max(size * o.markgap, numW + size * 0.3) : Math.max(size * 1.1, numW + size * 0.5);
    const pieces: TextPiece[] = [];
    const marks: Mark[] = [];
    const slots: BlockSlot[] = [];
    let y = box.y;
    let overflow = false;
    let width = 0;
    items.forEach((it, k) => {
      if (k > 0) y += size * (o.itemgap ?? (it.level === 0 ? 0.55 : 0.3));
      const left = box.x + it.level * step;
      const textX = left + (it.marker ? markW : 0);
      const weight = it.bold ? 700 : o.weight;
      const s = size * scaleOf(it.level);
      const wr = wrap(it.text, s, Math.max(1, box.x + box.w - textX), weight, o.measure);
      if (wr.broke) overflow = true;
      const kind = it.marker ? MARK_KIND[it.marker] : undefined;
      // bullets: a shape centred on the first line; numbers: text
      const lh = o.lineheight ? { lh: LH } : {};
      if (kind) marks.push({ kind, cx: left + s * 0.3, cy: y + (s * LH) / 2, r: s * (kind === 'square' ? 0.17 : 0.19) });
      else if (it.marker) pieces.push({ x: left, y, w: markW, anchor: 'left', lines: [it.marker], size: s, weight, ...lh });
      pieces.push({ x: textX, y, w: box.x + box.w - textX, anchor: 'left', lines: wr.lines, rich: richLines(wr.lines, s, weight, o.measure), size: s, weight, ...lh, slot: slots.length });
      slots.push({ row: k, col: 0, span: 1, x: textX, y, w: box.x + box.w - textX, h: wr.lines.length * s * LH, align: 'left', size: s, weight: o.weight, lh: LH, ...(it.marker && !kind ? { marker: { x: left, text: it.marker } } : {}) });
      width = Math.max(width, textX - box.x + wr.width);
      y += wr.lines.length * s * LH;
    });
    const height = y - box.y;
    if (height > box.h + 0.5) overflow = true;
    return { pieces, rules: [], fills: [], marks, slots, size, overflow, x: box.x, y: box.y, width, height };
  };
  return place(fitSize(o, at), box, o);
}
