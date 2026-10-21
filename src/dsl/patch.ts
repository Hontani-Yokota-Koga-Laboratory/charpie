/**
 * Minimal, comment-preserving rewrites of the DSL source.
 * Every UI mutation goes through these helpers so that the text stays the
 * single source of truth and diffs stay small.
 */
import { endText, parse, viewOf } from './parse';
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
  const afterHead = node.spans.label?.to ?? node.spans.head?.to ?? node.spans.id!.to;
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
    const node = editable(doc, id);
    if (node) edits.push(...geomEdits(node, g));
  }
  return applyEdits(src, edits);
}

export function setNodeLabel(src: string, doc: Doc, id: string, label: string): string {
  const node = editable(doc, id);
  if (!node) return src;
  if (node.spans.label) {
    if (!label) return applyEdits(src, [removeSpan(src, node.spans.label)]);
    return applyEdits(src, [{ ...node.spans.label, insert: quote(label) }]);
  }
  if (!label) return src;
  const pos = (node.spans.head ?? node.spans.id!).to;
  return applyEdits(src, [{ from: pos, to: pos, insert: ' ' + quote(label) }]);
}

export function setNodesAttr(src: string, doc: Doc, ids: Iterable<string>, key: string, value: string | undefined): string {
  const edits: Edit[] = [];
  for (const id of ids) {
    const node = editable(doc, id);
    if (node) edits.push(...attrEdits(src, node, key, value));
  }
  return applyEdits(src, edits);
}

export function setNodesKind(src: string, doc: Doc, ids: Iterable<string>, kind: ShapeKind): string {
  const edits: Edit[] = [];
  for (const id of ids) {
    const node = editable(doc, id);
    if (node?.spans.kind) edits.push({ ...node.spans.kind, insert: kind });
  }
  return applyEdits(src, edits);
}

export function renameNode(src: string, doc: Doc, oldId: string, newId: string): string {
  const node = editable(doc, oldId);
  if (!node || node.slot || !isValidId(newId) || doc.nodeMap.has(newId)) return src;
  const edits: Edit[] = [{ ...node.spans.id!, insert: newId }];
  for (const e of doc.edges) {
    if (e.locked) continue;
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

/** A shape this view may change (not one inherited from the page's layout). */
function editable(doc: Doc, id: string): NodeDef | undefined {
  const n = doc.nodeMap.get(id);
  return n && !n.locked ? n : undefined;
}

const lastOf = <T extends { locked?: boolean }>(xs: T[]): T | undefined => xs.filter((x) => !x.locked).pop();

/** Insert lines right after `after` (a statement's line span), at the end of the view's page / layout block, or at EOF. */
function insertLines(src: string, lines: string[], after: Span | undefined, doc?: Doc): string {
  const block = doc?.deck?.block;
  const text = lines.map((l) => (l && block ? block.indent + l : l)).join('\n');
  const pos = after?.to ?? block?.insertAt;
  if (pos !== undefined) {
    const needsNl = pos > 0 && src[pos - 1] !== '\n';
    return src.slice(0, pos) + (needsNl ? '\n' : '') + text + '\n' + src.slice(pos);
  }
  const body = src.replace(/\s*$/, '');
  return (body ? body + '\n' : '') + text + '\n';
}

export function addNodes(src: string, doc: Doc, nodes: NewNode[]): string {
  return insertLines(src, nodes.map(nodeLine), lastOf(doc.nodes)?.spans.lines, doc);
}

export function edgeLine(from: string, to: string, op: ArrowOp = '->', opts: { fromPort?: Port; toPort?: Port; label?: string; attrs?: Record<string, string> } = {}): string {
  let s = `${from}${opts.fromPort ? '.' + opts.fromPort : ''} ${op} ${to}${opts.toPort ? '.' + opts.toPort : ''}`;
  if (opts.label) s += ' ' + quote(opts.label);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) s += ` ${k}=${fmtValue(v)}`;
  return s;
}

export function addEdgeLines(src: string, doc: Doc, lines: string[]): string {
  const lastEdge = lastOf(doc.edges);
  const lastNode = lastOf(doc.nodes);
  const anchor = lastEdge && (!lastNode || lastEdge.spans.lines.from > lastNode.spans.lines.from) ? lastEdge : lastNode;
  if (!lastEdge && lastNode) {
    // first edge: separate from the node block with a blank line
    return insertLines(src, ['', ...lines], lastNode.spans.lines, doc);
  }
  return insertLines(src, lines, anchor?.spans.lines, doc);
}

export function addEdge(src: string, doc: Doc, from: string, to: string, op: ArrowOp = '->', opts: Parameters<typeof edgeLine>[3] = {}): string {
  return addEdgeLines(src, doc, [edgeLine(from, to, op, opts)]);
}

export function setEdgesAttr(src: string, doc: Doc, keys: Iterable<string>, key: string, value: string | undefined): string {
  const set = new Set(keys);
  const edits: Edit[] = [];
  for (const e of doc.edges) if (set.has(e.key) && !e.locked) edits.push(...attrEdits(src, e, key, value));
  return applyEdits(src, edits);
}

export function setEdgeLabel(src: string, doc: Doc, key: string, label: string): string {
  const e = doc.edges.find((e) => e.key === key);
  if (!e || e.locked) return src;
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
    if (e && !e.locked) edits.push({ ...endSpan(e, c.which), insert: c.end });
  }
  return applyEdits(src, edits);
}

