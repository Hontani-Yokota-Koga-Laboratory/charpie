import {
  ARROW_OPS,
  DEFAULT_SETTINGS,
  POINT_END,
  SHAPE_KINDS,
  DEFAULT_CANVAS,
  type ArrowOp,
  type AttrEntry,
  type Diagnostic,
  type Doc,
  type EdgeDef,
  type EndPoint,
  type NodeDef,
  type Port,
  type Settings,
  type ShapeKind,
  type Span,
  type StmtSpans,
  type StyleDef,
  type View,
  type PageInfo,
  type LayoutInfo,
} from './types';

// ───────────────────────────── tokenizer ─────────────────────────────

export type TokType = 'ident' | 'num' | 'str' | 'color' | 'size' | 'op' | 'punct' | 'comment' | 'nl' | 'bad';

export interface Tok {
  type: TokType;
  /** Decoded value (strings unescaped). */
  value: string;
  from: number;
  to: number;
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_CHAR = /[\p{L}\p{N}_-]/u;

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const push = (type: TokType, value: string, from: number, to: number) => toks.push({ type, value, from, to });

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      push('nl', '\n', i, i + 1);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // comments: "# ..." (hash + space / EOL) or "// ..."
    if ((c === '#' && (i + 1 >= n || /[\s#!]/.test(src[i + 1]))) || (c === '/' && src[i + 1] === '/')) {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      push('comment', src.slice(start, i), start, i);
      continue;
    }
    if (c === '#') {
      const m = /^#[0-9a-fA-F]{3,8}(?![\p{L}\p{N}_])/u.exec(src.slice(i, i + 12));
      if (m) {
        push('color', m[0].toLowerCase(), i, i + m[0].length);
        i += m[0].length;
        continue;
      }
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      push('comment', src.slice(start, i), start, i);
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let val = '';
      let closed = false;
      // inside `$...$` backslashes are TeX and stay as written (only \" is unescaped); outside, `\$` stays escaped
      let math = false;
      while (i < n && src[i] !== '\n') {
        const ch = src[i];
        if (ch === '\\' && i + 1 < n) {
          const nx = src[i + 1];
          val += math ? (nx === '"' ? '"' : ch + nx) : nx === 'n' ? '\n' : nx === '$' ? '\\$' : nx;
          i += 2;
          continue;
        }
        if (ch === '$') math = !math;
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        val += ch;
        i++;
      }
      push(closed ? 'str' : 'bad', val, start, i);
      continue;
    }
    const rest3 = src.slice(i, i + 3);
    const op = rest3 === '<->' ? '<->' : (['->', '<-', '--'] as const).find((o) => src.startsWith(o, i));
    if (op) {
      push('op', op, i, i + op.length);
      i += op.length;
      continue;
    }
    const sizeM = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?/.exec(src.slice(i, i + 24));
    if (sizeM) {
      push('size', sizeM[0], i, i + sizeM[0].length);
      i += sizeM[0].length;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d*\.?\d+/.exec(src.slice(i, i + 32))!;
      push('num', m[0], i, i + m[0].length);
      i += m[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      const start = i;
      i++;
      while (i < n && IDENT_CHAR.test(src[i])) {
        // stop before "->" / "--" so `a->b` tokenizes as an edge
        if (src[i] === '-' && (src[i + 1] === '>' || src[i + 1] === '-')) break;
        i++;
      }
      push('ident', src.slice(start, i), start, i);
      continue;
    }
    if ('(),{}:;=.+'.includes(c)) {
      push('punct', c, i, i + 1);
      i++;
      continue;
    }
    push('bad', c, i, i + 1);
    i++;
  }
  return toks;
}

// ───────────────────────────── parser ─────────────────────────────

export const NODE_ATTRS = new Set(['fill', 'stroke', 'text', 'lw', 'dash', 'font', 'family', 'weight', 'in', 'overlap', 'skew', 'radius', 'opacity', 'valign', 'halign', 'dir', 'pad', 'rotate', 'src', 'fit', 'ignore', 'header', 'align', 'cols', 'rules', 'levelscale', 'lineheight', 'itemgap', 'indent', 'markgap']);
export const EDGE_ATTRS = new Set(['stroke', 'lw', 'dash', 'route', 'bend', 'text', 'font', 'family', 'fromat', 'toat', 'ignore']);
/** Keys of table cell / row `{...}` blocks (also valid in a `style` used there). */
export const CELL_ATTRS = new Set(['fill', 'text', 'weight', 'scale', 'indent', 'align']);

/** Attributes whose value may be a comma-separated list: `ignore=overlap,through`, `cols=2,1,1`. */
const LIST_ATTRS = new Set(['ignore', 'align', 'cols', 'levelscale']);

type ParsedEnd = { id: string; port?: string; portTok?: Tok; pt?: EndPoint; span: Span; next: number };

/** An arrow end: `id`, `id.port`, `(x, y)` or `+(dx, dy)`. */
function parseEnd(ts: Tok[], i: number): ParsedEnd | undefined {
  const t = ts[i];
  if (!t) return undefined;
  if (t.type === 'ident') {
    if (isPunct(ts[i + 1], '.') && ts[i + 2]?.type === 'ident') return { id: t.value, port: ts[i + 2].value, portTok: ts[i + 2], span: { from: t.from, to: t.to }, next: i + 3 };
    return { id: t.value, span: { from: t.from, to: t.to }, next: i + 1 };
  }
  const rel = isPunct(t, '+');
  const j = rel ? i + 1 : i;
  const [lp, a, cm, b, rp] = ts.slice(j, j + 5);
  if (isPunct(lp, '(') && a?.type === 'num' && isPunct(cm, ',') && b?.type === 'num' && isPunct(rp, ')')) {
    return { id: POINT_END, pt: { x: Number(a.value), y: Number(b.value), rel }, span: { from: t.from, to: rp.to }, next: j + 5 };
  }
  return undefined;
}
const SETTINGS_KEYS = new Set<string>(['gap', 'grid', 'padding', 'fontmin', 'fontmax', 'canvas', 'family']);

const KIND_ALIASES: Record<string, ShapeKind> = {
  rectangle: 'rect',
  box: 'rect',
  rounded: 'round',
  circle: 'ellipse',
  oval: 'ellipse',
  trapezoid: 'trap',
  parallelogram: 'para',
  hexagon: 'hex',
  otimes: 'cross',
  oplus: 'plus',
  label: 'text',
  img: 'image',
  picture: 'image',
};

export function resolveKind(word: string): ShapeKind | undefined {
  if ((SHAPE_KINDS as readonly string[]).includes(word)) return word as ShapeKind;
  return KIND_ALIASES[word];
}

const PORTS = new Set(['n', 'e', 's', 'w']);

interface Stmt {
  toks: Tok[];
  /** Offset where the statement's line begins. */
  lineStart: number;
  /** Offset just after the newline ending the statement (or EOF). */
  lineEnd: number;
  line: number;
}

function splitStatements(src: string, toks: Tok[]): Stmt[] {
  const stmts: Stmt[] = [];
  let cur: Tok[] = [];
  let depth = 0;
  let lineStart = 0;
  let line = 0;
  let stmtLine = 0;
  let stmtLineStart = 0;
  for (const t of toks) {
    if (t.type === 'nl') {
      line++;
      if (depth === 0) {
        if (cur.length) stmts.push({ toks: cur, lineStart: stmtLineStart, lineEnd: t.to, line: stmtLine });
        cur = [];
        lineStart = t.to;
      }
      continue;
    }
    if (t.type === 'comment') continue;
    if (!cur.length) {
      stmtLine = line;
      stmtLineStart = lineStart;
    }
    if (t.type === 'punct' && t.value === '{') depth++;
    if (t.type === 'punct' && t.value === '}') depth = Math.max(0, depth - 1);
    cur.push(t);
  }
  if (cur.length) stmts.push({ toks: cur, lineStart: stmtLineStart, lineEnd: src.length, line: stmtLine });
  return stmts;
}

function isPunct(t: Tok | undefined, v: string) {
  return !!t && t.type === 'punct' && t.value === v;
}

// ───────────────────────────── blocks ─────────────────────────────

/** Shape kinds whose content is the raw lines of a `{ ... }` block. */
export const RAW_KINDS = new Set<string>(['table', 'list']);

interface BlockMeta {
  type: 'page' | 'layout';
  line: number;
  lineStart: number;
  /** offset just after the header line's newline */
  bodyFrom: number;
  /** start of the closing `}` line (or EOF) */
  bodyTo: number;
  /** end of the closing line, newline included */
  end: number;
  indent: string;
  closed: boolean;
}

interface RawMeta {
  headerLineStart: number;
  bodyFrom: number;
  bodyTo: number;
}

/** Code part of a line (comments cut, strings respected). */
function codeOf(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === '"') q = false;
      continue;
    }
    if (c === '"') q = true;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    else if (c === '#' && !/^#[0-9a-fA-F]{3,8}(?![\p{L}\p{N}_])/u.test(line.slice(i, i + 10))) return line.slice(0, i);
  }
  return line;
}

/**
 * Finds `page` / `layout` blocks and raw (`table` / `list`) bodies line by line and blanks their braces
 * and raw lines, so the statement parser sees plain statements at unchanged offsets.
 */
function scanBlocks(src: string) {
  const chars = src.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  const blocks: BlockMeta[] = [];
  const raws: RawMeta[] = [];
  const errs: { from: number; to: number; message: string }[] = [];
  type Open = { type: 'page' | 'layout' | 'raw' | 'style' | 'other'; idx: number; lineStart: number; braceAt: number };
  const stack: Open[] = [];
  const lines = src.split('\n');
  let off = 0;
  lines.forEach((line, lineNo) => {
    const lineStart = off;
    off += line.length + 1;
    const top = stack[stack.length - 1];
    const code = codeOf(line);
    const t = code.trim();
    if (top?.type === 'raw') {
      if (t === '}') {
        raws[top.idx].bodyTo = lineStart;
        blank(lineStart, lineStart + line.length);
        stack.pop();
      } else blank(lineStart, lineStart + line.length);
      return;
    }
    if (t === '}') {
      const b = stack.pop();
      if (b && (b.type === 'page' || b.type === 'layout')) {
        Object.assign(blocks[b.idx], { bodyTo: lineStart, end: Math.min(off, src.length), closed: true });
        blank(lineStart, lineStart + line.length);
      }
      return;
    }
    if (!t.endsWith('{')) return;
    const braceAt = lineStart + code.trimEnd().length - 1;
    const words = t.split(/\s+/);
    const inBlock = stack.some((s) => s.type === 'page' || s.type === 'layout');
    if (words[0] === 'page' || words[0] === 'layout') {
      if (inBlock) errs.push({ from: lineStart, to: lineStart + line.length, message: `${words[0]} は入れ子にできません（前のブロックの } を確認）` });
      blocks.push({ type: words[0], line: lineNo, lineStart, bodyFrom: Math.min(off, src.length), bodyTo: src.length, end: src.length, indent: '', closed: false });
      stack.push({ type: words[0], idx: blocks.length - 1, lineStart, braceAt });
      blank(braceAt, braceAt + 1);
    } else if (RAW_KINDS.has(words[0]) || (inBlock && words[0] !== 'style')) {
      raws.push({ headerLineStart: lineStart, bodyFrom: Math.min(off, src.length), bodyTo: src.length });
      stack.push({ type: 'raw', idx: raws.length - 1, lineStart, braceAt });
      blank(braceAt, braceAt + 1);
    } else stack.push({ type: words[0] === 'style' ? 'style' : 'other', idx: -1, lineStart, braceAt });
  });
  for (const s of stack) {
    if (s.type === 'page' || s.type === 'layout') errs.push({ from: s.braceAt, to: s.braceAt + 1, message: `${s.type} の } が閉じられていません` });
    if (s.type === 'raw') errs.push({ from: s.braceAt, to: s.braceAt + 1, message: '{ に対応する } がありません' });
  }
  // indentation used for statements inserted into each block
  for (const b of blocks) {
    const header = src.slice(b.lineStart, src.indexOf('\n', b.lineStart) < 0 ? src.length : src.indexOf('\n', b.lineStart));
    const body = src.slice(b.bodyFrom, b.bodyTo).split('\n').find((l) => codeOf(l).trim());
    b.indent = body ? /^[ \t]*/.exec(body)![0] : /^[ \t]*/.exec(header)![0] + '  ';
  }
  return { masked: chars.join(''), blocks, raws, errs };
}

// ───────────────────────────── statements ─────────────────────────────

interface Fill {
  def: NodeDef;
  given: { at: boolean; size: boolean; kind: boolean };
}

interface Parsed {
  /** items per scope: -1 = top level, otherwise index into `blocks` */
  nodes: { def: NodeDef; scope: number }[];
  edges: { def: EdgeDef; scope: number }[];
  slots: { def: NodeDef; scope: number }[];
  fills: (Fill & { scope: number })[];
  hides: { id: string; span: Span; scope: number }[];
  styles: Map<string, StyleDef>;
  settings: Settings;
  settingsSpan?: Span;
  settingsAttrs: Record<string, string>;
  canvas?: { w: number; h: number };
  diagnostics: Diagnostic[];
  blocks: BlockMeta[];
  pages: PageInfo[];
  layouts: LayoutInfo[];
  /** block index → page / layout info */
  info: (PageInfo | LayoutInfo)[];
}

function parseFile(src: string): Parsed {
  const scan = scanBlocks(src);
  const toks = tokenize(scan.masked);
  const stmts = splitStatements(scan.masked, toks);
  const diagnostics: Diagnostic[] = scan.errs.map((e) => ({ ...e, severity: 'error', code: 'syntax' }));
  const styles = new Map<string, StyleDef>();
  const settings: Settings = { ...DEFAULT_SETTINGS };
  let settingsSpan: Span | undefined;
  const settingsAttrs: Record<string, string> = {};
  let canvas: { w: number; h: number } | undefined;
  const P: Parsed = { nodes: [], edges: [], slots: [], fills: [], hides: [], styles, settings, settingsAttrs, diagnostics, blocks: scan.blocks, pages: [], layouts: [], info: [] };
  const headerAt = new Map(scan.blocks.map((b, i) => [b.lineStart, i]));
  const rawAt = new Map(scan.raws.map((r) => [r.headerLineStart, r]));
  const scopeOf = (pos: number) => {
    for (let i = scan.blocks.length - 1; i >= 0; i--) if (pos >= scan.blocks[i].bodyFrom && pos < scan.blocks[i].bodyTo) return i;
    return -1;
  };

  const err = (t: { from: number; to: number }, message: string, code = 'syntax', severity: Diagnostic['severity'] = 'error') =>
    diagnostics.push({ from: t.from, to: t.to, message, code, severity });

  for (const t of toks) if (t.type === 'bad') err(t, src[t.from] === '"' ? '閉じられていない文字列です' : `不明な文字 "${t.value}"`);

  type Out = { attrs: Record<string, string>; attrList: AttrEntry[]; classes: string[]; label?: { value: string; span: Span } };
  const newOut = (): Out => ({ attrs: {}, attrList: [], classes: [], label: undefined });

  /** Parses `key=value` and `.class` items starting at index i. */
  const parseTail = (ts: Tok[], i: number, allowed: Set<string>, out: Out, extra?: (ts: Tok[], i: number) => number | undefined) => {
    while (i < ts.length) {
      const t = ts[i];
      const ext = extra?.(ts, i);
      if (ext !== undefined) {
        i = ext;
        continue;
      }
      if (t.type === 'str') {
        if (out.label) err(t, 'ラベルが二重に指定されています', 'syntax', 'warning');
        out.label = { value: t.value, span: { from: t.from, to: t.to } };
        i++;
        continue;
      }
      if (isPunct(t, '.') && ts[i + 1]?.type === 'ident') {
        out.classes.push(ts[i + 1].value);
        i += 2;
        continue;
      }
      if (t.type === 'ident' && isPunct(ts[i + 1], '=')) {
        const v = ts[i + 2];
        if (!v || !['num', 'color', 'ident', 'str', 'size'].includes(v.type)) {
          err({ from: t.from, to: ts[i + 1].to }, `"${t.value}" の値がありません`);
          i += 2;
          continue;
        }
        if (!allowed.has(t.value)) err(t, `不明な属性 "${t.value}"`, 'unknown-attr', 'warning');
        let value = v.value,
          end = v.to;
        i += 3;
        if (LIST_ATTRS.has(t.value)) {
          while (isPunct(ts[i], ',') && (ts[i + 1]?.type === 'ident' || ts[i + 1]?.type === 'num')) {
            value += ',' + ts[i + 1].value;
            end = ts[i + 1].to;
            i += 2;
          }
        }
        out.attrs[t.value] = value;
        out.attrList.push({ key: t.value, value, span: { from: t.from, to: end } });
        continue;
      }
      if (t.type !== 'bad') err(t, `予期しないトークン "${src.slice(t.from, t.to)}"`);
      i++;
    }
  };

  /** Label, `at (x, y)`, `size WxH`, attributes and classes of a shape-like statement. */
  const parseShapeTail = (ts: Tok[], i: number) => {
    const g = { x: 0, y: 0, w: 140, h: 60, at: undefined as Span | undefined, size: undefined as Span | undefined };
    const out = newOut();
    parseTail(ts, i, NODE_ATTRS, out, (ts, i) => {
      const t = ts[i];
      if (t.type === 'ident' && t.value === 'at' && !isPunct(ts[i + 1], '=')) {
        const [lp, a, cm, b, rp] = ts.slice(i + 1, i + 6);
        if (isPunct(lp, '(') && a?.type === 'num' && isPunct(cm, ',') && b?.type === 'num' && isPunct(rp, ')')) {
          g.x = Number(a.value);
          g.y = Number(b.value);
          g.at = { from: t.from, to: rp.to };
          return i + 6;
        }
        err(t, '座標は at (x, y) の形式です');
        return i + 1;
      }
      if (t.type === 'ident' && t.value === 'size' && !isPunct(ts[i + 1], '=')) {
        const s = ts[i + 1];
        if (s?.type === 'size') {
          const [sw, sh] = s.value.split('x').map(Number);
          g.w = sw;
          g.h = sh;
          g.size = { from: t.from, to: s.to };
          return i + 2;
        }
        err(t, 'サイズは size 160x60 の形式です');
        return i + 1;
      }
      return undefined;
    });
    return { g, out };
  };

  const makeNode = (kind: ShapeKind, idTok: Tok, ts: Tok[], i: number, st: Stmt, stmtSpan: Span, lines: Span, extra: Partial<StmtSpans> = {}) => {
    const { g, out } = parseShapeTail(ts, i);
    if (g.w <= 0 || g.h <= 0) err(g.size ?? idTok, 'サイズは正の値にしてください');
    const raw = rawAt.get(st.lineStart);
    const node: NodeDef = {
      id: idTok.value,
      kind,
      label: out.label?.value ?? '',
      x: g.x,
      y: g.y,
      w: Math.max(1, g.w),
      h: Math.max(1, g.h),
      attrs: out.attrs,
      attrList: out.attrList,
      classes: out.classes,
      line: st.line,
      spans: { stmt: stmtSpan, lines: raw ? { from: lines.from, to: Math.min(src.length, nextLine(src, raw.bodyTo)) } : lines, label: out.label?.span, at: g.at, size: g.size, id: { from: idTok.from, to: idTok.to }, ...extra },
    };
    if (raw) node.body = { text: dedent(src.slice(raw.bodyFrom, raw.bodyTo).replace(/\n$/, '')), span: { from: raw.bodyFrom, to: raw.bodyTo }, braces: true };
    else if (RAW_KINDS.has(kind)) node.body = { text: '', span: { from: stmtSpan.to, to: stmtSpan.to }, braces: false };
    return { node, g };
  };

  for (const st of stmts) {
    const ts = st.toks;
    const head = ts[0];
    const stmtSpan: Span = { from: head.from, to: ts[ts.length - 1].to };
    const lines: Span = { from: st.lineStart, to: st.lineEnd };
    const scope = scopeOf(head.from);
    const blockType = scope >= 0 ? scan.blocks[scope].type : undefined;

    // page / layout headers
    const bi = headerAt.get(st.lineStart);
    if (bi !== undefined && head.type === 'ident' && (head.value === 'page' || head.value === 'layout')) {
      const b = scan.blocks[bi];
      const base = { line: b.line, header: stmtSpan, lines: { from: b.lineStart, to: b.end }, insertAt: b.bodyTo, indent: b.indent };
      if (head.value === 'page') {
        let i = 1;
        let id = `p${P.pages.length + 1}`;
        if (ts[1]?.type === 'ident' && !isPunct(ts[2], '=')) {
          id = ts[1].value;
          i = 2;
        }
        const out = newOut();
        parseTail(ts, i, PAGE_ATTRS, out);
        if (P.pages.some((p) => p.id === id)) err(ts[1] ?? head, `ページ ID "${id}" が重複しています`, 'duplicate-id');
        const page: PageInfo = { ...base, id, label: out.label?.value ?? '', layout: out.attrs.layout };
        P.pages.push(page);
        P.info[bi] = page;
      } else {
        const name = ts[1]?.type === 'ident' ? ts[1].value : '';
        if (!name) err(head, 'layout には名前が必要です（例: layout base {）');
        let parent: string | undefined;
        let i = 2;
        if (ts[2]?.type === 'ident' && ts[2].value === 'extends') {
          if (ts[3]?.type === 'ident') parent = ts[3].value;
          else err(ts[2], 'extends の後に親レイアウト名が必要です');
          i = 4;
        }
        for (const t of ts.slice(i)) if (t.type !== 'bad') err(t, `予期しないトークン "${src.slice(t.from, t.to)}"`);
        if (P.layouts.some((l) => l.name === name)) err(ts[1] ?? head, `レイアウト "${name}" が重複しています`, 'duplicate-id');
        const lay: LayoutInfo = { ...base, name, extends: parent, slots: [] };
        P.layouts.push(lay);
        P.info[bi] = lay;
      }
      continue;
    }

    const fromEnd = parseEnd(ts, 0);
    if (head.type !== 'ident' && !(fromEnd && ts[fromEnd.next]?.type === 'op')) {
      if (head.type !== 'bad') err(head, '文の先頭には図形の種類か ID が必要です');
      continue;
    }

    // style NAME { key: value; ... }
    if (head.value === 'style' && ts[1]?.type === 'ident') {
      const name = ts[1].value;
      const props: Record<string, string> = {};
      if (!isPunct(ts[2], '{')) {
        err(ts[1], 'style には { ... } が必要です');
        continue;
      }
      let i = 3;
      while (i < ts.length && !isPunct(ts[i], '}')) {
        const k = ts[i];
        if (k.type === 'ident' && isPunct(ts[i + 1], ':') && ts[i + 2]) {
          if (!NODE_ATTRS.has(k.value) && !EDGE_ATTRS.has(k.value) && !CELL_ATTRS.has(k.value)) err(k, `不明な属性 "${k.value}"`, 'unknown-attr', 'warning');
          // the value runs to `;` / `}` (so `family: M PLUS 1p;` needs no quotes)
          let j = i + 2;
          while (j + 1 < ts.length && !isPunct(ts[j + 1], ';') && !isPunct(ts[j + 1], '}') && !(ts[j + 1].type === 'ident' && isPunct(ts[j + 2], ':'))) j++;
          props[k.value] = j === i + 2 ? ts[i + 2].value : src.slice(ts[i + 2].from, ts[j].to).trim();
          i = j + 1;
        } else if (isPunct(k, ';') || isPunct(k, ',')) {
          i++;
        } else {
          err(k, 'style の中身は "key: value;" の形式です');
          i++;
        }
      }
      if (i >= ts.length) err(head, 'style の } が閉じられていません');
      styles.set(name, { name, props, line: st.line });
      continue;
    }

    // set key=value ...
    if (head.value === 'set') {
      const out = newOut();
      parseTail(ts, 1, SETTINGS_KEYS as Set<string>, out);
      for (const [k, v] of Object.entries(out.attrs)) {
        if (k === 'family') {
          settings.family = v;
          settingsAttrs[k] = v;
          continue;
        }
        if (k === 'canvas') {
          const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(v);
          if (m) {
            canvas = { w: Number(m[1]), h: Number(m[2]) };
            settingsAttrs[k] = v;
          } else err(out.attrList.find((a) => a.key === k)!.span, 'canvas は 1280x720 の形式です');
          continue;
        }
        const num = Number(v);
        if (SETTINGS_KEYS.has(k as keyof Settings) && Number.isFinite(num)) {
          (settings as unknown as Record<string, number>)[k] = num;
          settingsAttrs[k] = v;
        }
      }
      settingsSpan ??= stmtSpan;
      continue;
    }

    // edge: end op end ...   (end = id | id.port | (x, y) | +(dx, dy))
    if (fromEnd && ts[fromEnd.next]?.type === 'op') {
      const opTok = ts[fromEnd.next];
      const toEnd = parseEnd(ts, fromEnd.next + 1);
      if (!toEnd) {
        err(opTok, '矢印の行き先がありません（図形の ID か (x, y)）');
        continue;
      }
      for (const end of [fromEnd, toEnd]) {
        if (end.port !== undefined && !PORTS.has(end.port)) err(end.portTok!, `ポートは n / e / s / w のいずれかです`);
      }
      if (fromEnd.pt?.rel && toEnd.pt?.rel) err(stmtSpan, '+(dx, dy) は片側だけに使えます（もう一方の端からの相対位置です）');
      const out = newOut();
      parseTail(ts, toEnd.next, EDGE_ATTRS, out);
      const port = (p?: string) => (p && PORTS.has(p) ? (p as Port) : undefined);
      P.edges.push({
        scope,
        def: {
          key: '',
          from: fromEnd.id,
          to: toEnd.id,
          fromPt: fromEnd.pt,
          toPt: toEnd.pt,
          fromPort: port(fromEnd.port),
          toPort: port(toEnd.port),
          op: opTok.value as ArrowOp,
          label: out.label?.value ?? '',
          attrs: out.attrs,
          attrList: out.attrList,
          classes: out.classes,
          line: st.line,
          spans: {
            stmt: stmtSpan,
            lines,
            label: out.label?.span,
            op: { from: opTok.from, to: opTok.to },
            fromRef: fromEnd.span,
            toRef: toEnd.span,
          },
        },
      });
      continue;
    }
    if (head.type !== 'ident') continue;

    // layout: slot NAME [kind] ["sample"] at (x, y) size WxH ...
    if (blockType === 'layout' && head.value === 'slot') {
      const nameTok = ts[1];
      if (nameTok?.type !== 'ident' || resolveKind(nameTok.value)) {
        err(nameTok ?? head, 'slot の名前がありません（例: slot title at (40, 30) size 1200x70）');
        continue;
      }
      const kindTok = kindAt(ts, 2);
      const kind = kindTok ? resolveKind(kindTok.value) : 'text';
      if (!kind) {
        err(kindTok!, `不明な図形 "${kindTok!.value}"`);
        continue;
      }
      const { node } = makeNode(kind, nameTok, ts, kindTok ? 3 : 2, st, stmtSpan, lines, { kind: kindTok && { from: kindTok.from, to: kindTok.to }, head: kindTok && { from: kindTok.from, to: kindTok.to } });
      node.slot = node.id;
      P.slots.push({ def: node, scope });
      (P.info[scope] as LayoutInfo | undefined)?.slots.push(node.id);
      continue;
    }

    // page: hide ID ...
    if (blockType === 'page' && head.value === 'hide' && ts[1]?.type === 'ident' && !resolveKind(ts[1].value)) {
      for (const t of ts.slice(1)) {
        if (t.type === 'ident') P.hides.push({ id: t.value, span: { from: t.from, to: t.to }, scope });
        else if (!isPunct(t, ',')) err(t, `予期しないトークン "${src.slice(t.from, t.to)}"`);
      }
      continue;
    }

    // node: kind id ...
    const kind = resolveKind(head.value);
    if (!kind) {
      // page: SLOT [kind] ["text"] ...  — fills a slot of the page's layout (checked when the page is built)
      if (blockType === 'page') {
        const kindTok = kindAt(ts, 1);
        const fk = kindTok ? resolveKind(kindTok.value) : undefined;
        if (kindTok && !fk) {
          err(kindTok, `不明な図形 "${kindTok.value}"`);
          continue;
        }
        const { node, g } = makeNode(fk ?? 'text', head, ts, kindTok ? 2 : 1, st, stmtSpan, lines, { kind: kindTok && { from: kindTok.from, to: kindTok.to }, head: kindTok && { from: kindTok.from, to: kindTok.to } });
        node.slot = head.value;
        P.fills.push({ def: node, given: { at: !!g.at, size: !!g.size, kind: !!kindTok }, scope });
        continue;
      }
      err(head, `不明な図形 "${head.value}"（${SHAPE_KINDS.join(' / ')}）`);
      continue;
    }
    const idTok = ts[1];
    if (idTok?.type !== 'ident') {
      err(idTok ?? head, '図形の ID がありません（例: rect api "API"）');
      continue;
    }
    const { node } = makeNode(kind, idTok, ts, 2, st, stmtSpan, lines, { kind: { from: head.from, to: head.to } });
    P.nodes.push({ def: node, scope });
  }

  P.canvas = canvas;
  P.settingsSpan = settingsSpan;

  // layouts / pages: references
  const layoutNames = new Set(P.layouts.map((l) => l.name));
  for (const l of P.layouts) {
    if (l.extends && !layoutNames.has(l.extends)) err(l.header, `レイアウト "${l.extends}" がありません`, 'unknown-ref');
    else if (layoutChain(P, l.name).length === 0) err(l.header, 'レイアウトの継承が循環しています', 'cycle');
  }
  for (const p of P.pages) {
    if (p.layout && !layoutNames.has(p.layout)) err(p.header, `レイアウト "${p.layout}" がありません`, 'unknown-ref');
    if (!p.layout && layoutNames.has('default')) p.layout = 'default';
  }
  if (scan.blocks.length) {
    for (const n of P.nodes) if (n.scope < 0) err(n.def.spans.stmt, 'page / layout の外の図形は表示されません', 'outside-page', 'warning');
    for (const e of P.edges) if (e.scope < 0) err(e.def.spans.stmt, 'page / layout の外の矢印は表示されません', 'outside-page', 'warning');
  }
  return P;
}

const PAGE_ATTRS = new Set(['layout']);

/** Lines without their common indentation. */
export function dedent(text: string): string {
  const lines = text.split('\n');
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) ? lines.map((l) => l.slice(Math.min(ind, /^[ \t]*/.exec(l)![0].length))).join('\n') : text;
}

