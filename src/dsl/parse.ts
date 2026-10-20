import {
  ARROW_OPS,
  DEFAULT_SETTINGS,
  POINT_END,
  SHAPE_KINDS,
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
  type StyleDef,
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

export const NODE_ATTRS = new Set(['fill', 'stroke', 'text', 'lw', 'dash', 'font', 'weight', 'in', 'overlap', 'skew', 'radius', 'opacity', 'valign', 'halign', 'dir', 'pad', 'rotate', 'ignore']);
export const EDGE_ATTRS = new Set(['stroke', 'lw', 'dash', 'route', 'bend', 'text', 'font', 'fromat', 'toat', 'ignore']);

/** Attributes whose value may be a comma-separated list: `ignore=overlap,through`. */
const LIST_ATTRS = new Set(['ignore']);

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
const SETTINGS_KEYS = new Set<keyof Settings>(['gap', 'grid', 'padding', 'fontmin', 'fontmax']);

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

export function parse(src: string): Doc {
  const toks = tokenize(src);
  const stmts = splitStatements(src, toks);
  const diagnostics: Diagnostic[] = [];
  const nodes: NodeDef[] = [];
  const nodeMap = new Map<string, NodeDef>();
  const pendingEdges: EdgeDef[] = [];
  const styles = new Map<string, StyleDef>();
  const settings: Settings = { ...DEFAULT_SETTINGS };
  let settingsSpan: Span | undefined;
  const settingsAttrs: Record<string, string> = {};

  const err = (t: { from: number; to: number }, message: string, code = 'syntax', severity: Diagnostic['severity'] = 'error') =>
    diagnostics.push({ from: t.from, to: t.to, message, code, severity });

  for (const t of toks) if (t.type === 'bad') err(t, src[t.from] === '"' ? '閉じられていない文字列です' : `不明な文字 "${t.value}"`);

  /** Parses `key=value` and `.class` items starting at index i. */
  const parseTail = (
    ts: Tok[],
    i: number,
    allowed: Set<string>,
    out: { attrs: Record<string, string>; attrList: AttrEntry[]; classes: string[]; label?: { value: string; span: Span } },
    extra?: (ts: Tok[], i: number) => number | undefined,
  ) => {
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
          while (isPunct(ts[i], ',') && ts[i + 1]?.type === 'ident') {
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

  for (const st of stmts) {
    const ts = st.toks;
    const head = ts[0];
    const stmtSpan: Span = { from: head.from, to: ts[ts.length - 1].to };
    const lines: Span = { from: st.lineStart, to: st.lineEnd };

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
          if (!NODE_ATTRS.has(k.value) && !EDGE_ATTRS.has(k.value)) err(k, `不明な属性 "${k.value}"`, 'unknown-attr', 'warning');
          props[k.value] = ts[i + 2].value;
          i += 3;
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
      const out = { attrs: {} as Record<string, string>, attrList: [] as AttrEntry[], classes: [] as string[] };
      parseTail(ts, 1, SETTINGS_KEYS as Set<string>, out);
      for (const [k, v] of Object.entries(out.attrs)) {
        const num = Number(v);
        if (SETTINGS_KEYS.has(k as keyof Settings) && Number.isFinite(num)) {
          settings[k as keyof Settings] = num;
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
      const out = { attrs: {} as Record<string, string>, attrList: [] as AttrEntry[], classes: [] as string[], label: undefined as { value: string; span: Span } | undefined };
      parseTail(ts, toEnd.next, EDGE_ATTRS, out);
      const port = (p?: string) => (p && PORTS.has(p) ? (p as Port) : undefined);
      pendingEdges.push({
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
      });
      continue;
    }
    if (head.type !== 'ident') continue;

    // node: kind id ...
    const kind = resolveKind(head.value);
    if (!kind) {
      err(head, `不明な図形 "${head.value}"（${SHAPE_KINDS.join(' / ')}）`);
      continue;
    }
    const idTok = ts[1];
    if (idTok?.type !== 'ident') {
      err(idTok ?? head, '図形の ID がありません（例: rect api "API"）');
      continue;
    }
    let x = 0,
      y = 0,
      w = 140,
      h = 60;
    let atSpan: Span | undefined;
    let sizeSpan: Span | undefined;
    const out = { attrs: {} as Record<string, string>, attrList: [] as AttrEntry[], classes: [] as string[], label: undefined as { value: string; span: Span } | undefined };
    parseTail(ts, 2, NODE_ATTRS, out, (ts, i) => {
      const t = ts[i];
      if (t.type === 'ident' && t.value === 'at' && !isPunct(ts[i + 1], '=')) {
        const [lp, a, cm, b, rp] = ts.slice(i + 1, i + 6);
        if (isPunct(lp, '(') && a?.type === 'num' && isPunct(cm, ',') && b?.type === 'num' && isPunct(rp, ')')) {
          x = Number(a.value);
          y = Number(b.value);
          atSpan = { from: t.from, to: rp.to };
          return i + 6;
        }
        err(t, '座標は at (x, y) の形式です');
        return i + 1;
      }
      if (t.type === 'ident' && t.value === 'size' && !isPunct(ts[i + 1], '=')) {
        const s = ts[i + 1];
        if (s?.type === 'size') {
          const [sw, sh] = s.value.split('x').map(Number);
          w = sw;
          h = sh;
          sizeSpan = { from: t.from, to: s.to };
          return i + 2;
        }
        err(t, 'サイズは size 160x60 の形式です');
        return i + 1;
      }
      return undefined;
    });
    if (nodeMap.has(idTok.value)) {
      err(idTok, `ID "${idTok.value}" が重複しています`, 'duplicate-id');
      continue;
    }
    if (w <= 0 || h <= 0) err(sizeSpan ?? idTok, 'サイズは正の値にしてください');
    const node: NodeDef = {
      id: idTok.value,
      kind,
      label: out.label?.value ?? '',
      x,
      y,
      w: Math.max(1, w),
      h: Math.max(1, h),
      attrs: out.attrs,
      attrList: out.attrList,
      classes: out.classes,
      line: st.line,
      spans: { stmt: stmtSpan, lines, label: out.label?.span, at: atSpan, size: sizeSpan, kind: { from: head.from, to: head.to }, id: { from: idTok.from, to: idTok.to } },
    };
    nodes.push(node);
    nodeMap.set(node.id, node);
  }

  // resolve edges after all nodes are known (forward references are fine)
  const edges: EdgeDef[] = [];
  const seen = new Map<string, number>();
  for (const e of pendingEdges) {
    let ok = true;
    for (const id of [e.from, e.to]) {
      if (id !== POINT_END && !nodeMap.has(id)) {
        err(e.spans.stmt, `存在しない図形 "${id}" への矢印です`, 'unknown-ref');
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
    for (const c of nd.classes) if (!styles.has(c)) diagnostics.push({ ...nd.spans.stmt, severity: 'warning', code: 'unknown-style', message: `style "${c}" が定義されていません` });
    const parent = nd.attrs.in;
    if (parent !== undefined) {
      if (!nodeMap.has(parent)) diagnostics.push({ ...nd.spans.stmt, severity: 'error', code: 'unknown-ref', message: `親 "${parent}" が存在しません` });
      else if (createsCycle(nodeMap, nd.id)) diagnostics.push({ ...nd.spans.stmt, severity: 'error', code: 'cycle', message: '親子関係が循環しています' });
    }
  }

  return { nodes, nodeMap, edges, styles, settings, settingsSpan, settingsAttrs, diagnostics };
}

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