export function setEdgesOp(src: string, doc: Doc, keys: Iterable<string>, op: ArrowOp): string {
  const set = new Set(keys);
  return applyEdits(
    src,
    doc.edges.filter((e) => set.has(e.key) && !e.locked && e.spans.op).map((e) => ({ ...e.spans.op!, insert: op })),
  );
}

/** Delete nodes (and their edges) plus explicit edges. Children lose their `in=`. */
export function removeItems(src: string, doc: Doc, nodeIds: Iterable<string>, edgeKeys: Iterable<string> = []): string {
  const ids = new Set(nodeIds);
  const keys = new Set(edgeKeys);
  const edits: Edit[] = [];
  for (const n of doc.nodes) {
    if (n.locked) continue;
    if (ids.has(n.id)) edits.push({ ...n.spans.lines, insert: '' });
    else {
      const a = n.attrList.find((a) => a.key === 'in' && ids.has(a.value));
      if (a) edits.push(removeSpan(src, a.span));
    }
  }
  for (const e of doc.edges) {
    if (e.locked) continue;
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
  if (edgeLines.length) out = addEdgeLines(out, parse(out, viewOf(doc)), edgeLines);
  return { src: out, ids: [...rename.values()] };
}

function insertAfterNodes(src: string, doc: Doc, lines: string[]): string {
  return insertLines(src, lines, lastOf(doc.nodes)?.spans.lines, doc);
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

// ───────────────────────── decks: pages and layouts ─────────────────────────

export interface PageHeader {
  id: string;
  label?: string;
  layout?: string;
}

export function pageHeader(p: PageHeader): string {
  return `page ${p.id}${p.label ? ' ' + quote(p.label) : ''}${p.layout ? ` layout=${p.layout}` : ''}`;
}

/** A fresh page id: p1, p2, … not used yet. */
export function uniquePageId(doc: Doc, stem = 'p'): string {
  const taken = new Set(doc.deck?.pages.map((p) => p.id));
  for (let i = (doc.deck?.pages.length ?? 0) + 1; ; i++) if (!taken.has(`${stem}${i}`)) return `${stem}${i}`;
}

function blockText(src: string, lines: Span): string {
  const t = src.slice(lines.from, lines.to);
  return t.endsWith('\n') ? t : t + '\n';
}

/** Insert a whole block (with a blank line before it) after `after`, or at EOF. */
function insertBlock(src: string, text: string, after?: Span): string {
  if (after) {
    const pos = after.to;
    const pre = pos > 0 && src[pos - 1] !== '\n' ? '\n' : '';
    return src.slice(0, pos) + pre + '\n' + text + src.slice(pos);
  }
  const body = src.replace(/\s*$/, '');
  return (body ? body + '\n\n' : '') + text;
}

/**
 * Add a page after `after` (default: the last page). Without a deck, the file becomes one:
 * its existing shapes move into a first page.
 */
export function addPage(src: string, doc: Doc, p: PageHeader & { after?: string; lines?: string[] }): string {
  const body = (p.lines ?? []).map((l) => '  ' + l + '\n').join('');
  const text = `${pageHeader(p)} {\n${body}}\n`;
  if (!doc.deck) {
    if (![...doc.nodes, ...doc.edges].length) return insertBlock(src, text);
    return insertBlock(toDeck(src, doc), text);
  }
  const pages = doc.deck.pages;
  const anchor = pages.find((x) => x.id === p.after) ?? pages[pages.length - 1];
  return insertBlock(src, text, anchor?.lines);
}

/** A plain diagram as a one-page deck: its statements move into `page p1 { }` (settings and styles stay on top). */
export function toDeck(src: string, doc: Doc, id = 'p1'): string {
  if (doc.deck) return src;
  const first = Math.min(...[...doc.nodes, ...doc.edges].map((x) => x.spans.lines.from));
  if (!Number.isFinite(first)) return insertBlock(src, `page ${id} {\n}\n`);
  const head = src.slice(0, first);
  const wrapped = src
    .slice(first)
    .replace(/\s*$/, '')
    .split('\n')
    .map((l) => (l.trim() ? '  ' + l : l))
    .join('\n');
  return `${head}page ${id} {\n${wrapped}\n}\n`;
}

export function removePage(src: string, doc: Doc, id: string): string {
  const p = doc.deck?.pages.find((x) => x.id === id);
  if (!p) return src;
  // take one surrounding blank line with it
  let { from, to } = p.lines;
  if (src[to] === '\n') to++;
  else if (from > 0 && src[from - 1] === '\n' && src[from - 2] === '\n') from--;
  return src.slice(0, from) + src.slice(to);
}

/** Copy of a page right after it, with a new id. */
export function duplicatePage(src: string, doc: Doc, id: string, newId: string): string {
  const p = doc.deck?.pages.find((x) => x.id === id);
  if (!p) return src;
  const text = blockText(src, p.lines);
  const head = src.slice(p.header.from, p.header.to);
  const copy = text.replace(head, pageHeader({ id: newId, label: p.label, layout: src.slice(p.header.from, p.header.to).includes('layout=') ? p.layout : undefined }));
  return insertBlock(src, copy, p.lines);
}

/** Move a page so that it ends up at `index` among the pages. */
export function movePage(src: string, doc: Doc, id: string, index: number): string {
  const pages = doc.deck?.pages ?? [];
  const from = pages.findIndex((x) => x.id === id);
  if (from < 0 || index === from) return src;
  const p = pages[from];
  const text = blockText(src, p.lines);
  const without = removePage(src, doc, id);
  const d = parse(without, viewOf(doc));
  const rest = d.deck!.pages;
  const to = Math.max(0, Math.min(index, rest.length));
  if (to < rest.length) {
    const before = rest[to].lines.from;
    return without.slice(0, before) + text + '\n' + without.slice(before);
  }
  return insertBlock(without, text, rest[rest.length - 1]?.lines);
}

/** Rewrite a page's header (`page id "label" layout=x`); unspecified fields keep their value. */
export function setPageHeader(src: string, doc: Doc, id: string, h: Partial<PageHeader>): string {
  const p = doc.deck?.pages.find((x) => x.id === id);
  if (!p) return src;
  const written = /\slayout=/.test(src.slice(p.header.from, p.header.to));
  const next: PageHeader = { id: h.id ?? p.id, label: h.label ?? p.label, layout: 'layout' in h ? h.layout : written ? p.layout : undefined };
  return applyEdits(src, [{ ...p.header, insert: pageHeader(next) }]);
}

/** Add a layout block before the first page (or at EOF). */
export function addLayout(src: string, doc: Doc, name: string, parent?: string, lines: string[] = []): string {
  const text = `layout ${name}${parent ? ` extends ${parent}` : ''} {\n${lines.map((l) => '  ' + l + '\n').join('')}}\n`;
  const deck = doc.deck;
  const lastLayout = deck?.layouts[deck.layouts.length - 1];
  if (lastLayout) return insertBlock(src, text, lastLayout.lines);
  const first = deck?.pages[0];
  if (first) return src.slice(0, first.lines.from) + text + '\n' + src.slice(first.lines.from);
  return insertBlock(src, text);
}