/** An optional shape kind right after a slot name (not `at` / `size` / `key=`). */
function kindAt(ts: Tok[], i: number): Tok | undefined {
  const t = ts[i];
  return t?.type === 'ident' && t.value !== 'at' && t.value !== 'size' && !isPunct(ts[i + 1], '=') ? t : undefined;
}

function nextLine(src: string, pos: number): number {
  const i = src.indexOf('\n', pos);
  return i < 0 ? src.length : i + 1;
}

/** Layout names from the root ancestor down to `name`; empty on a cycle or unknown name. */
function layoutChain(P: Parsed, name: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = name;
  while (cur) {
    if (out.includes(cur)) return [];
    const l = P.layouts.find((x) => x.name === cur);
    if (!l) return [];
    out.unshift(cur);
    cur = l.extends;
  }
  return out;
}

// ───────────────────────────── documents ─────────────────────────────

/** Builds a Doc from nodes / edges: ids, edge keys and references are checked here. */
function assemble(P: Parsed, nodeIn: NodeDef[], edgeIn: EdgeDef[], extra: Diagnostic[] = []): Doc {
  const diagnostics = [...P.diagnostics, ...extra];
  const err = (span: Span, message: string, code: string, severity: Diagnostic['severity'] = 'error') => diagnostics.push({ ...span, message, code, severity });
  const nodes: NodeDef[] = [];
  const nodeMap = new Map<string, NodeDef>();
  for (const n of nodeIn) {
    if (nodeMap.has(n.id)) {
      err(n.spans.id ?? n.spans.stmt, `ID "${n.id}" が重複しています`, 'duplicate-id');
      continue;
    }
    nodes.push(n);
    nodeMap.set(n.id, n);
    if (n.body && !RAW_KINDS.has(n.kind) && !n.locked) err(n.spans.stmt, `{ } の中身は table / list でだけ使えます（${n.kind} では無視されます）`, 'syntax', 'warning');
  }

  // resolve edges after all nodes are known (forward references are fine)
  const edges: EdgeDef[] = [];
  const seen = new Map<string, number>();
  for (const e0 of edgeIn) {
    const e = { ...e0 };
    let ok = true;
    for (const id of [e.from, e.to]) {
      if (id !== POINT_END && !nodeMap.has(id)) {
        if (!e.locked) err(e.spans.stmt, `存在しない図形 "${id}" への矢印です`, 'unknown-ref');
        ok = false;
      }
    }
    if (!ok) continue;
    const base = `${e.from}${e.op}${e.to}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    e.key = `${base}#${n}`;
    edges.push(e);
  }

  for (const nd of nodes) {
    if (nd.locked) continue;
    for (const c of nd.classes) if (!P.styles.has(c)) diagnostics.push({ ...nd.spans.stmt, severity: 'warning', code: 'unknown-style', message: `style "${c}" が定義されていません` });
    const parent = nd.attrs.in;
    if (parent !== undefined) {
      if (!nodeMap.has(parent)) diagnostics.push({ ...nd.spans.stmt, severity: 'error', code: 'unknown-ref', message: `親 "${parent}" が存在しません` });
      else if (createsCycle(nodeMap, nd.id)) diagnostics.push({ ...nd.spans.stmt, severity: 'error', code: 'cycle', message: '親子関係が循環しています' });
    }
  }

  return { nodes, nodeMap, edges, styles: P.styles, settings: P.settings, settingsSpan: P.settingsSpan, settingsAttrs: P.settingsAttrs, diagnostics, canvas: P.canvas };
}

