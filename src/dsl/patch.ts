/**
 * Minimal, comment-preserving rewrites of the DSL source.
 * Every UI mutation goes through these helpers so that the text stays the
 * single source of truth and diffs stay small.
 */
import { endText, parse } from './parse';
import { POINT_END, type ArrowOp, type Doc, type EdgeDef, type NodeDef, type Port, type ShapeKind, type Span } from './types';

export interface Edit {
  from: number;
  to: number;
  insert: string;
}

export function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.from - a.from || b.to - a.to);
  let out = src;
  let guard = Infinity;
  for (const e of sorted) {
    if (e.to > guard) continue; // drop overlapping edits defensively
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
    guard = e.from;
  }
  return out;
}

export function fmtNum(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
}

/** Inverse of the string tokenizer in parse.ts: TeX inside `$...$` keeps its backslashes. */
export function quote(s: string): string {
  let out = '';
  let math = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const nx = s[i + 1];
    if (c === '\\' && nx === '$') {
      out += '\\$';
      i++;
    } else if (math && c === '\\' && nx !== undefined && nx !== '"' && nx !== '\n') {
      out += c + nx;
      i++;
    } else {
      if (c === '$') math = !math;
      out += c === '"' ? '\\"' : c === '\n' ? (math ? ' ' : '\\n') : c === '\\' && !math ? '\\\\' : c;
    }
  }
  return '"' + out + '"';
}

