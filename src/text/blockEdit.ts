/**
 * Editing models for `list` / `table` bodies, used by the in-place editors.
 *
 * Both read the body as written and write it back with the smallest change: lines the user did
 * not touch keep their text, and only the touched ones are formatted again (a table whose pipes
 * were lined up is lined up again).
 */
import { boldClose, mathClose } from './inline';

// ───────────────────────────── inline markup ─────────────────────────────

export interface Seg {
  text: string;
  bold: boolean;
}

/** `**bold**` spans of a line as written (escapes and formulas stay raw text). */
export function toSegs(s: string): Seg[] {
  const out: Seg[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ text, bold: false });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      text += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '$') {
      const e = mathClose(s, i + 1);
      if (e > i + 1) {
        text += s.slice(i, e + 1);
        i = e + 1;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      const e = boldClose(s, i + 2);
      if (e > i + 2) {
        flush();
        out.push({ text: s.slice(i + 2, e), bold: true });
        i = e + 2;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** Back to markup; neighbouring pieces of the same weight are joined. */
export function fromSegs(segs: Seg[]): string {
  const merged: Seg[] = [];
  for (const g of segs) {
    if (!g.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.bold === g.bold) last.text += g.text;
    else merged.push({ ...g });
  }
  return merged.map((g) => (g.bold && g.text.trim() ? `**${g.text}**` : g.text)).join('');
}

/** Markup that may hold several lines (`**` pairs never cross a line) → pieces, with `\n` pieces between lines. */
export function markupSegs(s: string): Seg[] {
  return s.split('\n').flatMap((l, i) => (i ? [{ text: '\n', bold: false }, ...toSegs(l)] : toSegs(l)));
}

export function segsMarkup(segs: Seg[]): string {
  const lines: Seg[][] = [[]];
  for (const g of segs)
    g.text.split('\n').forEach((t, i) => {
      if (i) lines.push([]);
      if (t) lines[lines.length - 1].push({ text: t, bold: g.bold });
    });
  return lines.map(fromSegs).join('\n');
}

/** Length of the text as shown (without the `**`). */
export const shownLength = (markup: string) => markupSegs(markup).reduce((a, g) => a + g.text.length, 0);

// ───────────────────────────── list ─────────────────────────────

export interface EditItem {
  level: number;
  /** `-` `*` `+` or `1.` / `1)`; null = a line without a marker */
  marker: string | null;
  /** markup; `\n` = a continuation line */
  text: string;
  /** lines as written (dedented), while the item is untouched */
  raw?: string[];
  /** comment lines written before the item */
  before: string[];
}

export interface EditList {
  items: EditItem[];
  /** comment lines after the last item */
  after: string[];
}

const MARKER = /^([-*+]|\d+[.)])(?:\s+(.*))?$/;
export const isNumber = (m: string | null) => !!m && /\d/.test(m);

/** Same reading as `parseList` (items in the same order), keeping comments and the written lines. */
export function readList(body: string): EditList {
  const all = body.split('\n');
  const indentOf = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '  ').length;
  const isComment = (l: string) => /^\s*(# |\/\/)/.test(l);
  const used = all.filter((l) => l.trim() && !isComment(l));
  const base = used.length ? Math.min(...used.map(indentOf)) : 0;
  const items: EditItem[] = [];
  let pending: string[] = [];
  for (const l of all) {
    if (!l.trim()) continue;
    const line = l.replace(/^[ \t]*/, (w) => w.replace(/\t/g, '  ').slice(base));
    if (isComment(l)) {
      pending.push(line);
      continue;
    }
    const lv = Math.max(0, Math.round((indentOf(l) - base) / 2));
    const t = l.trim();
    const m = MARKER.exec(t);
    const last = items[items.length - 1];
    if (!m && last && lv > last.level) {
      last.text += '\n' + t;
      last.raw!.push(line);
      continue;
    }
    items.push({ level: lv, marker: m ? m[1] : null, text: m ? (m[2] ?? '') : t, raw: [line], before: pending });
    pending = [];
  }
  return { items, after: pending };
}

/** Lines of one item at its level. */
function itemLines(it: EditItem): string[] {
  const pad = '  '.repeat(it.level);
  const [first, ...rest] = it.text.split('\n');
  const head = it.marker ? `${it.marker}${first ? ' ' + first : ''}` : first;
  return [pad + head, ...rest.filter((l) => l.trim()).map((l) => pad + '  ' + l.trim())];
}

/** Whether the item is written at all (an empty line without a marker is not). */
export const itemShown = (it: EditItem) => !!it.marker || !!it.text.trim();

export function writeList(l: EditList): string {
  const out: string[] = [];
  for (const it of l.items) {
    out.push(...it.before);
    if (itemShown(it)) out.push(...(it.raw ?? itemLines(it)));
  }
  out.push(...l.after);
  return out.join('\n');
}

/** Numbers run on among siblings (from the first one's number); changed items lose their raw text. */
export function renumber(items: EditItem[]) {
  const next = new Map<number, number>();
  for (const it of items) {
    for (const lv of [...next.keys()]) if (lv > it.level) next.delete(lv);
    if (!isNumber(it.marker)) {
      next.delete(it.level);
      continue;
    }
    const [, n, close] = /^(\d+)([.)])$/.exec(it.marker!)!;
    const want = next.get(it.level) ?? Number(n);
    const m = `${want}${close}`;
    if (m !== it.marker) {
      it.marker = m;
      it.raw = undefined;
    }
    next.set(it.level, want + 1);
  }
}

/** A marker typed at the start of the text (`- `, `* `, `1. `): split off, or null. */
export function typedMarker(text: string): { marker: string; rest: string } | null {
  const m = /^([-*+]|\d+[.)]) /.exec(text);
  return m ? { marker: m[1], rest: text.slice(m[0].length) } : null;
}

