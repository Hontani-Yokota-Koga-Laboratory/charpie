/**
 * Pure document operations used by the HTTP API and the CLI.
 * Everything takes source text and returns source text.
 */
import { endText, parse } from '../src/dsl/parse';
import {
  addEdge,
  addNodes,
  removeItems,
  renameNode,
  setEdgeLabel,
  setEdgesAttr,
  setEdgesOp,
  setNodeLabel,
  setNodesAttr,
  setNodesGeom,
  setNodesKind,
  setSetting,
  uniqueId,
  isValidId,
} from '../src/dsl/patch';
import { SHAPE_KINDS, type ArrowOp, type Doc, type Port, type ShapeKind } from '../src/dsl/types';
import { computeLayout, fitSize, type Layout } from '../src/layout';
import { checkAll, type Issue } from '../src/check/check';
import { autoFix } from '../src/check/resolve';
import { align, distribute, matchSize, stack, translate, type AlignMode } from '../src/ops/arrange';
import type { Measure } from '../src/text/fit';
import { HttpError } from './workspace';
import { issuesOut } from '../src/check/report';

export { issuesOut, type IssueOut } from '../src/check/report';

export interface Analysis {
  doc: Doc;
  layout: Layout;
  issues: Issue[];
  /** silenced with ignore= */
  ignored: Issue[];
}

export function analyze(src: string, measure: Measure): Analysis {
  const doc = parse(src);
  const layout = computeLayout(doc, measure);
  const all = checkAll(doc, layout);
  return { doc, layout, issues: all.filter((i) => !i.ignored), ignored: all.filter((i) => i.ignored) };
}

/** Compact, Claude-friendly summary of a diagram. */
export function summarize(src: string, a: Analysis) {
  const { doc, layout } = a;
  return {
    nodes: doc.nodes.map((n) => {
      const l = layout.nodeMap.get(n.id)!;
      return {
        id: n.id,
        kind: n.kind,
        label: n.label,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        parent: n.attrs.in ?? null,
        attrs: n.attrs,
        classes: n.classes,
        fontSize: l.text.size,
        line: n.line + 1,
      };
    }),
    edges: doc.edges.map((e) => ({ key: e.key, from: endText(e, 'from'), to: endText(e, 'to'), op: e.op, label: e.label, fromPort: e.fromPort ?? null, toPort: e.toPort ?? null, attrs: e.attrs, line: e.line + 1 })),
    styles: Object.fromEntries([...doc.styles.values()].map((s) => [s.name, s.props])),
    settings: doc.settings,
    bounds: bounds(layout),
    issues: issuesOut(a, src),
    ignoredIssues: a.ignored.length,
    src,
  };
}

/**
 * Text room per labelled shape: the font size in use, the text block against the room its box leaves
 * (slack < 0 = overflow), and `fit` — the smallest box that holds the label as written at that size.
 */
export function measureNodes(a: Analysis, measure: Measure) {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return a.layout.nodes
    .filter((l) => l.def.label)
    .map((l) => ({
      id: l.id,
      kind: l.kind,
      line: l.def.line + 1,
      font: l.text.size,
      auto: l.text.auto,
      box: { w: l.box.w, h: l.box.h },
      text: { w: r1(l.textRect.w), h: r1(l.textRect.h), lines: l.text.lines.length },
      slack: { w: r1(l.textBox.w - l.textRect.w), h: r1(l.textBox.h - l.textRect.h) },
      fit: fitSize(a.doc, l, measure),
      overflow: l.text.overflow,
    }))
    .sort((p, q) => p.line - q.line);
}

export type NodeMeasure = ReturnType<typeof measureNodes>[number];