const BARE_VALUE = /^(#[0-9a-fA-F]{3,8}|-?\d*\.?\d+|[\p{L}_][\p{L}\p{N}_]*(?:,[\p{L}_][\p{L}\p{N}_]*)*)$/u;
export function fmtValue(v: string): string {
  return BARE_VALUE.test(v) ? v : quote(v);
}

export function isValidId(s: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*(?:-(?![->])[\p{L}\p{N}_]+)*$/u.test(s);
}

/** Remove a span together with the whitespace before it. */
function removeSpan(src: string, span: Span): Edit {
  let from = span.from;
  while (from > 0 && (src[from - 1] === ' ' || src[from - 1] === '\t')) from--;
  return { from, to: span.to, insert: '' };
}

function attrEdits(src: string, def: NodeDef | EdgeDef, key: string, value: string | undefined): Edit[] {
  const entry = def.attrList.filter((a) => a.key === key);
  if (value === undefined) return entry.map((a) => removeSpan(src, a.span));
  const text = `${key}=${fmtValue(value)}`;
  if (entry.length) {
    return [{ from: entry[0].span.from, to: entry[0].span.to, insert: text }, ...entry.slice(1).map((a) => removeSpan(src, a.span))];
  }
  return [{ from: def.spans.stmt.to, to: def.spans.stmt.to, insert: ' ' + text }];
}

export interface Geom {
  x: number;
  y: number;
  w: number;
  h: number;
}

function geomEdits(node: NodeDef, g: Partial<Geom>): Edit[] {
  const edits: Edit[] = [];
  const x = g.x ?? node.x;
  const y = g.y ?? node.y;
  const w = g.w ?? node.w;
  const h = g.h ?? node.h;
  const atText = `at (${fmtNum(x)}, ${fmtNum(y)})`;
  const sizeText = `size ${fmtNum(Math.max(1, w))}x${fmtNum(Math.max(1, h))}`;
  const afterHead = node.spans.label?.to ?? node.spans.id!.to;
  if (g.x !== undefined || g.y !== undefined) {
    if (node.spans.at) edits.push({ ...node.spans.at, insert: atText });
    else edits.push({ from: afterHead, to: afterHead, insert: ' ' + atText });
  }
  if (g.w !== undefined || g.h !== undefined) {
    if (node.spans.size) edits.push({ ...node.spans.size, insert: sizeText });
    else {
      const pos = node.spans.at?.to ?? afterHead;
      // if `at` is being inserted at the same position, merge to keep order
      const sameSpot = edits.find((e) => e.from === pos && e.to === pos);
      if (sameSpot) sameSpot.insert += ' ' + sizeText;
      else edits.push({ from: pos, to: pos, insert: ' ' + sizeText });
    }
  }
  return edits;
}

export function setNodesGeom(src: string, doc: Doc, geoms: Map<string, Partial<Geom>> | Record<string, Partial<Geom>>): string {
  const entries = geoms instanceof Map ? [...geoms.entries()] : Object.entries(geoms);
  const edits: Edit[] = [];
  for (const [id, g] of entries) {
    const node = doc.nodeMap.get(id);
    if (node) edits.push(...geomEdits(node, g));
  }
  return applyEdits(src, edits);
}

export function setNodeLabel(src: string, doc: Doc, id: string, label: string): string {
  const node = doc.nodeMap.get(id);
  if (!node) return src;
  if (node.spans.label) {
    if (!label) return applyEdits(src, [removeSpan(src, node.spans.label)]);
    return applyEdits(src, [{ ...node.spans.label, insert: quote(label) }]);
  }
  if (!label) return src;
  const pos = node.spans.id!.to;
  return applyEdits(src, [{ from: pos, to: pos, insert: ' ' + quote(label) }]);
}

export function setNodesAttr(src: string, doc: Doc, ids: Iterable<string>, key: string, value: string | undefined): string {
  const edits: Edit[] = [];
  for (const id of ids) {
    const node = doc.nodeMap.get(id);
    if (node) edits.push(...attrEdits(src, node, key, value));
  }
  return applyEdits(src, edits);
}

export function setNodesKind(src: string, doc: Doc, ids: Iterable<string>, kind: ShapeKind): string {
  const edits: Edit[] = [];
  for (const id of ids) {
    const node = doc.nodeMap.get(id);
    if (node?.spans.kind) edits.push({ ...node.spans.kind, insert: kind });
  }
  return applyEdits(src, edits);
}

export function renameNode(src: string, doc: Doc, oldId: string, newId: string): string {
  const node = doc.nodeMap.get(oldId);
  if (!node || !isValidId(newId) || doc.nodeMap.has(newId)) return src;
  const edits: Edit[] = [{ ...node.spans.id!, insert: newId }];
  for (const e of doc.edges) {
    if (e.from === oldId) edits.push({ ...e.spans.fromRef!, insert: newId });
    if (e.to === oldId) edits.push({ ...e.spans.toRef!, insert: newId });
  }
  for (const n of doc.nodes) {
    const a = n.attrList.find((a) => a.key === 'in' && a.value === oldId);
    if (a) edits.push({ ...a.span, insert: `in=${newId}` });
  }
  return applyEdits(src, edits);
}

export function uniqueId(doc: Doc, base: string): string {
  const stem = base.replace(/\d+$/, '') || 'n';
  for (let i = 1; ; i++) {
    const id = `${stem}${i}`;
    if (!doc.nodeMap.has(id)) return id;
  }
}

export interface NewNode {
  kind: ShapeKind;
  id: string;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  attrs?: Record<string, string>;
  classes?: string[];
}

export function nodeLine(n: NewNode): string {
  let s = `${n.kind} ${n.id}`;
  if (n.label) s += ' ' + quote(n.label);
  s += ` at (${fmtNum(n.x)}, ${fmtNum(n.y)}) size ${fmtNum(n.w)}x${fmtNum(n.h)}`;
  for (const [k, v] of Object.entries(n.attrs ?? {})) s += ` ${k}=${fmtValue(v)}`;
  for (const c of n.classes ?? []) s += ` .${c}`;
  return s;
}

/** Insert lines right after `after` (a statement's line span) or at EOF. */
function insertLines(src: string, lines: string[], after: Span | undefined): string {
  const text = lines.join('\n');
  if (after) {
    const pos = after.to;
    const needsNl = pos > 0 && src[pos - 1] !== '\n';
    return src.slice(0, pos) + (needsNl ? '\n' : '') + text + '\n' + src.slice(pos);
  }
  const body = src.replace(/\s*$/, '');
  return (body ? body + '\n' : '') + text + '\n';
}

export function addNodes(src: string, doc: Doc, nodes: NewNode[]): string {
  const last = doc.nodes[doc.nodes.length - 1];
  return insertLines(src, nodes.map(nodeLine), last?.spans.lines);
}

export function edgeLine(from: string, to: string, op: ArrowOp = '->', opts: { fromPort?: Port; toPort?: Port; label?: string; attrs?: Record<string, string> } = {}): string {
  let s = `${from}${opts.fromPort ? '.' + opts.fromPort : ''} ${op} ${to}${opts.toPort ? '.' + opts.toPort : ''}`;
  if (opts.label) s += ' ' + quote(opts.label);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) s += ` ${k}=${fmtValue(v)}`;
  return s;
}