/** The marker for an item that follows `it` (a new item made with Enter). */
export const nextMarker = (it: EditItem) => (isNumber(it.marker) ? it.marker!.replace(/^\d+/, (n) => String(Number(n) + 1)) : (it.marker ?? '-'));

/** Item `k` and the items nested below it. */
export function subtree(items: EditItem[], k: number): number {
  let e = k + 1;
  while (e < items.length && items[e].level > items[k].level) e++;
  return e;
}

// ───────────────────────────── table ─────────────────────────────

export interface EditCell {
  /** markup, `|` unescaped */
  text: string;
  /** a `{...}` after the cell, as written (with its leading space) */
  attrs: string;
  span: number;
}

export type TableLine =
  | { t: 'row'; cells: EditCell[]; tail: string; raw?: string }
  | { t: 'sep'; aligns: string[]; raw?: string }
  | { t: 'other'; raw: string };

export interface EditTable {
  lines: TableLine[];
  /** the pipes were lined up in the source: keep them so */
  aligned: boolean;
}

const ATTR = String.raw`(?:\.[\w-]+|[\w-]+=(?:"[^"]*"|[^\s{}"]+))`;
const ATTR_BLOCK = new RegExp(String.raw`\s*\{\s*${ATTR}(?:\s+${ATTR})*\s*\}\s*$`);

/** A trailing `{...}` (not inside a formula), split off as written. */
function splitAttrs(s: string): { rest: string; attrs: string } {
  const m = ATTR_BLOCK.exec(s);
  if (!m) return { rest: s, attrs: '' };
  const rest = s.slice(0, m.index);
  if ((rest.match(/(?<!\\)\$/g)?.length ?? 0) % 2) return { rest: s, attrs: '' };
  return { rest, attrs: ' ' + s.slice(m.index).trim() };
}

