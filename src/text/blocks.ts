/**
 * Shapes whose content is a block of lines instead of a label: `table` (Markdown-style rows)
 * and `list` (bullets). Both lay out into positioned text pieces + rule lines, fitted to the box
 * at one font size (the largest that fits, between fontmin and fontmax, or a fixed `font=`).
 */
import { LINE_HEIGHT, richLines, wrap, type Measure, type RichLine } from './fit';

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
}

export interface Rule {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lw: number;
}

export interface BlockLayout {
  pieces: TextPiece[];
  rules: Rule[];
  size: number;
  overflow: boolean;
  /** area covered by the content */
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
}

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

/** `**text**` → bold text (whole cell / item only). */
function strong(s: string): { text: string; bold: boolean } {
  const m = /^\*\*(.+)\*\*$/.exec(s.trim());
  return m ? { text: m[1], bold: true } : { text: s.trim(), bold: false };
}

const lineW = (lines: string[], size: number, weight: number, measure: Measure) => Math.max(0, ...lines.map((l) => wrap(l, size, Infinity, weight, measure).width));

// ───────────────────────────── table ─────────────────────────────

export interface TableSpec {
  rows: string[][];
  /** header rows (bold, rule below) */
  header: number;
  /** per column: l / c / r */
  align: ('l' | 'c' | 'r')[];
}

/** Markdown-style rows: `| a | b |`; a `|---|:--:|` line marks the rows above it as header and sets alignment. */
export function parseTable(body: string, attrs: Record<string, string>): TableSpec {
  const rows: string[][] = [];
  let header = -1;
  let align: ('l' | 'c' | 'r')[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('# ') || line.startsWith('//')) continue;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) {
      if (header < 0) header = rows.length;
      align = cells.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : 'l'));
      continue;
    }
    rows.push(cells);
  }
  const ncol = Math.max(0, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < ncol) r.push('');
  const fromAttr = (attrs.align ?? '').split(',').map((a) => a.trim()[0]).filter(Boolean) as ('l' | 'c' | 'r')[];
  const al = Array.from({ length: ncol }, (_, i) => fromAttr[i] ?? align[i] ?? 'c');
  const h = attrs.header !== undefined ? Math.max(0, Number(attrs.header) || 0) : header >= 0 ? header : Math.min(1, rows.length);
  return { rows, header: h, align: al.map((a) => (a === 'l' || a === 'r' ? a : 'c')) };
}

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
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** `cols=2,1,1`: relative column widths (default: from the content). */
export function layoutTable(spec: TableSpec, box: Box, o: BlockOpts & { cols?: number[]; rules: 'booktabs' | 'grid' | 'none' }): BlockLayout {
  const nrow = spec.rows.length;
  const ncol = spec.align.length;
  if (!nrow || !ncol) return { pieces: [], rules: [], size: o.fixed ?? o.max, overflow: false, width: 0, height: 0 };
  const cells = spec.rows.map((r, ri) => r.map((c) => ({ ...strong(c), head: ri < spec.header })));
  const weightOf = (c: { bold: boolean; head: boolean }) => (c.bold || c.head ? 700 : o.weight);

  const at = (size: number): BlockLayout => {
    const padX = size * 0.6,
      padY = size * 0.3;
    // column widths: given ratios, or the content's natural widths (shrunk when they don't fit)
    const natural = Array.from({ length: ncol }, (_, j) => Math.max(...cells.map((r) => lineW(r[j].text.split('\n'), size, weightOf(r[j]), o.measure))) + padX * 2);
    const ratios = o.cols && o.cols.length ? Array.from({ length: ncol }, (_, j) => o.cols![j] ?? o.cols![o.cols!.length - 1]) : natural;
    const sum = ratios.reduce((a, b) => a + b, 0) || 1;
    let widths: number[];
    if (!o.cols?.length && natural.reduce((a, b) => a + b, 0) <= box.w) {
      // room to spare: share it out evenly so short columns don't look cramped
      const extra = (box.w - natural.reduce((a, b) => a + b, 0)) / ncol;
      widths = natural.map((w) => w + extra);
    } else widths = ratios.map((r) => (r / sum) * box.w);

    let overflow = false;
    const laid = cells.map((r) =>
      r.map((c, j) => {
        const inner = Math.max(1, widths[j] - padX * 2);
        const wr = wrap(c.text, size, inner, weightOf(c), o.measure);
        if (wr.broke) overflow = true;
        return { lines: c.text ? wr.lines : [], weight: weightOf(c) };
      }),
    );
    const rowH = laid.map((r) => Math.max(1, ...r.map((c) => c.lines.length)) * size * LINE_HEIGHT + padY * 2);
    const total = rowH.reduce((a, b) => a + b, 0);
    if (total > box.h + 0.5) overflow = true;
    // spare height goes evenly to the rows
    const extraH = Math.max(0, (box.h - total) / nrow);
    const pieces: TextPiece[] = [];
    const rules: Rule[] = [];
    let y = box.y;
    const xs = [box.x];
    for (const w of widths) xs.push(xs[xs.length - 1] + w);
    laid.forEach((r, i) => {
      const h = rowH[i] + extraH;
      r.forEach((c, j) => {
        if (!c.lines.length) return;
        const a = spec.align[j];
        const anchor = a === 'l' ? 'left' : a === 'r' ? 'right' : 'center';
        const th = c.lines.length * size * LINE_HEIGHT;
        const x = a === 'l' ? xs[j] + padX : a === 'r' ? xs[j + 1] - padX : (xs[j] + xs[j + 1]) / 2;
        pieces.push({ x, y: y + (h - th) / 2, w: widths[j] - padX * 2, anchor, lines: c.lines, rich: richLines(c.lines, size, c.weight, o.measure), size, weight: c.weight });
      });
      y += h;
      if (o.rules === 'grid' || (o.rules === 'booktabs' && i === spec.header - 1 && i < nrow - 1)) rules.push({ x1: box.x, y1: y, x2: box.x + box.w, y2: y, lw: o.rules === 'grid' ? 1 : 0.9 });
    });
    const bottom = box.y + Math.max(total, box.h);
    if (o.rules !== 'none') {
      const lw = o.rules === 'grid' ? 1 : 1.6;
      rules.push({ x1: box.x, y1: box.y, x2: box.x + box.w, y2: box.y, lw });
      if (o.rules === 'booktabs') rules.push({ x1: box.x, y1: bottom, x2: box.x + box.w, y2: bottom, lw });
    }
    if (o.rules === 'grid') for (const x of xs) rules.push({ x1: x, y1: box.y, x2: x, y2: bottom, lw: 1 });
    return { pieces, rules, size, overflow, width: box.w, height: Math.min(total, box.h) };
  };
  return fitSize(o, at);
}