export function addEdgeLines(src: string, doc: Doc, lines: string[]): string {
  const lastEdge = doc.edges[doc.edges.length - 1];
  const lastNode = doc.nodes[doc.nodes.length - 1];
  const anchor = lastEdge && (!lastNode || lastEdge.spans.lines.from > lastNode.spans.lines.from) ? lastEdge : lastNode;
  if (!lastEdge && lastNode) {
    // first edge: separate from the node block with a blank line
    return insertLines(src, ['', ...lines], lastNode.spans.lines);
  }
  return insertLines(src, lines, anchor?.spans.lines);
}

export function addEdge(src: string, doc: Doc, from: string, to: string, op: ArrowOp = '->', opts: Parameters<typeof edgeLine>[3] = {}): string {
  return addEdgeLines(src, doc, [edgeLine(from, to, op, opts)]);
}

export function setEdgesAttr(src: string, doc: Doc, keys: Iterable<string>, key: string, value: string | undefined): string {
  const set = new Set(keys);
  const edits: Edit[] = [];
  for (const e of doc.edges) if (set.has(e.key)) edits.push(...attrEdits(src, e, key, value));
  return applyEdits(src, edits);
}

export function setEdgeLabel(src: string, doc: Doc, key: string, label: string): string {
  const e = doc.edges.find((e) => e.key === key);
  if (!e) return src;
  if (e.spans.label) {
    if (!label) return applyEdits(src, [removeSpan(src, e.spans.label)]);
    return applyEdits(src, [{ ...e.spans.label, insert: quote(label) }]);
  }
  if (!label) return src;
  const pos = endSpan(e, 'to').to;
  return applyEdits(src, [{ from: pos, to: pos, insert: ' ' + quote(label) }]);
}

/** Text for a free arrow end. */
export function pointText(x: number, y: number, rel = false): string {
  return `${rel ? '+' : ''}(${fmtNum(x)}, ${fmtNum(y)})`;
}

/** Span of an end's text, including a `.port` suffix. */
function endSpan(e: EdgeDef, which: 'from' | 'to'): Span {
  const ref = which === 'from' ? e.spans.fromRef! : e.spans.toRef!;
  const port = which === 'from' ? e.fromPort : e.toPort;
  return { from: ref.from, to: ref.to + (port ? 2 : 0) };
}

/** Re-point one end of arrows: `end` is `id`, `id.port`, `(x, y)` or `+(dx, dy)`. */
export function setEdgeEnds(src: string, doc: Doc, changes: { key: string; which: 'from' | 'to'; end: string }[]): string {
  const edits: Edit[] = [];
  for (const c of changes) {
    const e = doc.edges.find((x) => x.key === c.key);
    if (e) edits.push({ ...endSpan(e, c.which), insert: c.end });
  }
  return applyEdits(src, edits);
}

export function setEdgesOp(src: string, doc: Doc, keys: Iterable<string>, op: ArrowOp): string {
  const set = new Set(keys);
  return applyEdits(
    src,
    doc.edges.filter((e) => set.has(e.key) && e.spans.op).map((e) => ({ ...e.spans.op!, insert: op })),
  );
}

/** Delete nodes (and their edges) plus explicit edges. Children lose their `in=`. */
export function removeItems(src: string, doc: Doc, nodeIds: Iterable<string>, edgeKeys: Iterable<string> = []): string {
  const ids = new Set(nodeIds);
  const keys = new Set(edgeKeys);
  const edits: Edit[] = [];
  for (const n of doc.nodes) {
    if (ids.has(n.id)) edits.push({ ...n.spans.lines, insert: '' });
    else {
      const a = n.attrList.find((a) => a.key === 'in' && ids.has(a.value));
      if (a) edits.push(removeSpan(src, a.span));
    }
  }
  for (const e of doc.edges) {
    if (keys.has(e.key) || ids.has(e.from) || ids.has(e.to)) edits.push({ ...e.spans.lines, insert: '' });
  }
  return applyEdits(src, edits);
}