const lockNode = (n: NodeDef, vars?: Record<string, string>): NodeDef => ({ ...n, locked: true, label: vars ? n.label.replace(/\{(page|pages|title)\}/g, (m, k: string) => vars[k] ?? m) : n.label });
const lockEdge = (e: EdgeDef): EdgeDef => ({ ...e, locked: true });

function sortByLine<T extends { def: { spans: StmtSpans } }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.def.spans.stmt.from - b.def.spans.stmt.from);
}

/** One page of a deck: the layout chain's shapes (locked), slots filled by the page, and the page's own shapes. */
function buildPage(P: Parsed, pi: number): Doc {
  const page = P.pages[pi];
  const scope = P.info.indexOf(page);
  const chain = page.layout ? layoutChain(P, page.layout) : [];
  const chainScopes = chain.map((name) => P.info.findIndex((x) => 'name' in x && x.name === name));
  const extra: Diagnostic[] = [];
  const hides = P.hides.filter((h) => h.scope === scope);
  const hidden = new Set(hides.map((h) => h.id));

  // slots: a child layout's slot replaces the parent's one of the same name
  const slots = new Map<string, NodeDef>();
  for (const s of chainScopes) for (const sl of P.slots) if (sl.scope === s) slots.set(sl.def.id, sl.def);

  const fills = P.fills.filter((f) => f.scope === scope);
  const title = fills.find((f) => f.def.slot === 'title')?.def.label ?? page.label;
  const vars = { page: String(pi + 1), pages: String(P.pages.length), title };

  const fixed: NodeDef[] = [];
  const layoutIds = new Set<string>();
  for (const s of chainScopes)
    for (const n of P.nodes)
      if (n.scope === s) {
        layoutIds.add(n.def.id);
        if (!hidden.has(n.def.id)) fixed.push(lockNode(n.def, vars));
      }
  for (const h of hides) if (!layoutIds.has(h.id) && !slots.has(h.id)) extra.push({ ...h.span, severity: 'warning', code: 'unknown-ref', message: `レイアウトに "${h.id}" がありません` });

  const filled = new Map<string, NodeDef>();
  for (const f of fills) {
    const slot = slots.get(f.def.slot!);
    if (!slot) {
      extra.push({ ...f.def.spans.id!, severity: 'error', code: 'unknown-ref', message: page.layout ? `不明な図形またはスロット "${f.def.slot}"（レイアウト ${page.layout} のスロット: ${[...slots.keys()].join(', ') || 'なし'}）` : `不明な図形 "${f.def.slot}"（スロットを使うには page に layout= を指定）` });
      continue;
    }
    if (filled.has(slot.id)) {
      extra.push({ ...f.def.spans.id!, severity: 'error', code: 'duplicate-id', message: `スロット "${slot.id}" が二重に埋められています` });
      continue;
    }
    if (hidden.has(slot.id)) continue;
    const kind = f.given.kind ? f.def.kind : slot.kind;
    filled.set(slot.id, {
      ...f.def,
      kind,
      // a list / table slot filled without `{ }` yet: its body goes at the end of the line
      ...(RAW_KINDS.has(kind) && !f.def.body ? { body: { text: '', span: { from: f.def.spans.stmt.to, to: f.def.spans.stmt.to }, braces: false } } : {}),
      x: f.given.at ? f.def.x : slot.x,
      y: f.given.at ? f.def.y : slot.y,
      w: f.given.size ? f.def.w : slot.w,
      h: f.given.size ? f.def.h : slot.h,
      attrs: { ...slot.attrs, ...f.def.attrs },
      classes: [...slot.classes, ...f.def.classes],
    });
  }
  const placeholders = [...slots.values()].filter((s) => !filled.has(s.id) && !hidden.has(s.id)).map((s) => ({ ...s, locked: true }));

  // the page's statements in source order (fills keep their place among the page's own shapes)
  const own = sortByLine([...P.nodes.filter((n) => n.scope === scope), ...fills.filter((f) => filled.get(f.def.slot!)?.spans === f.def.spans).map((f) => ({ def: filled.get(f.def.slot!)! }))]).map((x) => x.def);
  const edges = [
    ...chainScopes.flatMap((s) => P.edges.filter((e) => e.scope === s).map((e) => lockEdge(e.def))),
    ...P.edges.filter((e) => e.scope === scope).map((e) => e.def),
  ];
  const doc = assemble(P, [...fixed, ...own], edges, extra);
  doc.canvas ??= DEFAULT_CANVAS;
  doc.deck = { pages: P.pages, layouts: P.layouts, view: { page: page.id }, block: page, placeholders };
  return doc;
}