function splitCells(line: string): string[] {
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

/** Display width in a monospace editor (wide characters count two). */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const dispW = (s: string) => [...s].reduce((a, c) => a + (WIDE.test(c) ? 2 : 1), 0);

/** Same reading as `parseTable`: row lines, the `|---|` line, and anything else kept as is. */
export function readTable(body: string): EditTable {
  const lines: TableLine[] = [];
  const rowLens: number[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ') || line.startsWith('//')) {
      lines.push({ t: 'other', raw });
      continue;
    }
    let rest = line;
    let tail = '';
    if (line.includes('|')) {
      const a = splitAttrs(line);
      if (a.attrs && /\|\s*$/.test(a.rest)) {
        rest = a.rest.trim();
        tail = a.attrs;
      }
    }
    const parts = splitCells(rest);
    rowLens.push(dispW(rest));
    if (parts.every((c) => /^:?-+:?$/.test(c.trim()))) {
      lines.push({ t: 'sep', aligns: parts.map((c) => c.trim()), raw });
      continue;
    }
    const cells: EditCell[] = [];
    for (const p of parts) {
      if (p === '' && cells.length) {
        cells[cells.length - 1].span++;
        continue;
      }
      const a = splitAttrs(p);
      cells.push({ text: a.rest.trim(), attrs: a.attrs, span: 1 });
    }
    lines.push({ t: 'row', cells, tail, raw });
  }
  // lined up: rows of one width, padded beyond a single space (short rows can be equal by chance)
  const padded = / {2,}\|/.test(body) || /-{4,}/.test(body);
  return { lines, aligned: padded && rowLens.length > 1 && rowLens.every((w) => w === rowLens[0]) };
}

export const rowsOf = (t: EditTable) => t.lines.filter((l): l is Extract<TableLine, { t: 'row' }> => l.t === 'row');
export const sepOf = (t: EditTable) => t.lines.find((l): l is Extract<TableLine, { t: 'sep' }> => l.t === 'sep');
const width = (cells: EditCell[]) => cells.reduce((a, c) => a + c.span, 0);
export const colCount = (t: EditTable) => Math.max(0, ...rowsOf(t).map((r) => width(r.cells)), sepOf(t)?.aligns.length ?? 0);

const escCell = (s: string) => {
  // `|` outside formulas is a column break
  let out = '';
  let math = false;
  for (const c of s) {
    if (c === '$') math = !math;
    out += c === '|' && !math ? '\\|' : c;
  }
  return out;
};

export function writeTable(t: EditTable): string {
  const ncol = colCount(t);
  for (const r of rowsOf(t)) if (width(r.cells) < ncol && !r.raw) pad(r.cells, ncol);
  const sep = sepOf(t);
  if (sep && sep.aligns.length < ncol && !sep.raw) while (sep.aligns.length < ncol) sep.aligns.push('---');
  const touched = t.lines.some((l) => l.t !== 'other' && !l.raw);
  // lined-up tables are lined up again as a whole once something changed
  const align = t.aligned && touched;
  const w = Array.from({ length: ncol }, () => 3);
  if (align) for (const r of rowsOf(t)) for (const [j, c] of starts(r.cells)) if (c.span === 1) w[j] = Math.max(w[j], dispW(escCell(c.text) + c.attrs));
  const cellText = (c: EditCell, j: number) => {
    const s = escCell(c.text) + c.attrs;
    if (!align) return ` ${s} `;
    const room = w.slice(j, j + c.span).reduce((a, b) => a + b, 0) + 3 * (c.span - 1) - (c.span - 1);
    return ` ${s}${' '.repeat(Math.max(0, room - dispW(s)))} `;
  };
  return t.lines
    .map((l) => {
      if (l.t === 'other') return l.raw.trim();
      if (l.raw && !align) return l.raw.trim();
      if (l.t === 'sep') {
        const toks = l.aligns.map((a, j) => {
          if (!align) return a;
          const left = a.startsWith(':'),
            right = a.endsWith(':') && a.length > 1;
          return (left ? ':' : '') + '-'.repeat(Math.max(1, (w[j] ?? 3) + 2 - (left ? 1 : 0) - (right ? 1 : 0))) + (right ? ':' : '');
        });
        return `|${toks.join('|')}|`;
      }
      return '|' + starts(l.cells).map(([j, c]) => cellText(c, j) + '|'.repeat(c.span - 1)).join('|') + '|' + l.tail;
    })
    .join('\n');
}

/** cells with their first column */
function starts(cells: EditCell[]): [number, EditCell][] {
  let j = 0;
  return cells.map((c) => {
    const at = j;
    j += c.span;
    return [at, c];
  });
}

function pad(cells: EditCell[], ncol: number) {
  while (width(cells) < ncol) cells.push({ text: '', attrs: '', span: 1 });
}

/** The cell covering column `col` of row `r` (made when the row is short). */
export function cellAt(t: EditTable, r: number, col: number): EditCell | undefined {
  const row = rowsOf(t)[r];
  if (!row) return undefined;
  if (width(row.cells) <= col) {
    pad(row.cells, col + 1);
    row.raw = undefined;
  }
  return starts(row.cells).find(([j, c]) => j <= col && col < j + c.span)?.[1];
}

