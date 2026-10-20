import type { Port, ShapeKind } from '../dsl/types';

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const center = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export function boxesIntersect(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

export function boxContains(outer: Box, inner: Box, eps = 0.01): boolean {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
}

export function unionBox(boxes: Box[]): Box | undefined {
  if (!boxes.length) return undefined;
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.w);
    y2 = Math.max(y2, b.y + b.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function polyBox(poly: Pt[]): Box {
  return unionBox(poly.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))!;
}

export type TrapDir = 'up' | 'down' | 'left' | 'right';

export interface ShapeOpts {
  skew: number;
  radius: number;
  /** trap only: which side is the short one (default 'up') */
  dir?: TrapDir;
}

const horizontalTrap = (kind: ShapeKind, o: ShapeOpts) => kind === 'trap' && (o.dir === 'left' || o.dir === 'right');

/** Inset used by slanted shapes, in px. */
export function slant(kind: ShapeKind, b: Box, skew: number, dir?: TrapDir): number {
  const s = Math.max(0, Math.min(0.45, skew));
  if (kind === 'hex') return Math.min(s * b.w, b.h * 0.6);
  if (kind === 'trap' && (dir === 'left' || dir === 'right')) return s * b.h;
  return s * b.w;
}

/** Convex outline used for collision and edge clipping (clockwise in screen space). */
export function outline(kind: ShapeKind, b: Box, o: ShapeOpts): Pt[] {
  const { x, y, w, h } = b;
  const k = slant(kind, b, o.skew, o.dir);
  switch (kind) {
    case 'ellipse':
    case 'cross':
    case 'plus': {
      const pts: Pt[] = [];
      const N = 48;
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        pts.push({ x: x + w / 2 + (Math.cos(t) * w) / 2, y: y + h / 2 + (Math.sin(t) * h) / 2 });
      }
      return pts;
    }
    case 'diamond':
      return [
        { x: x + w / 2, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w / 2, y: y + h },
        { x, y: y + h / 2 },
      ];
    case 'trap':
      if (o.dir === 'right')
        return [
          { x, y },
          { x: x + w, y: y + k },
          { x: x + w, y: y + h - k },
          { x, y: y + h },
        ];
      if (o.dir === 'left')
        return [
          { x, y: y + k },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h - k },
        ];
      if (o.dir === 'down')
        return [
          { x, y },
          { x: x + w, y },
          { x: x + w - k, y: y + h },
          { x: x + k, y: y + h },
        ];
      return [
        { x: x + k, y },
        { x: x + w - k, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
    case 'para':
      return [
        { x: x + k, y },
        { x: x + w, y },
        { x: x + w - k, y: y + h },
        { x, y: y + h },
      ];
    case 'hex':
      return [
        { x: x + k, y },
        { x: x + w - k, y },
        { x: x + w, y: y + h / 2 },
        { x: x + w - k, y: y + h },
        { x: x + k, y: y + h },
        { x, y: y + h / 2 },
      ];
    default:
      return [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
  }
}

/** SVG path for rendering. */
export function shapePath(kind: ShapeKind, b: Box, o: ShapeOpts): string {
  const { x, y, w, h } = b;
  if (kind === 'ellipse' || kind === 'cross' || kind === 'plus') {
    const rx = w / 2,
      ry = h / 2;
    const ring = `M${x} ${y + ry}A${rx} ${ry} 0 1 0 ${x + w} ${y + ry}A${rx} ${ry} 0 1 0 ${x} ${y + ry}Z`;
    if (kind === 'ellipse') return ring;
    return ring + junctionStrokes(kind, b).map(([p, q]) => `M${round2(p.x)} ${round2(p.y)}L${round2(q.x)} ${round2(q.y)}`).join('');
  }
  if (kind === 'round') {
    const r = Math.max(0, Math.min(o.radius, w / 2, h / 2));
    return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
  }
  const pts = outline(kind, b, o);
  return 'M' + pts.map((p) => `${round2(p.x)} ${round2(p.y)}`).join('L') + 'Z';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The two strokes inside a summing-junction circle: × for 'cross' (⊗), + for 'plus' (⊕). */
export function junctionStrokes(kind: 'cross' | 'plus', b: Box): [Pt, Pt][] {
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2,
    rx = b.w / 2,
    ry = b.h / 2;
  if (kind === 'plus')
    return [
      [{ x: b.x, y: cy }, { x: b.x + b.w, y: cy }],
      [{ x: cx, y: b.y }, { x: cx, y: b.y + b.h }],
    ];
  const dx = rx * Math.SQRT1_2,
    dy = ry * Math.SQRT1_2;
  return [
    [{ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy }],
    [{ x: cx - dx, y: cy + dy }, { x: cx + dx, y: cy - dy }],
  ];
}

/** Largest axis-aligned rectangle (centered) guaranteed inside the shape, minus padding. */
export function textBox(kind: ShapeKind, b: Box, o: ShapeOpts, padding: number): Box {
  const { x, y, w, h } = b;
  const k = slant(kind, b, o.skew, o.dir);
  let inner: Box;
  switch (kind) {
    case 'ellipse':
    case 'cross':
    case 'plus': {
      const iw = w / Math.SQRT2,
        ih = h / Math.SQRT2;
      inner = { x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih };
      break;
    }
    case 'diamond':
      inner = { x: x + w / 4, y: y + h / 4, w: w / 2, h: h / 2 };
      break;
    case 'trap':
    case 'para':
    case 'hex':
      inner = horizontalTrap(kind, o) ? { x, y: y + k, w, h: h - 2 * k } : { x: x + k, y, w: w - 2 * k, h };
      break;
    default:
      inner = b;
  }
  const p = kind === 'ellipse' || kind === 'cross' || kind === 'plus' || kind === 'diamond' ? padding / 2 : padding;
  return { x: inner.x + p, y: inner.y + p, w: Math.max(0, inner.w - 2 * p), h: Math.max(0, inner.h - 2 * p) };
}

// ───────────── polygon helpers (convex) ─────────────

export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function cross(o: Pt, a: Pt, b: Pt) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function segmentsIntersect(p1: Pt, p2: Pt, q1: Pt, q2: Pt): boolean {
  const d1 = cross(q1, q2, p1),
    d2 = cross(q1, q2, p2),
    d3 = cross(p1, p2, q1),
    d4 = cross(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentHitsPoly(a: Pt, b: Pt, poly: Pt[]): boolean {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segmentsIntersect(a, b, poly[j], poly[i])) return true;
  return false;
}

export function polylineHitsPoly(pts: Pt[], poly: Pt[]): boolean {
  for (let i = 1; i < pts.length; i++) if (segmentHitsPoly(pts[i - 1], pts[i], poly)) return true;
  return false;
}

/** Shrink a convex polygon towards its centroid by `d` px (approximate, for tolerance). */
export function shrinkPoly(poly: Pt[], d: number): Pt[] {
  const c = poly.reduce((s, p) => ({ x: s.x + p.x / poly.length, y: s.y + p.y / poly.length }), { x: 0, y: 0 });
  return poly.map((p) => {
    const dx = p.x - c.x,
      dy = p.y - c.y;
    const len = Math.hypot(dx, dy) || 1;
    const k = Math.max(0, len - d) / len;
    return { x: c.x + dx * k, y: c.y + dy * k };
  });
}

/**
 * Separating-axis distance between two convex polygons.
 * Positive = gap along the best separating axis, negative = penetration depth.
 */
export function polySeparation(a: Pt[], b: Pt[]): number {
  let best = -Infinity;
  for (const poly of [a, b]) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      let nx = poly[i].y - poly[j].y,
        ny = poly[j].x - poly[i].x;
      const len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      nx /= len;
      ny /= len;
      let amin = Infinity,
        amax = -Infinity,
        bmin = Infinity,
        bmax = -Infinity;
      for (const p of a) {
        const d = p.x * nx + p.y * ny;
        if (d < amin) amin = d;
        if (d > amax) amax = d;
      }
      for (const p of b) {
        const d = p.x * nx + p.y * ny;
        if (d < bmin) bmin = d;
        if (d > bmax) bmax = d;
      }
      const sep = Math.max(bmin - amax, amin - bmax);
      if (sep > best) best = sep;
    }
  }
  return best;
}

/** Sutherland–Hodgman clip of `subject` by convex `clip` (both clockwise or both ccw). */
export function clipPoly(subject: Pt[], clip: Pt[]): Pt[] {
  let out = subject;
  const orient = Math.sign(area(clip)) || 1;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length];
    const inside = (p: Pt) => cross(a, b, p) * orient >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j],
        prev = input[(j + input.length - 1) % input.length];
      const ci = inside(cur),
        pi = inside(prev);
      if (ci) {
        if (!pi) out.push(lineIntersect(prev, cur, a, b));
        out.push(cur);
      } else if (pi) out.push(lineIntersect(prev, cur, a, b));
    }
  }
  return out;
}