/** One layout for editing: its ancestors' shapes and slots locked, its own shapes and slots editable. */
function buildLayout(P: Parsed, li: number): Doc {
  const lay = P.layouts[li];
  const chain = layoutChain(P, lay.name);
  const scopeOf = (name: string) => P.info.findIndex((x) => 'name' in x && x.name === name);
  const own = P.info.indexOf(lay);
  const parents = chain.slice(0, -1).map(scopeOf);
  const ownSlots = new Set(P.slots.filter((s) => s.scope === own).map((s) => s.def.id));
  // page variables shown with their widest value (the last page number)
  const n = String(Math.max(1, P.pages.length));
  const vars = { page: n, pages: n, title: P.slots.find((s) => s.def.id === 'title')?.def.label || 'タイトル' };
  const nodes: NodeDef[] = [];
  for (const s of parents) {
    for (const n of P.nodes) if (n.scope === s) nodes.push(lockNode(n.def, vars));
    for (const sl of P.slots) if (sl.scope === s && !ownSlots.has(sl.def.id)) nodes.push(lockNode(sl.def));
  }
  // own shapes stay editable (their label is the source text), so they are measured with the values filled in
  const shown = (d: NodeDef) => (/\{(page|pages|title)\}/.test(d.label) ? { ...lockNode(d, vars), locked: false, labelSource: d.label } : d);
  nodes.push(...sortByLine([...P.nodes.filter((n) => n.scope === own), ...P.slots.filter((s) => s.scope === own)]).map((x) => shown(x.def)));
  const edges = [...parents.flatMap((s) => P.edges.filter((e) => e.scope === s).map((e) => lockEdge(e.def))), ...P.edges.filter((e) => e.scope === own).map((e) => e.def)];
  const doc = assemble(P, nodes, edges);
  doc.canvas ??= DEFAULT_CANVAS;
  doc.deck = { pages: P.pages, layouts: P.layouts, view: { layout: lay.name }, block: lay, placeholders: [] };
  return doc;
}

