import { descendants } from '../dsl/parse';
import { setNodesGeom, type Geom } from '../dsl/patch';
import type { Doc } from '../dsl/types';

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type SizeMode = 'width' | 'height' | 'both';

type Moves = Map<string, Partial<Geom>>;

/** Translate nodes; descendants follow their containers. */
function withChildren(doc: Doc, moves: Map<string, { dx: number; dy: number }>, extra: Moves = new Map()): Moves {
  const out: Moves = new Map(extra);
  for (const [id, { dx, dy }] of moves) {
    if (!dx && !dy) continue;
    for (const t of [id, ...descendants(doc, [id])]) {
      if (moves.has(t) && t !== id) continue; // explicitly moved itself
      const n = doc.nodeMap.get(t)!;
      const prev = out.get(t) ?? {};
      out.set(t, { ...prev, x: (prev.x ?? n.x) + dx, y: (prev.y ?? n.y) + dy });
    }
  }
  return out;
}

/** Only keep top-level members of a selection (children of selected containers move with them). */
function topLevel(doc: Doc, ids: string[]): string[] {
  const set = new Set(ids);
  const desc = descendants(doc, ids);
  return ids.filter((id) => set.has(id) && !desc.has(id));
}

export function align(src: string, doc: Doc, ids: string[], mode: AlignMode): string {
  const nodes = topLevel(doc, ids)
    .map((id) => doc.nodeMap.get(id)!)
    .filter(Boolean);
  if (nodes.length < 2) return src;
  const left = Math.min(...nodes.map((n) => n.x));
  const right = Math.max(...nodes.map((n) => n.x + n.w));
  const top = Math.min(...nodes.map((n) => n.y));
  const bottom = Math.max(...nodes.map((n) => n.y + n.h));
  // center alignment uses the first selected node as the anchor (like most tools)
  const anchor = nodes[0];
  const cx = anchor.x + anchor.w / 2,
    cy = anchor.y + anchor.h / 2;
  const moves = new Map<string, { dx: number; dy: number }>();
  for (const n of nodes) {
    let dx = 0,
      dy = 0;
    if (mode === 'left') dx = left - n.x;
    if (mode === 'right') dx = right - (n.x + n.w);
    if (mode === 'hcenter') dx = Math.round(cx - n.w / 2) - n.x;
    if (mode === 'top') dy = top - n.y;
    if (mode === 'bottom') dy = bottom - (n.y + n.h);
    if (mode === 'vcenter') dy = Math.round(cy - n.h / 2) - n.y;
    moves.set(n.id, { dx, dy });
  }
  return setNodesGeom(src, doc, withChildren(doc, moves));
}

/** Equalize the gaps between nodes along an axis (needs ≥ 3). */
export function distribute(src: string, doc: Doc, ids: string[], axis: 'h' | 'v'): string {
  const nodes = topLevel(doc, ids)
    .map((id) => doc.nodeMap.get(id)!)
    .filter(Boolean);
  if (nodes.length < 3) return src;
  const pos = (n: (typeof nodes)[0]) => (axis === 'h' ? n.x : n.y);
  const len = (n: (typeof nodes)[0]) => (axis === 'h' ? n.w : n.h);
  nodes.sort((a, b) => pos(a) - pos(b));
  const first = nodes[0],
    last = nodes[nodes.length - 1];
  const span = pos(last) + len(last) - pos(first);
  const total = nodes.reduce((s, n) => s + len(n), 0);
  const gap = (span - total) / (nodes.length - 1);
  let cur = pos(first);
  const moves = new Map<string, { dx: number; dy: number }>();
  for (const n of nodes) {
    const d = Math.round(cur) - pos(n);
    moves.set(n.id, axis === 'h' ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    cur += len(n) + gap;
  }
  return setNodesGeom(src, doc, withChildren(doc, moves));
}

/** Make sizes equal (to the largest), keeping each node's center. */
export function matchSize(src: string, doc: Doc, ids: string[], mode: SizeMode): string {
  const nodes = ids.map((id) => doc.nodeMap.get(id)!).filter(Boolean);
  if (nodes.length < 2) return src;
  const W = Math.max(...nodes.map((n) => n.w));
  const H = Math.max(...nodes.map((n) => n.h));
  const out: Moves = new Map();
  for (const n of nodes) {
    const w = mode === 'height' ? n.w : W;
    const h = mode === 'width' ? n.h : H;
    out.set(n.id, { x: Math.round(n.x + (n.w - w) / 2), y: Math.round(n.y + (n.h - h) / 2), w, h });
  }
  return setNodesGeom(src, doc, out);
}

/** Pack nodes in a row/column with a fixed gap, preserving order. */
export function stack(src: string, doc: Doc, ids: string[], axis: 'h' | 'v', gap: number): string {
  const nodes = topLevel(doc, ids)
    .map((id) => doc.nodeMap.get(id)!)
    .filter(Boolean);
  if (nodes.length < 2) return src;
  nodes.sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
  let cur = axis === 'h' ? nodes[0].x : nodes[0].y;
  const moves = new Map<string, { dx: number; dy: number }>();
  for (const n of nodes) {
    const d = cur - (axis === 'h' ? n.x : n.y);
    moves.set(n.id, axis === 'h' ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    cur += (axis === 'h' ? n.w : n.h) + gap;
  }
  return setNodesGeom(src, doc, withChildren(doc, moves));
}

export function translate(src: string, doc: Doc, ids: string[], dx: number, dy: number): string {
  const moves = new Map(topLevel(doc, ids).map((id) => [id, { dx, dy }]));
  return setNodesGeom(src, doc, withChildren(doc, moves));
}
