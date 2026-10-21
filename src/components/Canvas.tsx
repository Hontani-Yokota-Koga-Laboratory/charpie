import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { descendants } from '../dsl/parse';
import { addEdge, addNodeLines, addNodes, pointText, setEdgeEnds, setNodesAttr, setNodesGeom, uniqueId, type Geom } from '../dsl/patch';
import type { Doc, Port, ShapeKind } from '../dsl/types';
import { boxContains, boxesIntersect, center, portPoint, type Box, type Pt } from '../geom/geom';
import { layoutNode, type Layout, type NodeLayout } from '../layout';
import { canvasMeasure } from '../text/fit';
import { reparse, useStore } from '../store';
import { EdgeLabel, EdgeShape, ImageHrefContext, NodeShape, diagramBounds } from './Diagram';
import { assetHref, insertImages, isImageFile } from '../images';
import { InlineEditor } from './InlineEditor';
import { STARTER_BODY } from './Tools';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
const PORTS: Port[] = ['n', 'e', 's', 'w'];

export const DEFAULT_SIZE: Record<ShapeKind, [number, number]> = {
  rect: [140, 60],
  round: [140, 60],
  ellipse: [120, 72],
  diamond: [140, 90],
  trap: [150, 64],
  para: [150, 60],
  hex: [150, 64],
  cross: [60, 60],
  plus: [60, 60],
  text: [120, 36],
  image: [160, 120],
  table: [480, 180],
  list: [480, 200],
};
export const ID_STEM: Record<ShapeKind, string> = { rect: 'box', round: 'box', ellipse: 'oval', diamond: 'cond', trap: 'trap', para: 'io', hex: 'hex', cross: 'cross', plus: 'plus', text: 'note', image: 'img', table: 'table', list: 'list' };

interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
}