const cache = new Map<string, Parsed>();
function parsedOf(src: string): Parsed {
  let p = cache.get(src);
  if (!p) {
    p = parseFile(src);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    cache.set(src, p);
  }
  return p;
}

/**
 * Parses the DSL. A file with `page` / `layout` blocks is a deck: the Doc is then the given view
 * (default: the first page), built from that page's layout and its own statements.
 */
export function parse(src: string, view?: View): Doc {
  const P = parsedOf(src);
  if (!P.blocks.length) return assemble(P, P.nodes.map((n) => n.def), P.edges.map((e) => e.def));
  if (view && 'layout' in view) {
    const li = P.layouts.findIndex((l) => l.name === view.layout);
    if (li >= 0) return buildLayout(P, li);
  }
  const pi = view && 'page' in view ? P.pages.findIndex((p) => p.id === view.page) : -1;
  if (pi >= 0 || P.pages.length) return buildPage(P, Math.max(0, pi));
  return buildLayout(P, 0);
}

/** Every view of a file: its pages, then its layouts (a plain diagram has one view, `undefined`). */
export function views(src: string): (View | undefined)[] {
  const P = parsedOf(src);
  if (!P.blocks.length) return [undefined];
  return [...P.pages.map((p) => ({ page: p.id })), ...P.layouts.map((l) => ({ layout: l.name }))];
}