function bounds(layout: Layout) {
  if (!layout.nodes.length) return null;
  const xs = layout.nodes.flatMap((n) => [n.box.x, n.box.x + n.box.w]);
  const ys = layout.nodes.flatMap((n) => [n.box.y, n.box.y + n.box.h]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ───────────────────────── operations ─────────────────────────

type Ids = string | string[];
const list = (v: Ids | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export type Op =
  | { op: 'add'; kind?: string; id?: string; label?: string; x?: number; y?: number; w?: number; h?: number; attrs?: Record<string, string | number>; classes?: string[]; near?: string; dir?: 'right' | 'left' | 'below' | 'above'; gap?: number; parent?: string }
  | { op: 'connect'; from: string; to: string; label?: string; arrow?: ArrowOp; fromPort?: Port; toPort?: Port; attrs?: Record<string, string | number> }
  | { op: 'set'; ids?: Ids; id?: string; label?: string; kind?: string; x?: number; y?: number; w?: number; h?: number; attrs?: Record<string, string | number | null> }
  | { op: 'set-edge'; keys?: Ids; key?: string; from?: string; to?: string; label?: string; arrow?: ArrowOp; attrs?: Record<string, string | number | null> }
  | { op: 'move'; ids?: Ids; id?: string; dx?: number; dy?: number; x?: number; y?: number }
  | { op: 'remove'; ids?: Ids; id?: string; edges?: string[] }
  | { op: 'rename'; id: string; to: string }
  | { op: 'align'; ids: string[]; mode: AlignMode }
  | { op: 'distribute'; ids: string[]; axis: 'h' | 'v' }
  | { op: 'match-size'; ids: string[]; mode?: 'width' | 'height' | 'both' }
  | { op: 'stack'; ids: string[]; axis: 'h' | 'v'; gap?: number }
  | { op: 'fix'; only?: string[] }
  | { op: 'setting'; key: string; value: number | null };

const DEFAULT_SIZE: Record<ShapeKind, [number, number]> = { rect: [140, 60], round: [140, 60], ellipse: [120, 72], diamond: [140, 90], trap: [150, 64], para: [150, 60], hex: [150, 64], cross: [60, 60], plus: [60, 60], text: [120, 36] };
const STEM: Record<ShapeKind, string> = { rect: 'box', round: 'box', ellipse: 'oval', diamond: 'cond', trap: 'trap', para: 'io', hex: 'hex', cross: 'cross', plus: 'plus', text: 'note' };

function need(doc: Doc, id: string) {
  const n = doc.nodeMap.get(id);
  if (!n) throw new HttpError(400, `node not found: ${id}（存在する ID: ${doc.nodes.map((x) => x.id).join(', ') || 'なし'}）`);
  return n;
}
const str = (attrs: Record<string, string | number> | undefined) => Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, String(v)]));

function edgeKeys(doc: Doc, o: { keys?: Ids; key?: string; from?: string; to?: string }): string[] {
  const keys = [...list(o.keys), ...list(o.key)];
  if (o.from || o.to) keys.push(...doc.edges.filter((e) => (!o.from || e.from === o.from) && (!o.to || e.to === o.to)).map((e) => e.key));
  for (const k of keys) if (!doc.edges.some((e) => e.key === k)) throw new HttpError(400, `edge not found: ${k}（例: "a->b#0"）`);
  if (!keys.length) throw new HttpError(400, 'edge not specified (key / from / to)');
  return keys;
}

export interface OpResult {
  src: string;
  /** ids created by `add` ops, in order */
  created: string[];
}