type Gesture =
  | { type: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { type: 'pinch'; d0: number; m0: Pt; v0: { x: number; y: number; zoom: number } }
  | { type: 'move'; start: Pt; base: string; baseDoc: Doc; top: string[]; ids: string[]; orig: Map<string, Box>; bbox: Box; moved: boolean; sx: number; sy: number }
  | { type: 'resize'; id: string; handle: Handle; base: string; baseDoc: Doc; orig: Box; start: Pt }
  | { type: 'marquee'; start: Pt; additive: boolean; initial: { nodes: string[]; edges: string[] } }
  | { type: 'create'; kind: ShapeKind; start: Pt }
  /** draw a new arrow from a shape (id) or from a point on the canvas */
  | { type: 'edge'; from: string | Pt; port?: Port; start: Pt }
  /** drag one end of an existing arrow onto a shape or into empty space */
  | { type: 'edgeEnd'; key: string; which: 'from' | 'to'; base: string; baseDoc: Doc; stmt: number; other?: string; rel?: Pt; moved: boolean }
  /** drag an arrow whose ends are absolute points */
  | { type: 'edgeMove'; key: string; start: Pt; base: string; baseDoc: Doc; stmt: number; ends: { which: 'from' | 'to'; pt: Pt }[]; moved: boolean; sx: number; sy: number };

interface Overlay {
  guides: Guide[];
  marquee?: Box;
  createBox?: Box;
  edgePreview?: { from: Pt; to: Pt; target?: string; targetPort?: Port };
  badge?: { at: Pt; text: string };
}

const snapTo = (v: number, grid: number) => (grid > 0 ? Math.round(v / grid) * grid : v);

export function screenToWorld(view: { x: number; y: number; zoom: number }, p: Pt): Pt {
  return { x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom };
}

export function fitView(layout: Layout, w: number, h: number, maxZoom = 1) {
  if (layout.frame) {
    // a page: fill the room right of the floating toolbar
    const b = layout.frame;
    const left = 72,
      pad = 28;
    const zoom = Math.max(0.05, Math.min((w - left - pad) / b.w, (h - pad * 2) / b.h));
    return { zoom, x: left + (w - left - pad - b.w * zoom) / 2 - b.x * zoom, y: h / 2 - (b.y + b.h / 2) * zoom };
  }
  const b = diagramBounds(layout);
  const pad = 80;
  const zoom = Math.min(maxZoom, Math.max(0.1, Math.min((w - pad * 2) / Math.max(b.w, 1), (h - pad * 2) / Math.max(b.h, 1))));
  return { zoom, x: w / 2 - (b.x + b.w / 2) * zoom, y: h / 2 - (b.y + b.h / 2) * zoom };
}

export function Canvas() {
  const layout = useStore((s) => s.layout);
  const issues = useStore((s) => s.issues);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const view = useStore((s) => s.view);
  const editing = useStore((s) => s.editing);
  const hoverIssue = useStore((s) => s.hoverIssue);
  const focusIssue = useStore((s) => s.focusIssue);
  const grid = useStore((s) => s.doc.settings.grid);
  const wsFile = useStore((s) => (s.workspace.on ? s.workspace.file : null));
  const imageHref = useMemo(() => assetHref(wsFile), [wsFile]);

  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const gestureEpoch = useRef(0);
  // touch bookkeeping
  const pointers = useRef(new Map<number, Pt>());
  const down = useRef<{ x: number; y: number; t: number; moved: boolean; touch: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTouchUp = useRef(0);
  const longPress = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const coarse = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches, []);
  const space = useRef(false);
  const [hover, setHover] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({ guides: [] });
  const [panning, setPanning] = useState(false);

  // ── viewport size + initial fit
  useEffect(() => {
    const el = svgRef.current!;
    let first = true;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (first && r.width > 0) {
        first = false;
        useStore.getState().setView(fitView(useStore.getState().layout, r.width, r.height));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fit = () => {
      const r = svgRef.current!.getBoundingClientRect();
      useStore.getState().setView(fitView(useStore.getState().layout, r.width, r.height));
    };
    window.addEventListener('charpie:fit', fit);
    return () => window.removeEventListener('charpie:fit', fit);
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return screenToWorld(useStore.getState().view, { x: clientX - r.left, y: clientY - r.top });
  }, []);

  // ── wheel: pan / zoom (needs a non-passive listener)
  useEffect(() => {
    const el = svgRef.current!;
    // a trackpad stream keeps its classification until it pauses, so a straight vertical swipe can't flip to zoom midway
    let trackpadUntil = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = useStore.getState();
      const v = s.view;
      // mouse wheel / pinch (ctrlKey) zoom; trackpad two-finger scroll and Shift pan.
      // Trackpad: any sideways component, or Chrome/Safari's wheelDeltaY === -3 * deltaY (a mouse notch reports ±120); Firefox uses pixel mode only for trackpads
      const now = performance.now();
      const wdy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
      const trackpad = e.deltaX !== 0 || (wdy ? wdy === -3 * e.deltaY : e.deltaMode === 0) || now < trackpadUntil;
      if (trackpad && !(e.ctrlKey || e.metaKey)) trackpadUntil = now + 300;
      const pan = !(e.ctrlKey || e.metaKey) && (e.shiftKey || trackpad);
      if (!pan) {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left,
          py = e.clientY - r.top;
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
        const zoom = Math.max(0.1, Math.min(6, v.zoom * factor));
        const k = zoom / v.zoom;
        s.setView({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
      } else {
        const m = e.deltaMode === 1 ? 16 : 1;
        s.setView({ x: v.x - (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * m, y: v.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * m });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── space-to-pan
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || !!t.closest('.cm-editor'));
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        space.current = true;
        setPanning(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        space.current = false;
        setPanning(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ── snapping helpers
  const snapCandidates = useCallback((exclude: Set<string>) => {
    const xs: { v: number; box: Box }[] = [];
    const ys: { v: number; box: Box }[] = [];
    const frame = useStore.getState().layout.frame;
    if (frame) {
      xs.push({ v: frame.x, box: frame }, { v: frame.x + frame.w / 2, box: frame }, { v: frame.x + frame.w, box: frame });
      ys.push({ v: frame.y, box: frame }, { v: frame.y + frame.h / 2, box: frame }, { v: frame.y + frame.h, box: frame });
    }
    for (const n of useStore.getState().layout.nodes) {
      if (exclude.has(n.id)) continue;
      const b = n.box;
      xs.push({ v: b.x, box: b }, { v: b.x + b.w / 2, box: b }, { v: b.x + b.w, box: b });
      ys.push({ v: b.y, box: b }, { v: b.y + b.h / 2, box: b }, { v: b.y + b.h, box: b });
    }
    return { xs, ys };
  }, []);

  const nodeAt = (clientX: number, clientY: number, exclude?: string): string | undefined => {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const id = (el as Element).closest?.('[data-node]')?.getAttribute('data-node');
      if (id && id !== exclude) return id;
    }
    return undefined;
  };

  const placeholderAt = (clientX: number, clientY: number): string | undefined => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const id = el.closest?.('[data-slot]')?.getAttribute('data-slot');
      if (id) return id;
    }
    return undefined;
  };

  const hitAt = (clientX: number, clientY: number): { nodeId?: string; edgeKey?: string } => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const edgeKey = el.closest?.('[data-edge]')?.getAttribute('data-edge');
      if (edgeKey) return { edgeKey };
      const nodeId = el.closest?.('[data-node]')?.getAttribute('data-node');
      if (nodeId) return { nodeId };
    }
    return {};
  };

  const nearestPort = (id: string, p: Pt): Port | undefined => {
    const n = useStore.getState().layout.nodeMap.get(id);
    if (!n) return;
    const z = useStore.getState().view.zoom;
    let best: Port | undefined,
      bd = 14 / z;
    for (const port of PORTS) {
      const q = portPoint(n.poly, n.box, port);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) {
        bd = d;
        best = port;
      }
    }
    return best;
  };

  // ── pointer handlers
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = useStore.getState();
    const target = e.target as Element;
    const p = toWorld(e.clientX, e.clientY);
    if (s.editing) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    down.current = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false, touch: e.pointerType === 'touch' };
    if (pointers.current.size >= 2) {
      startPinch(e.pointerId);
      return;
    }
    if (e.button === 1 || space.current || s.tool === 'pan') {
      gesture.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: s.view.x, vy: s.view.y };
      setPanning(true);
      svgRef.current!.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    svgRef.current!.setPointerCapture(e.pointerId);
    gestureEpoch.current = s.epoch;

    const endEl = target.closest('[data-edge-end]');
    if (endEl) {
      const key = endEl.getAttribute('data-edge-key')!;
      const which = endEl.getAttribute('data-edge-end') as 'from' | 'to';
      const el = s.layout.edgeMap.get(key);
      if (el) {
        const other = which === 'from' ? el.def.to : el.def.from;
        const f = el.free[which];
        gesture.current = { type: 'edgeEnd', key, which, base: s.src, baseDoc: s.doc, stmt: el.def.spans.stmt.from, other, rel: f?.base && (which === 'from' ? el.def.fromPt : el.def.toPt)?.rel ? f.base : undefined, moved: false };
        return;
      }
    }
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | undefined;
    const portEl = target.closest('[data-port]');
    const nodeId = target.closest('[data-node]')?.getAttribute('data-node') ?? undefined;
    const edgeKey = target.closest('[data-edge]')?.getAttribute('data-edge') ?? undefined;

    if (handle && s.selection.nodes.length === 1) {
      const id = s.selection.nodes[0];
      const n = s.doc.nodeMap.get(id)!;
      s.beginGesture();
      gesture.current = { type: 'resize', id, handle, base: s.src, baseDoc: s.doc, orig: { x: n.x, y: n.y, w: n.w, h: n.h }, start: p };
      return;
    }
    if (portEl) {
      const id = portEl.getAttribute('data-port-node')!;
      const port = portEl.getAttribute('data-port') as Port;
      gesture.current = { type: 'edge', from: id, port, start: p };
      return;
    }
    if (s.tool !== 'select' && s.tool !== 'edge') {
      gesture.current = { type: 'create', kind: s.tool, start: p };
      return;
    }
    if (s.tool === 'edge' && nodeId) {
      gesture.current = { type: 'edge', from: nodeId, start: p };
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey || s.multiSelect;
    if (nodeId) {
      let sel = s.selection.nodes;
      if (additive) {
        s.select({ nodes: [nodeId] }, 'toggle');
        sel = useStore.getState().selection.nodes;
        if (!sel.includes(nodeId)) return;
      } else if (!sel.includes(nodeId)) {
        s.select({ nodes: [nodeId] });
        sel = [nodeId];
      }
      const doc = s.doc;
      const desc = descendants(doc, sel);
      const top = sel.filter((id) => !desc.has(id));
      const ids = [...new Set([...top, ...desc])];
      const orig = new Map(ids.map((id) => [id, { ...s.layout.nodeMap.get(id)!.box }]));
      const bbox = top.map((id) => orig.get(id)!).reduce((a, b) => {
        const x = Math.min(a.x, b.x),
          y = Math.min(a.y, b.y);
        return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
      });
      gesture.current = { type: 'move', start: p, base: s.src, baseDoc: doc, top, ids, orig, bbox, moved: false, sx: e.clientX, sy: e.clientY };
      return;
    }
    if (edgeKey) {
      if (additive) s.select({ edges: [edgeKey] }, 'toggle');
      else s.select({ edges: [edgeKey] });
      gesture.current = null;
      // an arrow with absolute point ends can be dragged around by its body
      const el = s.layout.edgeMap.get(edgeKey);
      const ends = el ? (['from', 'to'] as const).filter((w) => el.free[w] && !el.free[w]!.base).map((w) => ({ which: w, pt: el.free[w]!.pt })) : [];
      if (el && ends.length && !additive) gesture.current = { type: 'edgeMove', key: edgeKey, start: p, base: s.src, baseDoc: s.doc, stmt: el.def.spans.stmt.from, ends, moved: false, sx: e.clientX, sy: e.clientY };
      return;
    }
    if (s.tool === 'edge') {
      // arrow starting from nowhere
      gesture.current = { type: 'edge', from: { x: snapTo(p.x, grid), y: snapTo(p.y, grid) }, start: p };
      return;
    }
    // background
    if (!additive) s.clearSelection();
    if (e.pointerType === 'touch') {
      // touch: drag pans; long-press turns into a marquee
      gesture.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: s.view.x, vy: s.view.y };
      clearTimeout(longPress.current);
      longPress.current = setTimeout(() => {
        if (gesture.current?.type === 'pan' && down.current && !down.current.moved) {
          navigator.vibrate?.(12);
          gesture.current = { type: 'marquee', start: p, additive, initial: useStore.getState().selection };
          setOverlay({ guides: [], marquee: { x: p.x, y: p.y, w: 0, h: 0 } });
        }
      }, 450);
      return;
    }
    gesture.current = { type: 'marquee', start: p, additive, initial: useStore.getState().selection };
  };

  const startPinch = (pointerId: number) => {
    const s = useStore.getState();
    const g = gesture.current;
    clearTimeout(longPress.current);
    if ((g?.type === 'move' && g.moved) || g?.type === 'resize') s.endGesture();
    try {
      svgRef.current!.setPointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    const [a, b] = [...pointers.current.values()];
    gesture.current = { type: 'pinch', d0: Math.max(10, Math.hypot(b.x - a.x, b.y - a.y)), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...s.view } };
    down.current = null;
    setOverlay({ guides: [] });
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const s = useStore.getState();
    // the text was replaced from outside mid-gesture: drop the gesture instead of overwriting it
    if (gesture.current && gesture.current.type !== 'pan' && gestureEpoch.current !== s.epoch) {
      gesture.current = null;
      setOverlay({ guides: [] });
    }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (down.current && !down.current.moved && Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > (down.current.touch ? 8 : 3)) {
      down.current.moved = true;
      clearTimeout(longPress.current);
    }
    const g = gesture.current;
    if (g?.type === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const r = svgRef.current!.getBoundingClientRect();
      const zoom = Math.max(0.1, Math.min(6, (g.v0.zoom * Math.hypot(b.x - a.x, b.y - a.y)) / g.d0));
      const m = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const wx = (g.m0.x - r.left - g.v0.x) / g.v0.zoom,
        wy = (g.m0.y - r.top - g.v0.y) / g.v0.zoom;
      s.setView({ zoom, x: m.x - wx * zoom, y: m.y - wy * zoom });
      return;
    }
    const p = toWorld(e.clientX, e.clientY);
    if (!g) {
      const t = e.target as Element;
      const id = t.closest('[data-node]')?.getAttribute('data-node') ?? t.closest('[data-port]')?.getAttribute('data-port-node') ?? null;
      if (id !== hover) setHover(id);
      return;
    }
    const z = s.view.zoom;
    const th = (e.pointerType === 'touch' ? 10 : 6) / z;
    switch (g.type) {
      case 'pan':
        s.setView({ x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy });
        return;
      case 'move': {
        if (!g.moved) {
          if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < (e.pointerType === 'touch' ? 8 : 3)) return;
          g.moved = true;
          s.beginGesture();
        }
        let dx = p.x - g.start.x,
          dy = p.y - g.start.y;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const guides: Guide[] = [];
        if (!e.altKey) {
          const b = { ...g.bbox, x: g.bbox.x + dx, y: g.bbox.y + dy };
          const { xs, ys } = snapCandidates(new Set(g.ids));
          const mx = [b.x, b.x + b.w / 2, b.x + b.w];
          const my = [b.y, b.y + b.h / 2, b.y + b.h];
          let bx: { d: number; v: number; box: Box } | undefined;
          for (const c of xs) for (const m of mx) if (Math.abs(c.v - m) < (bx ? Math.abs(bx.d) : th)) bx = { d: c.v - m, v: c.v, box: c.box };
          let by: { d: number; v: number; box: Box } | undefined;
          for (const c of ys) for (const m of my) if (Math.abs(c.v - m) < (by ? Math.abs(by.d) : th)) by = { d: c.v - m, v: c.v, box: c.box };
          if (bx) dx += bx.d;
          else dx = snapTo(g.bbox.x + dx, grid) - g.bbox.x;
          if (by) dy += by.d;
          else dy = snapTo(g.bbox.y + dy, grid) - g.bbox.y;
          const fb = { ...g.bbox, x: g.bbox.x + dx, y: g.bbox.y + dy };
          if (bx) guides.push({ x1: bx.v, x2: bx.v, y1: Math.min(fb.y, bx.box.y) - 12, y2: Math.max(fb.y + fb.h, bx.box.y + bx.box.h) + 12 });
          if (by) guides.push({ y1: by.v, y2: by.v, x1: Math.min(fb.x, by.box.x) - 12, x2: Math.max(fb.x + fb.w, by.box.x + by.box.w) + 12 });
        }
        dx = Math.round(dx);
        dy = Math.round(dy);
        const geoms = new Map<string, Partial<Geom>>();
        for (const id of g.ids) {
          const o = g.orig.get(id)!;
          geoms.set(id, { x: o.x + dx, y: o.y + dy });
        }
        s.setSource(setNodesGeom(g.base, g.baseDoc, geoms), { history: 'none' });
        setOverlay({ guides, badge: { at: { x: g.bbox.x + dx, y: g.bbox.y + dy - 8 / z }, text: `${g.bbox.x + dx}, ${g.bbox.y + dy}` } });
        return;
      }
      case 'resize': {
        const o = g.orig;
        let x1 = o.x,
          y1 = o.y,
          x2 = o.x + o.w,
          y2 = o.y + o.h;
        const dx = p.x - g.start.x,
          dy = p.y - g.start.y;
        const hd = g.handle;
        if (hd.includes('w')) x1 += dx;
        if (hd.includes('e')) x2 += dx;
        if (hd.includes('n')) y1 += dy;
        if (hd.includes('s')) y2 += dy;
        if (e.altKey) {
          if (hd.includes('w')) x2 = o.x + o.w - (x1 - o.x);
          if (hd.includes('e')) x1 = o.x - (x2 - (o.x + o.w));
          if (hd.includes('n')) y2 = o.y + o.h - (y1 - o.y);
          if (hd.includes('s')) y1 = o.y - (y2 - (o.y + o.h));
        }
        const guides: Guide[] = [];
        const { xs, ys } = snapCandidates(new Set([g.id]));
        const snapEdge = (v: number, cands: { v: number; box: Box }[], vertical: boolean) => {
          let best: { v: number; box: Box } | undefined;
          for (const c of cands) if (Math.abs(c.v - v) < (best ? Math.abs(best.v - v) : th)) best = c;
          if (!best) return snapTo(v, grid);
          guides.push(vertical ? { x1: best.v, x2: best.v, y1: Math.min(y1, best.box.y) - 12, y2: Math.max(y2, best.box.y + best.box.h) + 12 } : { y1: best.v, y2: best.v, x1: Math.min(x1, best.box.x) - 12, x2: Math.max(x2, best.box.x + best.box.w) + 12 });
          return best.v;
        };
        if (!e.altKey && !e.shiftKey) {
          if (hd.includes('w')) x1 = snapEdge(x1, xs, true);
          if (hd.includes('e')) x2 = snapEdge(x2, xs, true);
          if (hd.includes('n')) y1 = snapEdge(y1, ys, false);
          if (hd.includes('s')) y2 = snapEdge(y2, ys, false);
        }
        // equal-size snapping (for 等幅)
        const others = s.layout.nodes.filter((n) => n.id !== g.id);
        let w = x2 - x1,
          h = y2 - y1;
        if (!e.altKey && (hd.includes('e') || hd.includes('w'))) {
          const m = others.find((n) => Math.abs(n.box.w - Math.abs(w)) < th);
          if (m) {
            const nw = Math.sign(w || 1) * m.box.w;
            if (hd.includes('w')) x1 = x2 - nw;
            else x2 = x1 + nw;
            w = nw;
            guides.push({ x1: m.box.x, x2: m.box.x + m.box.w, y1: m.box.y + m.box.h + 8 / z, y2: m.box.y + m.box.h + 8 / z, label: `= ${Math.round(m.box.w)}` });
          }
        }
        if (!e.altKey && (hd.includes('n') || hd.includes('s'))) {
          const m = others.find((n) => Math.abs(n.box.h - Math.abs(h)) < th);
          if (m) {
            const nh = Math.sign(h || 1) * m.box.h;
            if (hd.includes('n')) y1 = y2 - nh;
            else y2 = y1 + nh;
            h = nh;
            guides.push({ x1: m.box.x + m.box.w + 8 / z, x2: m.box.x + m.box.w + 8 / z, y1: m.box.y, y2: m.box.y + m.box.h, label: `= ${Math.round(m.box.h)}` });
          }
        }
        if (e.shiftKey && hd.length === 2) {
          const ratio = o.w / o.h;
          const nw = Math.abs(x2 - x1),
            nh = Math.abs(y2 - y1);
          if (nw / nh > ratio) {
            const hh = nw / ratio;
            if (hd.includes('n')) y1 = y2 - hh;
            else y2 = y1 + hh;
          } else {
            const ww = nh * ratio;
            if (hd.includes('w')) x1 = x2 - ww;
            else x2 = x1 + ww;
          }
        }
        const nx = Math.round(Math.min(x1, x2)),
          ny = Math.round(Math.min(y1, y2));
        const nw = Math.max(10, Math.round(Math.abs(x2 - x1))),
          nh = Math.max(10, Math.round(Math.abs(y2 - y1)));
        s.setSource(setNodesGeom(g.base, g.baseDoc, { [g.id]: { x: nx, y: ny, w: nw, h: nh } }), { history: 'none' });
        setOverlay({ guides, badge: { at: { x: nx, y: ny - 8 / z }, text: `${nw} × ${nh}` } });
        return;
      }
      case 'marquee': {
        const m = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) };
        const hits = s.layout.nodes.filter((n) => !n.def.locked && boxesIntersect(m, n.box) && !(boxContains(n.box, m) && n.parents.length === 0 && descendants(s.doc, [n.id]).size > 0)).map((n) => n.id);
        const edges = s.layout.edges.filter((e2) => e2.pts.every((q) => q.x >= m.x && q.x <= m.x + m.w && q.y >= m.y && q.y <= m.y + m.h)).map((e2) => e2.key);
        if (g.additive) s.select({ nodes: [...new Set([...g.initial.nodes, ...hits])], edges: [...new Set([...g.initial.edges, ...edges])] });
        else s.select({ nodes: hits, edges });
        setOverlay({ guides: [], marquee: m });
        return;
      }
      case 'create': {
        const a = { x: snapTo(g.start.x, grid), y: snapTo(g.start.y, grid) };
        const b = { x: snapTo(p.x, grid), y: snapTo(p.y, grid) };
        const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        setOverlay({ guides: [], createBox: box, badge: { at: { x: box.x, y: box.y - 8 / z }, text: `${box.w} × ${box.h}` } });
        return;
      }
      case 'edge': {
        let fp: Pt;
        if (typeof g.from === 'string') {
          const from = s.layout.nodeMap.get(g.from)!;
          fp = g.port ? portPoint(from.poly, from.box, g.port) : center(from.box);
        } else fp = g.from;
        const target = nodeAt(e.clientX, e.clientY, typeof g.from === 'string' ? g.from : undefined);
        const targetPort = target ? nearestPort(target, p) : undefined;
        let to: Pt = target || e.altKey ? p : { x: snapTo(p.x, grid), y: snapTo(p.y, grid) };
        if (target) {
          const tn = s.layout.nodeMap.get(target)!;
          to = targetPort ? portPoint(tn.poly, tn.box, targetPort) : center(tn.box);
        }
        setHover(target ?? null);
        setOverlay({ guides: [], edgePreview: { from: fp, to, target, targetPort } });
        return;
      }
      case 'edgeEnd': {
        if (!g.moved) {
          g.moved = true;
          s.beginGesture();
        }
        const target = nodeAt(e.clientX, e.clientY, g.other);
        let end: string;
        if (target) {
          const port = nearestPort(target, p);
          end = target + (port ? '.' + port : '');
        } else {
          const q = { x: snapTo(p.x, grid), y: snapTo(p.y, grid) };
          end = g.rel ? pointText(q.x - g.rel.x, q.y - g.rel.y, true) : pointText(q.x, q.y);
        }
        setHover(target ?? null);
        s.setSource(setEdgeEnds(g.base, g.baseDoc, [{ key: g.key, which: g.which, end }]), { history: 'none' });
        keepEdgeSelected(g.stmt);
        return;
      }
      case 'edgeMove': {
        if (!g.moved) {
          if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < (e.pointerType === 'touch' ? 8 : 3)) return;
          g.moved = true;
          s.beginGesture();
        }
        const ref = g.ends[0].pt;
        const dx = snapTo(ref.x + p.x - g.start.x, grid) - ref.x,
          dy = snapTo(ref.y + p.y - g.start.y, grid) - ref.y;
        s.setSource(setEdgeEnds(g.base, g.baseDoc, g.ends.map((x) => ({ key: g.key, which: x.which, end: pointText(x.pt.x + dx, x.pt.y + dy) }))), { history: 'none' });
        keepEdgeSelected(g.stmt);
        return;
      }
    }
  };

  /** Re-point an arrow changes its key: keep the arrow written at `stmt` selected. */
  const keepEdgeSelected = (stmt: number) => {
    const st = useStore.getState();
    const ne = st.doc.edges.find((x) => x.spans.stmt.from === stmt);
    if (ne && (st.selection.edges.length !== 1 || st.selection.edges[0] !== ne.key)) st.select({ edges: [ne.key] });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    clearTimeout(longPress.current);
    if (gesture.current?.type === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null;
      return;
    }
    const d = down.current;
    down.current = null;
    if (e.pointerType === 'touch') lastTouchUp.current = Date.now();
    // touch double-tap (native dblclick is unreliable with touch-action: none)
    if (d?.touch && !d.moved && Date.now() - d.t < 350 && useStore.getState().tool === 'select') {
      const lt = lastTap.current;
      if (lt && Date.now() - lt.t < 350 && Math.hypot(lt.x - e.clientX, lt.y - e.clientY) < 30) {
        lastTap.current = null;
        gesture.current = null;
        setPanning(space.current);
        setOverlay({ guides: [] });
        handleDouble(e.clientX, e.clientY);
        return;
      }
      lastTap.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    }
    const g = gesture.current;
    gesture.current = null;
    const s = useStore.getState();
    try {
      svgRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    const p = toWorld(e.clientX, e.clientY);
    if (!g) return;
    if (g.type === 'pan') setPanning(space.current);
    if (g.type === 'marquee' && e.pointerType === 'touch' && overlay.marquee && overlay.marquee.w + overlay.marquee.h > 0) s.notify(`${useStore.getState().selection.nodes.length} 個を選択`);
    if (g.type === 'move') {
      if (g.moved) {
        reparent(g.top);
        s.endGesture();
      }
    }
    if (g.type === 'resize') s.endGesture();
    if (g.type === 'create') {
      const [dw, dh] = DEFAULT_SIZE[g.kind];
      const box = overlay.createBox && overlay.createBox.w >= 8 && overlay.createBox.h >= 8 ? overlay.createBox : { x: snapTo(g.start.x - dw / 2, grid), y: snapTo(g.start.y - dh / 2, grid), w: dw, h: dh };
      const id = uniqueId(s.doc, ID_STEM[g.kind]);
      s.apply((src, doc) => addNodes(src, doc, [{ kind: g.kind, id, x: box.x, y: box.y, w: box.w, h: box.h, body: STARTER_BODY[g.kind] }]));
      // auto-parent into the smallest container under the new node
      const st = useStore.getState();
      const parent = smallestContainer(st.layout, box, new Set([id]));
      if (parent) st.setSource(setNodesAttr(st.src, st.doc, [id], 'in', parent), { history: 'none' });
      useStore.getState().select({ nodes: [id] });
      if (!e.shiftKey) s.setTool('select');
      useStore.getState().setEditing({ type: 'node', id });
    }
    if (g.type === 'edgeEnd' || g.type === 'edgeMove') {
      if (g.moved) s.endGesture();
      setHover(null);
    }
    if (g.type === 'edge') {
      const pv = overlay.edgePreview;
      const fromText = typeof g.from === 'string' ? g.from : pointText(g.from.x, g.from.y);
      const far = pv && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 30;
      const before = s.doc.edges.length;
      if (pv?.target) {
        s.apply((src, doc) => addEdge(src, doc, fromText, pv.target!, '->', { fromPort: g.port, toPort: pv.targetPort }));
      } else if (far && (!e.altKey || typeof g.from !== 'string')) {
        // dropped on empty canvas: the arrow ends right there
        s.apply((src, doc) => addEdge(src, doc, fromText, pointText(pv!.to.x, pv!.to.y), '->', { fromPort: g.port }));
      } else if (far && typeof g.from === 'string') {
        // Alt + drop on empty canvas: spawn a sibling node and connect it
        const fromId = g.from;
        const from = s.doc.nodeMap.get(fromId)!;
        const id = uniqueId(s.doc, ID_STEM[from.kind]);
        const box = { x: snapTo(p.x - from.w / 2, grid), y: snapTo(p.y - from.h / 2, grid), w: from.w, h: from.h };
        s.apply((src, doc) => {
          let out = addNodes(src, doc, [{ kind: from.kind, id, x: box.x, y: box.y, w: box.w, h: box.h, classes: from.classes, attrs: pick(from.attrs, ['fill', 'stroke', 'text', 'in']) }]);
          out = addEdge(out, reparse(out), fromId, id, '->', { fromPort: g.port });
          return out;
        });
        useStore.getState().select({ nodes: [id] });
        useStore.getState().setEditing({ type: 'node', id });
      }
      const st = useStore.getState();
      if (st.doc.edges.length > before && !st.editing) st.select({ edges: [st.doc.edges[st.doc.edges.length - 1].key] });
      setHover(null);
    }
    setOverlay({ guides: [] });
  };

  /** After a move: put nodes into the container they were dropped in (or take them out). */
  const reparent = (top: string[]) => {
    const s = useStore.getState();
    const changes: { id: string; parent: string | undefined }[] = [];
    for (const id of top) {
      const n = s.layout.nodeMap.get(id);
      if (!n) continue;
      const exclude = new Set([id, ...descendants(s.doc, [id])]);
      const parent = smallestContainer(s.layout, n.box, exclude);
      const cur = n.def.attrs.in;
      if (parent !== cur) {
        // only *leave* a parent if fully outside of it, only *enter* if fully inside
        if (cur && !parent) {
          const pb = s.layout.nodeMap.get(cur)?.box;
          if (pb && boxesIntersect(pb, n.box)) continue;
        }
        changes.push({ id, parent });
      }
    }
    if (!changes.length) return;
    let src = s.src;
    for (const c of changes) src = setNodesAttr(src, reparse(src), [c.id], 'in', c.parent);
    s.setSource(src, { history: 'none' });
    const c = changes[0];
    s.notify(c.parent ? `「${c.id}」を「${c.parent}」の中に入れました` : `「${c.id}」をグループから出しました`);
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (Date.now() - lastTouchUp.current < 800) return; // handled as a touch double-tap
    handleDouble(e.clientX, e.clientY);
  };

  const handleDouble = (clientX: number, clientY: number) => {
    const s = useStore.getState();
    // pointer capture retargets click events to the <svg>, so hit-test by position
    const { nodeId, edgeKey } = hitAt(clientX, clientY);
    const slot = !nodeId && !edgeKey ? placeholderAt(clientX, clientY) : undefined;
    if (slot) {
      // fill an empty slot of the page's layout
      // (a list / table slot is filled with its `{ }` lines, not a label)
      const kind = s.doc.deck?.placeholders.find((n) => n.id === slot)?.kind;
      s.apply((src, doc) => addNodeLines(src, doc, [kind === 'list' || kind === 'table' ? slot : `${slot} ""`]));
      useStore.getState().select({ nodes: [slot] });
      useStore.getState().setEditing({ type: 'node', id: slot });
      return;
    }
    if (nodeId) {
      s.select({ nodes: [nodeId] });
      s.setEditing({ type: 'node', id: nodeId, at: toWorld(clientX, clientY) });
    } else if (edgeKey) {
      s.select({ edges: [edgeKey] });
      s.setEditing({ type: 'edge', id: edgeKey });
    } else {
      const p = toWorld(clientX, clientY);
      const [w, h] = DEFAULT_SIZE.round;
      const id = uniqueId(s.doc, 'box');
      const box = { x: snapTo(p.x - w / 2, grid), y: snapTo(p.y - h / 2, grid), w, h };
      const parent = smallestContainer(s.layout, box, new Set());
      s.apply((src, doc) => addNodes(src, doc, [{ kind: 'round', id, x: box.x, y: box.y, w, h, attrs: parent ? { in: parent } : undefined }]));
      useStore.getState().select({ nodes: [id] });
      useStore.getState().setEditing({ type: 'node', id });
    }
  };

  // ── derived overlay data
  const z = view.zoom;
  const deck = useStore((s) => s.doc.deck);
  const slotView = !!deck && 'layout' in deck.view;
  const placeholders = useMemo(() => {
    const d = useStore.getState().doc;
    return (deck?.placeholders ?? []).map((n) => layoutNode(d, n, canvasMeasure));
  }, [deck]);
  const nodeSeverity = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const i of issues) for (const id of i.nodes) if (m.get(id) !== 'error') m.set(id, i.severity);
    return m;
  }, [issues]);
  const edgeSeverity = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const i of issues) for (const k of i.edges) if (m.get(k) !== 'error') m.set(k, i.severity);
    return m;
  }, [issues]);
  const spotIssue = issues.find((i) => i.id === (hoverIssue ?? focusIssue));
  const selNodes = selection.nodes.map((id) => layout.nodeMap.get(id)).filter(Boolean) as Layout['nodes'];
  const selEdges = selection.edges.map((k) => layout.edgeMap.get(k)).filter(Boolean) as Layout['edges'];
  const single = selNodes.length === 1 && !selEdges.length ? selNodes[0] : undefined;
  const portNodeId = hover ?? (coarse && selection.nodes.length === 1 && !selection.edges.length ? selection.nodes[0] : null);
  const showPortsFor = gesture.current?.type === 'move' || gesture.current?.type === 'resize' ? undefined : (tool === 'select' || tool === 'edge') && portNodeId ? layout.nodeMap.get(portNodeId) : undefined;
  const dotStep = 20 * z < 10 ? 100 * z : 20 * z;
  const canvasCls = ['canvas', panning ? 'panning' : '', tool === 'pan' ? 'tool-pan' : '', tool !== 'select' && tool !== 'pan' && tool !== 'edge' ? 'tool-create' : ''].join(' ');
  const emptyDoc = layout.nodes.length === 0 && !layout.frame;

  return (
    <ImageHrefContext.Provider value={imageHref}>
      <svg
        ref={svgRef}
        className={canvasCls}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files].filter(isImageFile);
          if (!files.length) return;
          e.preventDefault();
          insertImages(files, toWorld(e.clientX, e.clientY));
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => !gesture.current && setHover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="dots" width={dotStep} height={dotStep} patternUnits="userSpaceOnUse" x={view.x % dotStep} y={view.y % dotStep}>
            <circle cx={1} cy={1} r={1} style={{ fill: 'var(--dot)' }} />
          </pattern>
          <pattern id="hatch" width={8 / z} height={8 / z} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={8 / z} height={8 / z} fill="rgba(244,63,94,0.16)" />
            <line x1={0} y1={0} x2={0} y2={8 / z} stroke="rgba(244,63,94,0.75)" strokeWidth={3 / z} />
          </pattern>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={3 / z} />
          </filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#dots)" />
        <g transform={`translate(${view.x} ${view.y}) scale(${z})`}>
          {/* the page (decks / set canvas=) */}
          {layout.frame && <rect className="page-frame" x={layout.frame.x} y={layout.frame.y} width={layout.frame.w} height={layout.frame.h} fill="#ffffff" strokeWidth={1 / z} />}
          {/* empty slots of the page's layout: double-click to fill */}
          {placeholders.map((n) => (
            <g key={'slot' + n.id} data-slot={n.id} className="slot-placeholder">
              <rect x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h} rx={4 / z} strokeWidth={1.25 / z} strokeDasharray={`${5 / z} ${4 / z}`} />
              <text x={n.box.x + 8 / z} y={n.box.y + 16 / z} fontSize={11 / z}>
                {n.id}
                {n.def.label ? ` — ${n.def.label.split('\n')[0]}` : ''}
              </text>
            </g>
          ))}
          {/* diagram: the layout's shapes are shown but not editable from a page */}
          {layout.nodes.map((n) =>
            n.def.locked ? (
              <g key={n.id} className="locked">
                <NodeShape n={n} />
                {slotView && n.def.slot && <SlotTag n={n} z={z} />}
              </g>
            ) : (
              <g key={n.id}>
                <NodeShape n={n} interactive hideText={editing?.type === 'node' && editing.id === n.id} />
                {slotView && n.def.slot && <SlotTag n={n} z={z} />}
              </g>
            ),
          )}
          {/* edge issue underlay */}
          {layout.edges.map((e) => {
            const sev = edgeSeverity.get(e.key);
            return sev ? <path key={e.key} d={e.path} fill="none" stroke={sev === 'error' ? 'var(--danger)' : 'var(--warn)'} strokeWidth={e.style.lw + 6 / z} opacity={0.28} strokeLinecap="round" style={{ pointerEvents: 'none' }} /> : null;
          })}
          {selEdges.map((e) => (
            <path key={'sel' + e.key} d={e.path} fill="none" stroke="var(--accent)" strokeWidth={e.style.lw + 5 / z} opacity={0.3} strokeLinecap="round" style={{ pointerEvents: 'none' }} />
          ))}
          {layout.edges.map((e) => (
            <g key={e.key} className={e.def.locked ? 'locked' : undefined}>
              <EdgeShape e={e} interactive={!e.def.locked} />
            </g>
          ))}
          {layout.edges.map((e) => (
            <g key={e.key} className={e.def.locked ? 'locked' : undefined}>
              <EdgeLabel e={e} bg={layout.frame ? '#ffffff' : 'var(--canvas)'} interactive={!e.def.locked} />
            </g>
          ))}

          {/* issues */}
          <g style={{ pointerEvents: 'none' }}>
            {layout.nodes.map((n) => {
              const sev = nodeSeverity.get(n.id);
              if (!sev) return null;
              const col = sev === 'error' ? 'var(--danger)' : 'var(--warn)';
              return (
                <g key={n.id}>
                  <path d={n.path} fill="none" stroke={col} strokeWidth={6 / z} opacity={0.35} filter="url(#glow)" />
                  <path d={n.path} fill="none" stroke={col} strokeWidth={1.75 / z} className="issue-ring" />
                </g>
              );
            })}
            {issues.map((i) =>
              i.region ? (
                <polygon
                  key={i.id}
                  points={i.region.map((q) => `${q.x},${q.y}`).join(' ')}
                  fill={i.code === 'overlap' ? 'url(#hatch)' : 'none'}
                  stroke={i.severity === 'error' ? 'var(--danger)' : 'var(--warn)'}
                  strokeWidth={1.25 / z}
                  strokeDasharray={i.code === 'overlap' ? undefined : `${4 / z} ${3 / z}`}
                />
              ) : null,
            )}
            {spotIssue && <IssueSpot layout={layout} issue={spotIssue} z={z} />}
          </g>

          {/* selection */}
          <g style={{ pointerEvents: 'none' }}>
            {selNodes.map((n) => (
              <path key={n.id} d={n.path} fill="none" stroke="var(--accent)" strokeWidth={2 / z} />
            ))}
            {selNodes.length > 1 &&
              (() => {
                const xs = selNodes.flatMap((n) => [n.box.x, n.box.x + n.box.w]);
                const ys = selNodes.flatMap((n) => [n.box.y, n.box.y + n.box.h]);
                const x = Math.min(...xs) - 6 / z,
                  y = Math.min(...ys) - 6 / z;
                return <rect x={x} y={y} width={Math.max(...xs) - x + 6 / z} height={Math.max(...ys) - y + 6 / z} fill="none" stroke="var(--accent)" strokeWidth={1 / z} strokeDasharray={`${4 / z} ${4 / z}`} rx={6 / z} />;
              })()}
          </g>
          {selEdges.length === 1 &&
            !editing &&
            selEdges.map((e) => (
              <g key={e.key}>
                {(['from', 'to'] as const).map((which) => {
                  const q = which === 'from' ? e.pts[0] : e.pts[e.pts.length - 1];
                  const free = !!e.free[which];
                  return (
                    <circle
                      key={which}
                      data-edge-end={which}
                      data-edge-key={e.key}
                      className="edge-end"
                      cx={q.x}
                      cy={q.y}
                      r={(coarse ? 8 : free ? 5 : 4) / z}
                      fill={free ? 'var(--accent)' : 'var(--panel-solid)'}
                      stroke="var(--accent)"
                      strokeWidth={1.5 / z}
                    />
                  );
                })}
              </g>
            ))}
          {single && !editing && gesture.current?.type !== 'move' && (
            <g>
              <rect x={single.box.x} y={single.box.y} width={single.box.w} height={single.box.h} fill="none" stroke="var(--accent)" strokeWidth={1 / z} strokeDasharray={`${3 / z} ${3 / z}`} style={{ pointerEvents: 'none' }} opacity={single.kind === 'rect' ? 0 : 0.6} />
              {HANDLES.map((h) => {
                const b = single.box;
                const hx = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2;
                const hy = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2;
                const r = (coarse ? 7 : 4.5) / z;
                return <rect key={h} data-handle={h} className="handle" x={hx - r} y={hy - r} width={r * 2} height={r * 2} rx={1.5 / z} strokeWidth={1.5 / z} style={{ cursor: HANDLE_CURSOR[h] }} />;
              })}
            </g>
          )}

          {/* hover + ports */}
          {hover && !selection.nodes.includes(hover) && layout.nodeMap.get(hover) && (
            <path d={layout.nodeMap.get(hover)!.path} fill="none" stroke="var(--accent)" strokeWidth={1.5 / z} opacity={0.55} style={{ pointerEvents: 'none' }} />
          )}
          {showPortsFor &&
            !editing &&
            PORTS.map((port) => {
              const q = portPoint(showPortsFor.poly, showPortsFor.box, port);
              const d = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[port];
              const off = coarse ? 18 / z : 0;
              return <circle key={port} data-port={port} data-port-node={showPortsFor.id} className="port" cx={q.x + d[0] * off} cy={q.y + d[1] * off} r={(coarse ? 9 : 5) / z} strokeWidth={1.5 / z} />;
            })}

          {/* gesture overlays */}
          {overlay.guides.map((gd, i) => (
            <g key={i} style={{ pointerEvents: 'none' }}>
              <line x1={gd.x1} y1={gd.y1} x2={gd.x2} y2={gd.y2} stroke="#ec4899" strokeWidth={1 / z} strokeDasharray={gd.label ? undefined : `${4 / z} ${3 / z}`} />
              {gd.label && (
                <text x={(gd.x1 + gd.x2) / 2 + (gd.x1 === gd.x2 ? 6 / z : 0)} y={(gd.y1 + gd.y2) / 2 + (gd.y1 === gd.y2 ? 12 / z : 0)} fontSize={10 / z} fill="#ec4899" fontWeight={700} textAnchor={gd.x1 === gd.x2 ? 'start' : 'middle'}>
                  {gd.label}
                </text>
              )}
            </g>
          ))}
          {overlay.marquee && <rect x={overlay.marquee.x} y={overlay.marquee.y} width={overlay.marquee.w} height={overlay.marquee.h} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={1 / z} rx={2 / z} />}
          {overlay.createBox && <rect x={overlay.createBox.x} y={overlay.createBox.y} width={overlay.createBox.w} height={overlay.createBox.h} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={1.5 / z} strokeDasharray={`${5 / z} ${4 / z}`} className="marching" />}
          {overlay.edgePreview && (
            <g style={{ pointerEvents: 'none' }}>
              <line x1={overlay.edgePreview.from.x} y1={overlay.edgePreview.from.y} x2={overlay.edgePreview.to.x} y2={overlay.edgePreview.to.y} stroke="var(--accent)" strokeWidth={2 / z} strokeDasharray={`${6 / z} ${4 / z}`} className="marching" />
              <circle cx={overlay.edgePreview.to.x} cy={overlay.edgePreview.to.y} r={4 / z} fill="var(--accent)" />
              {overlay.edgePreview.target && <path d={layout.nodeMap.get(overlay.edgePreview.target)?.path} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={2 / z} />}
            </g>
          )}
          {overlay.badge && (
            <g style={{ pointerEvents: 'none' }} transform={`translate(${overlay.badge.at.x} ${overlay.badge.at.y}) scale(${1 / z})`}>
              <rect x={0} y={-20} width={overlay.badge.text.length * 6.6 + 14} height={20} rx={6} fill="#0f172a" opacity={0.88} />
              <text x={7} y={-6} fontSize={11} fill="#f8fafc" fontWeight={600} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {overlay.badge.text}
              </text>
            </g>
          )}
        </g>
      </svg>
      {editing && <InlineEditor />}
      {emptyDoc && (
        <div className="empty-hint">
          <div>
            <h2>まっさらなキャンバス</h2>
            <div>左のツールで図形を置くか、ダブルクリックで追加。右のテキストに直接書いてもOK。</div>
          </div>
        </div>
      )}
    </ImageHrefContext.Provider>
  );
}