export function setCell(t: EditTable, r: number, col: number, text: string) {
  const c = cellAt(t, r, col);
  if (!c || c.text === text) return;
  c.text = text;
  rowsOf(t)[r].raw = undefined;
}

/** A new empty row before row `at` (`at` = the number of rows: at the end). */
export function insertRow(t: EditTable, at: number) {
  const rows = rowsOf(t);
  const ncol = Math.max(1, colCount(t));
  const row: TableLine = { t: 'row', cells: Array.from({ length: ncol }, () => ({ text: '', attrs: '', span: 1 })), tail: '' };
  const idx = at < rows.length ? t.lines.indexOf(rows[at]) : lastIndex(t) + 1;
  // a row inserted right after the header goes below the `|---|` line
  const sep = sepOf(t);
  const i = sep && at > 0 && at < rows.length && t.lines.indexOf(rows[at - 1]) < t.lines.indexOf(sep) && t.lines.indexOf(sep) < idx ? t.lines.indexOf(sep) + 1 : idx;
  t.lines.splice(i, 0, row);
}

function lastIndex(t: EditTable) {
  for (let i = t.lines.length - 1; i >= 0; i--) if (t.lines[i].t !== 'other') return i;
  return t.lines.length - 1;
}

export function removeRow(t: EditTable, r: number) {
  const row = rowsOf(t)[r];
  if (row) t.lines.splice(t.lines.indexOf(row), 1);
  // the `|---|` line with no header rows above it any more marks nothing
  const sep = sepOf(t);
  if (sep && !t.lines.slice(0, t.lines.indexOf(sep)).some((l) => l.t === 'row')) t.lines.splice(t.lines.indexOf(sep), 1);
}

/** A new empty column before column `at` (cells spanning across it get wider). */
export function insertCol(t: EditTable, at: number) {
  const ncol = colCount(t);
  for (const row of rowsOf(t)) {
    pad(row.cells, ncol);
    row.raw = undefined;
    const st = starts(row.cells);
    const inside = st.find(([j, c]) => j < at && at < j + c.span);
    if (inside) inside[1].span++;
    else {
      const k = st.findIndex(([j]) => j >= at);
      row.cells.splice(k < 0 ? row.cells.length : k, 0, { text: '', attrs: '', span: 1 });
    }
  }
  const sep = sepOf(t);
  if (sep) {
    while (sep.aligns.length < ncol) sep.aligns.push('---');
    sep.aligns.splice(at, 0, sep.aligns[Math.max(0, at - 1)] ?? '---');
    sep.raw = undefined;
  }
}

export function removeCol(t: EditTable, at: number) {
  for (const row of rowsOf(t)) {
    const st = starts(row.cells);
    const hit = st.find(([j, c]) => j <= at && at < j + c.span);
    if (!hit) continue;
    row.raw = undefined;
    if (hit[1].span > 1) hit[1].span--;
    else row.cells.splice(row.cells.indexOf(hit[1]), 1);
  }
  const sep = sepOf(t);
  if (sep && at < sep.aligns.length) {
    sep.aligns.splice(at, 1);
    sep.raw = undefined;
  }
  // a table with no columns left has no rows either
  if (!colCount(t)) t.lines = t.lines.filter((l) => l.t === 'other');
}

/** Alignment of a column in the `|---|` line (one is added below the first row if there is none). */
export function setColAlign(t: EditTable, col: number, a: 'l' | 'c' | 'r') {
  const ncol = colCount(t);
  let sep = sepOf(t);
  if (!sep) {
    const first = rowsOf(t)[0];
    if (!first) return;
    // without a `|---|` line every column is centred (and the first row is the header)
    sep = { t: 'sep', aligns: Array.from({ length: ncol }, () => ':---:') };
    t.lines.splice(t.lines.indexOf(first) + 1, 0, sep);
  }
  while (sep.aligns.length < ncol) sep.aligns.push('---');
  sep.aligns[col] = a === 'l' ? ':---' : a === 'r' ? '---:' : ':---:';
  sep.raw = undefined;
}