/** The view a Doc was built for (pass it back to `parse` after patching the source). */
export const viewOf = (doc: Doc): View | undefined => doc.deck?.view;

function createsCycle(map: Map<string, NodeDef>, id: string): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = id;
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = map.get(cur)?.attrs.in;
  }
  return false;
}

/** Ancestors of a node via `in=` (nearest first), cycle-safe. */
export function ancestors(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let cur = doc.nodeMap.get(id)?.attrs.in;
  while (cur && !seen.has(cur) && doc.nodeMap.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = doc.nodeMap.get(cur)?.attrs.in;
  }
  return out;
}

/** All descendants of the given nodes via `in=`. */
export function descendants(doc: Doc, ids: Iterable<string>): Set<string> {
  const roots = new Set(ids);
  const out = new Set<string>();
  for (const n of doc.nodes) {
    if (roots.has(n.id)) continue;
    if (ancestors(doc, n.id).some((a) => roots.has(a))) out.add(n.id);
  }
  return out;
}

/** Source text of an arrow end: `api`, `api.e`, `(300, 120)` or `+(80, 0)`. */
export function endText(e: EdgeDef, which: 'from' | 'to'): string {
  const pt = which === 'from' ? e.fromPt : e.toPt;
  if (pt) return `${pt.rel ? '+' : ''}(${fmtCoord(pt.x)}, ${fmtCoord(pt.y)})`;
  const port = which === 'from' ? e.fromPort : e.toPort;
  return (which === 'from' ? e.from : e.to) + (port ? '.' + port : '');
}

function fmtCoord(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
}

export function isArrowOp(s: string): s is ArrowOp {
  return (ARROW_OPS as readonly string[]).includes(s);
}