function IssueSpot({ layout, issue, z }: { layout: Layout; issue: { nodes: string[]; edges: string[] }; z: number }) {
  const boxes: Box[] = [];
  for (const id of issue.nodes) {
    const n = layout.nodeMap.get(id);
    if (n) boxes.push(n.box);
  }
  for (const k of issue.edges) {
    const e = layout.edgeMap.get(k);
    if (!e) continue;
    for (const p of e.pts) boxes.push({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  if (!boxes.length) return null;
  const x1 = Math.min(...boxes.map((b) => b.x)) - 10 / z,
    y1 = Math.min(...boxes.map((b) => b.y)) - 10 / z;
  const x2 = Math.max(...boxes.map((b) => b.x + b.w)) + 10 / z,
    y2 = Math.max(...boxes.map((b) => b.y + b.h)) + 10 / z;
  return <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} rx={10 / z} fill="rgba(244,63,94,0.05)" stroke="var(--danger)" strokeWidth={1.5 / z} strokeDasharray={`${6 / z} ${4 / z}`} className="marching" />;
}

/** Smallest node whose box fully contains `box` (excluding some ids). */
export function smallestContainer(layout: Layout, box: Box, exclude: Set<string>): string | undefined {
  let best: { id: string; area: number } | undefined;
  for (const n of layout.nodes) {
    if (exclude.has(n.id) || n.def.locked || n.kind === 'text' || n.kind === 'image') continue;
    if (!boxContains(n.box, box)) continue;
    if (n.box.w * n.box.h <= box.w * box.h * 1.2) continue;
    const area = n.box.w * n.box.h;
    if (!best || area < best.area) best = { id: n.id, area };
  }
  return best?.id;
}

function pick(o: Record<string, string>, keys: string[]) {
  const out: Record<string, string> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

/** Layout view: the slot's name on its box (slots are where pages put their content). */
function SlotTag({ n, z }: { n: NodeLayout; z: number }) {
  return (
    <g className="slot-tag" style={{ pointerEvents: 'none' }}>
      <rect x={n.box.x} y={n.box.y} width={n.box.w} height={n.box.h} fill="none" strokeWidth={1.25 / z} strokeDasharray={`${5 / z} ${4 / z}`} />
      <text x={n.box.x + 4 / z} y={n.box.y - 4 / z} fontSize={10 / z}>
        slot {n.id}
      </text>
    </g>
  );
}