// ───────────────────────────── list ─────────────────────────────

export interface ListItem {
  level: number;
  /** `•` style bullet, or the written number (`1.`) */
  marker: string | null;
  text: string;
  bold: boolean;
}

const BULLETS = ['•', '–', '◦'];

/** `- item` / `* item` / `1. item`, nested by indentation (2 spaces); unmarked lines continue the item above. */
export function parseList(body: string): ListItem[] {
  const lines = body.split('\n').filter((l) => l.trim() && !/^\s*(# |\/\/)/.test(l));
  const indent = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '  ').length;
  const base = Math.min(...lines.map(indent));
  const items: ListItem[] = [];
  for (const l of lines) {
    const lv = Math.max(0, Math.round((indent(l) - base) / 2));
    const t = l.trim();
    const m = /^([-*+]|\d+[.)])\s+(.*)$/.exec(t);
    if (m) {
      const s = strong(m[2]);
      items.push({ level: lv, marker: /\d/.test(m[1]) ? m[1] : BULLETS[lv % BULLETS.length], text: s.text, bold: s.bold });
    } else if (items.length && lv > items[items.length - 1].level) items[items.length - 1].text += '\n' + t;
    else {
      const s = strong(t);
      items.push({ level: lv, marker: null, text: s.text, bold: s.bold });
    }
  }
  return items;
}

export function layoutList(items: ListItem[], box: Box, o: BlockOpts): BlockLayout {
  if (!items.length) return { pieces: [], rules: [], size: o.fixed ?? o.max, overflow: false, width: 0, height: 0 };
  const at = (size: number): BlockLayout => {
    const step = size * 1.5; // indentation per level
    const numW = Math.max(0, ...items.filter((i) => i.marker && /\d/.test(i.marker)).map((i) => wrap(i.marker!, size, Infinity, o.weight, o.measure).width));
    const markW = Math.max(size * 1.1, numW + size * 0.5);
    const pieces: TextPiece[] = [];
    let y = box.y;
    let overflow = false;
    let width = 0;
    items.forEach((it, k) => {
      if (k > 0) y += size * (it.level === 0 ? 0.55 : 0.3);
      const left = box.x + it.level * step;
      const textX = left + (it.marker ? markW : 0);
      const weight = it.bold ? 700 : o.weight;
      const sub = it.level > 0 ? 0.9 : 1;
      const s = size * sub;
      const wr = wrap(it.text, s, Math.max(1, box.x + box.w - textX), weight, o.measure);
      if (wr.broke) overflow = true;
      if (it.marker) pieces.push({ x: left, y, w: markW, anchor: 'left', lines: [it.marker], size: s, weight: /\d/.test(it.marker) ? weight : o.weight });
      pieces.push({ x: textX, y, w: box.x + box.w - textX, anchor: 'left', lines: wr.lines, rich: richLines(wr.lines, s, weight, o.measure), size: s, weight });
      width = Math.max(width, textX - box.x + wr.width);
      y += wr.lines.length * s * LINE_HEIGHT;
    });
    const height = y - box.y;
    if (height > box.h + 0.5) overflow = true;
    return { pieces, rules: [], size, overflow, width, height };
  };
  return fitSize(o, at);
}