export function applyOps(src: string, ops: Op[], measure: Measure): OpResult {
  const created: string[] = [];
  let out = src;
  for (const o of ops) {
    const doc = parse(out);
    switch (o.op) {
      case 'add': {
        const kind = (o.kind ?? 'round') as ShapeKind;
        if (!SHAPE_KINDS.includes(kind)) throw new HttpError(400, `unknown kind: ${o.kind}（${SHAPE_KINDS.join(' / ')}）`);
        const id = o.id ?? uniqueId(doc, STEM[kind]);
        if (!isValidId(id)) throw new HttpError(400, `invalid id: ${id}`);
        if (doc.nodeMap.has(id)) throw new HttpError(409, `id already exists: ${id}`);
        const [dw, dh] = DEFAULT_SIZE[kind];
        const w = o.w ?? dw,
          h = o.h ?? dh;
        let x = o.x,
          y = o.y;
        if (x === undefined || y === undefined) {
          const gap = o.gap ?? Math.max(40, doc.settings.gap * 3);
          if (o.near) {
            const r = need(doc, o.near);
            const dir = o.dir ?? 'right';
            x ??= dir === 'right' ? r.x + r.w + gap : dir === 'left' ? r.x - gap - w : Math.round(r.x + (r.w - w) / 2);
            y ??= dir === 'below' ? r.y + r.h + gap : dir === 'above' ? r.y - gap - h : Math.round(r.y + (r.h - h) / 2);
          } else {
            const maxX = doc.nodes.length ? Math.max(...doc.nodes.filter((n) => !n.attrs.in).map((n) => n.x + n.w)) : -gap;
            x ??= maxX + gap;
            y ??= doc.nodes.length ? Math.min(...doc.nodes.map((n) => n.y)) : 0;
          }
        }
        const attrs = str(o.attrs as Record<string, string | number>);
        if (o.parent) {
          need(doc, o.parent);
          attrs.in = o.parent;
        }
        out = addNodes(out, doc, [{ kind, id, label: o.label, x, y, w, h, attrs, classes: o.classes }]);
        created.push(id);
        break;
      }
      case 'connect': {
        // an end may be a point: "(x, y)" or "+(dx, dy)" (relative to the other end)
        const isPt = (v: string) => /^\+?\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/.test(v ?? '');
        if (!isPt(o.from)) need(doc, o.from);
        if (!isPt(o.to)) need(doc, o.to);
        if (isPt(o.from) && isPt(o.to) && o.from.startsWith('+') && o.to.startsWith('+')) throw new HttpError(400, 'connect: only one end can be relative +(dx, dy)');
        out = addEdge(out, doc, o.from, o.to, o.arrow ?? '->', { label: o.label, fromPort: o.fromPort, toPort: o.toPort, attrs: str(o.attrs) });
        break;
      }
      case 'set': {
        const ids = [...list(o.ids), ...list(o.id)];
        if (!ids.length) throw new HttpError(400, 'set: id / ids is required');
        ids.forEach((id) => need(doc, id));
        if (o.kind) {
          if (!SHAPE_KINDS.includes(o.kind as ShapeKind)) throw new HttpError(400, `unknown kind: ${o.kind}`);
          out = setNodesKind(out, parse(out), ids, o.kind as ShapeKind);
        }
        if (o.label !== undefined) for (const id of ids) out = setNodeLabel(out, parse(out), id, o.label);
        for (const [k, v] of Object.entries(o.attrs ?? {})) out = setNodesAttr(out, parse(out), ids, k, v === null ? undefined : String(v));
        const g = { x: o.x, y: o.y, w: o.w, h: o.h };
        if (Object.values(g).some((v) => v !== undefined)) {
          const d = parse(out);
          out = setNodesGeom(out, d, Object.fromEntries(ids.map((id) => [id, Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined))])));
        }
        break;
      }
      case 'set-edge': {
        const keys = edgeKeys(doc, o);
        if (o.arrow) out = setEdgesOp(out, parse(out), keys, o.arrow);
        if (o.label !== undefined) for (const k of keys) out = setEdgeLabel(out, parse(out), k, o.label);
        for (const [k, v] of Object.entries(o.attrs ?? {})) out = setEdgesAttr(out, parse(out), keys, k, v === null ? undefined : String(v));
        break;
      }
      case 'move': {
        const ids = [...list(o.ids), ...list(o.id)];
        ids.forEach((id) => need(doc, id));
        if (o.x !== undefined || o.y !== undefined) {
          // absolute move of the first node; others (and children) follow by the same delta
          const n = need(doc, ids[0]);
          out = translate(out, doc, ids, (o.x ?? n.x) - n.x, (o.y ?? n.y) - n.y);
        } else out = translate(out, doc, ids, o.dx ?? 0, o.dy ?? 0);
        break;
      }
      case 'remove': {
        const ids = [...list(o.ids), ...list(o.id)];
        ids.forEach((id) => need(doc, id));
        out = removeItems(out, doc, ids, o.edges ?? []);
        break;
      }
      case 'rename': {
        need(doc, o.id);
        if (!isValidId(o.to) || doc.nodeMap.has(o.to)) throw new HttpError(400, `cannot rename to: ${o.to}`);
        out = renameNode(out, doc, o.id, o.to);
        break;
      }
      case 'align':
        o.ids.forEach((id) => need(doc, id));
        out = align(out, doc, o.ids, o.mode);
        break;
      case 'distribute':
        o.ids.forEach((id) => need(doc, id));
        out = distribute(out, doc, o.ids, o.axis);
        break;
      case 'match-size':
        o.ids.forEach((id) => need(doc, id));
        out = matchSize(out, doc, o.ids, o.mode ?? 'both');
        break;
      case 'stack':
        o.ids.forEach((id) => need(doc, id));
        out = stack(out, doc, o.ids, o.axis, o.gap ?? 24);
        break;
      case 'fix':
        out = autoFix(out, measure, { only: o.only ? new Set(o.only) : undefined });
        break;
      case 'setting':
        out = setSetting(out, doc, o.key, o.value === null ? undefined : o.value);
        break;
      default:
        throw new HttpError(400, `unknown op: ${(o as { op: string }).op}`);
    }
  }
  return { src: out, created };
}