/** Text of the statements for the given nodes + edges between them (for copy). */
export function extractText(src: string, doc: Doc, nodeIds: Iterable<string>, edgeKeys: Iterable<string> = []): string {
  const ids = new Set(nodeIds);
  const keys = new Set(edgeKeys);
  const parts: string[] = [];
  for (const n of doc.nodes) if (ids.has(n.id)) parts.push(src.slice(n.spans.stmt.from, n.spans.stmt.to));
  const inside = (id: string) => id === POINT_END || ids.has(id);
  for (const e of doc.edges) if (keys.has(e.key) || (inside(e.from) && inside(e.to) && (ids.has(e.from) || ids.has(e.to)))) parts.push(src.slice(e.spans.stmt.from, e.spans.stmt.to));
  return parts.join('\n');
}

/**
 * Paste DSL text: nodes get fresh ids (if they collide) and are offset.
 * Returns the new source and the ids of inserted nodes.
 */
export function pasteText(src: string, doc: Doc, text: string, dx: number, dy: number): { src: string; ids: string[] } {
  const clip = parse(text);
  if (!clip.nodes.length && !clip.edges.length) return { src, ids: [] };
  const taken = new Set(doc.nodeMap.keys());
  const rename = new Map<string, string>();
  for (const n of clip.nodes) {
    let id = n.id;
    if (taken.has(id)) {
      const stem = id.replace(/\d+$/, '');
      for (let i = 2; taken.has((id = `${stem}${i}`)); i++);
    }
    taken.add(id);
    rename.set(n.id, id);
  }
  const nodeLines = clip.nodes.map((n) => {
    const attrs = { ...n.attrs };
    if (attrs.in !== undefined) {
      if (rename.has(attrs.in)) attrs.in = rename.get(attrs.in)!;
      else delete attrs.in;
    }
    return nodeLine({ kind: n.kind, id: rename.get(n.id)!, label: n.label, x: n.x + dx, y: n.y + dy, w: n.w, h: n.h, attrs, classes: n.classes });
  });
  let out = nodeLines.length ? insertAfterNodes(src, doc, nodeLines) : src;
  // absolute point ends move with the paste offset; relative ones follow their shape
  const end = (e: EdgeDef, which: 'from' | 'to') => {
    const pt = which === 'from' ? e.fromPt : e.toPt;
    if (pt) return pt.rel ? endText(e, which) : pointText(pt.x + dx, pt.y + dy);
    return rename.get(which === 'from' ? e.from : e.to)!;
  };
  const edgeLines = clip.edges.map((e) => edgeLine(end(e, 'from'), end(e, 'to'), e.op, { fromPort: e.fromPort, toPort: e.toPort, label: e.label, attrs: e.attrs }));
  if (edgeLines.length) out = addEdgeLines(out, parse(out), edgeLines);
  return { src: out, ids: [...rename.values()] };
}

function insertAfterNodes(src: string, doc: Doc, lines: string[]): string {
  const last = doc.nodes[doc.nodes.length - 1];
  return insertLines(src, lines, last?.spans.lines);
}

export function addNodeLines(src: string, doc: Doc, lines: string[]): string {
  return insertAfterNodes(src, doc, lines);
}

/** Rewrite (or insert) the first `set` line with one key changed. */
export function setSetting(src: string, doc: Doc, key: string, value: number | undefined): string {
  const attrs = { ...doc.settingsAttrs };
  if (value === undefined) delete attrs[key];
  else attrs[key] = fmtNum(value);
  const line = 'set ' + Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(' ');
  if (doc.settingsSpan) {
    if (!Object.keys(attrs).length) return applyEdits(src, [{ ...doc.settingsSpan, insert: '# set' }]);
    return applyEdits(src, [{ ...doc.settingsSpan, insert: line }]);
  }
  // insert after the leading comment block
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length && /^\s*(#|\/\/)/.test(lines[i])) i++;
  lines.splice(i, 0, line);
  return lines.join('\n');
}