export function area(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x - poly[i].x) * (poly[j].y + poly[i].y);
  return s / 2;
}

function lineIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-12) return p2;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/** Where a ray from `from` towards `toward` leaves the convex polygon (from must be inside). */
export function rayExit(poly: Pt[], from: Pt, toward: Pt): Pt {
  const dx = toward.x - from.x,
    dy = toward.y - from.y;
  if (Math.hypot(dx, dy) < 1e-9) return from;
  let bestT = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j],
      b = poly[i];
    const ex = b.x - a.x,
      ey = b.y - a.y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / den;
    const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / den;
    if (t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 && t < bestT) bestT = t;
  }
  if (!Number.isFinite(bestT)) return from;
  return { x: from.x + dx * bestT, y: from.y + dy * bestT };
}

export const PORT_DIR: Record<Port, Pt> = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } };

/** Where an edge leaves `port`; `at` (0..1) slides the port along that side (default: the middle). */
export function portPoint(poly: Pt[], b: Box, port: Port, at?: number): Pt {
  let c = center(b);
  if (at !== undefined && Number.isFinite(at)) {
    const t = Math.max(0, Math.min(1, at));
    c = port === 'n' || port === 's' ? { x: b.x + t * b.w, y: c.y } : { x: c.x, y: b.y + t * b.h };
  }
  const d = PORT_DIR[port];
  return rayExit(poly, c, { x: c.x + d.x * (b.w + b.h), y: c.y + d.y * (b.w + b.h) });
}

export function polylineLength(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
}

export function pointAlong(pts: Pt[], t: number): { p: Pt; angle: number } {
  const total = polylineLength(pts);
  let target = total * t;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1],
      b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (target <= seg || i === pts.length - 1) {
      const k = seg ? Math.min(1, target / seg) : 0;
      return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, angle: Math.atan2(b.y - a.y, b.x - a.x) };
    }
    target -= seg;
  }
  return { p: pts[0], angle: 0 };
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Pt, pts: Pt[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i - 1], pts[i]));
  return d;
}
