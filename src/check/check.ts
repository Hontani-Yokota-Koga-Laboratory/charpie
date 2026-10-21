import type { Doc } from '../dsl/types';
import { endText } from '../dsl/parse';
import { boxContains, boxesIntersect, clipPoly, outline, polyBox, polySeparation, polylineHitsPoly, shrinkPoly, type Pt } from '../geom/geom';
import type { Layout, NodeLayout } from '../layout';
import { renderMath, splitMath } from '../text/math';

export type IssueCode = 'text-covered' | 'overlap' | 'too-close' | 'text-overflow' | 'containment' | 'edge-through' | 'label-overlap' | 'self-loop' | 'tex' | 'off-page';

export interface Issue {
  id: string;
  code: IssueCode;
  severity: 'error' | 'warning';
  message: string;
  nodes: string[];
  edges: string[];
  /** region to highlight on the canvas */
  region?: Pt[];
  /** silenced by an `ignore=` on one of the items involved */
  ignored?: boolean;
}

/** Names used in `ignore=` (comma-separated, or `all`). */
export const IGNORE_NAME: Record<IssueCode, string> = {
  overlap: 'overlap',
  'too-close': 'gap',
  'text-overflow': 'text',
  containment: 'contain',
  'edge-through': 'through',
  'label-overlap': 'label',
  'self-loop': 'loop',
  'text-covered': 'covered',
  tex: 'tex',
  'off-page': 'page',
};

const ignoreSet = (v: string | undefined): Set<string> => new Set((v ?? '').split(',').map((x) => x.trim()).filter(Boolean));

/** An issue is silenced when any shape / arrow it involves ignores its kind. */
function isIgnored(i: Issue, layout: Layout, doc: Doc): boolean {
  const name = IGNORE_NAME[i.code];
  const hit = (v: string | undefined) => {
    if (!v) return false;
    const set = ignoreSet(v);
    return set.has('all') || set.has(name);
  };
  const styled = (classes: string[], attrs: Record<string, string>) => attrs.ignore ?? [...classes].reverse().map((c) => doc.styles.get(c)?.props.ignore).find(Boolean);
  return i.nodes.some((id) => {
    const n = layout.nodeMap.get(id);
    return !!n && hit(styled(n.def.classes, n.def.attrs));
  }) || i.edges.some((k) => {
    const e = layout.edgeMap.get(k);
    return !!e && hit(styled(e.def.classes, e.def.attrs));
  });
}

/** Active issues only (what `check` reports and the UI flags). */
export function checkLayout(doc: Doc, layout: Layout): Issue[] {
  return checkAll(doc, layout).filter((i) => !i.ignored);
}

export const ISSUE_LABEL: Record<IssueCode, string> = {
  overlap: '図形の重なり',
  'too-close': '間隔不足',
  'text-overflow': '文字のはみ出し',
  containment: '親からのはみ出し',
  'edge-through': '矢印が図形を貫通',
  'label-overlap': 'ラベルの衝突',
  'self-loop': '自己ループ',
  'text-covered': '文字が子に隠れる',
  tex: 'TeX エラー',
  'off-page': 'ページ外',
};

const allowsOverlap = (n: NodeLayout) => n.def.attrs.overlap === 'allow' || n.def.attrs.overlap === 'true';

/** All issues, with `ignored` set on the silenced ones. */
export function checkAll(doc: Doc, layout: Layout): Issue[] {
  const issues: Issue[] = [];
  const gap = doc.settings.gap;
  const nodes = layout.nodes;

  // 1. text overflow
  for (const n of nodes) {
    if (n.text.overflow) {
      issues.push({
        id: `text:${n.id}`,
        code: 'text-overflow',
        severity: 'error',
        message: n.style.font
          ? `「${n.id}」の文字が ${n.style.font}px では収まりません`
          : `「${n.id}」の文字が最小 ${doc.settings.fontmin}px でも収まりません`,
        nodes: [n.id],
        edges: [],
        region: outline('rect', n.textBox, { skew: 0, radius: 0 }),
      });
    }
  }

  // 1a. formulas that MathJax cannot typeset (shown as their source)
  const texErrors = (label: string | undefined) =>
    label?.includes('$') ? splitMath(label).flatMap((g) => (g.math && renderMath(g.s).error ? [`$${g.s}$: ${renderMath(g.s).error}`] : [])) : [];
  for (const n of nodes)
    for (const [k, m] of texErrors(n.kind === 'image' ? '' : n.def.label).entries())
      issues.push({ id: `tex:${n.id}#${k}`, code: 'tex', severity: 'warning', message: `「${n.id}」の数式を組めません — ${m}`, nodes: [n.id], edges: [] });
  for (const e of layout.edges)
    for (const [k, m] of texErrors(e.def.label).entries())
      issues.push({ id: `tex:${e.key}#${k}`, code: 'tex', severity: 'warning', message: `矢印「${e.key}」の数式を組めません — ${m}`, nodes: [], edges: [e.key] });

  // 1b. a container's own text must not be covered by its children
  for (const p of nodes) {
    if (!p.def.label || p.textRect.w <= 0) continue;
    const tr = outline('rect', p.textRect, { skew: 0, radius: 0 });
    const covering = nodes.filter((c) => c.parents.includes(p.id) && boxesIntersect(c.box, p.textRect) && polySeparation(c.poly, tr) < -0.5);
    if (covering.length) {
      issues.push({
        id: `covered:${p.id}`,
        code: 'text-covered',
        severity: 'error',
        message: `「${p.id}」の文字が「${covering.map((c) => c.id).join('」「')}」に隠れています`,
        nodes: [p.id, ...covering.map((c) => c.id)],
        edges: [],
        region: tr,
      });
    }
  }

  // 2. containment (in=parent)
  for (const n of nodes) {
    const pid = n.def.attrs.in;
    const p = pid ? layout.nodeMap.get(pid) : undefined;
    if (!p) continue;
    const inside = n.poly.every((pt) => boxContains(p.box, { x: pt.x, y: pt.y, w: 0, h: 0 }, 0.5)) && polySeparation(n.poly, p.poly) < 0;
    const fullyInside = inside && clipArea(n.poly, p.poly) >= polyArea(n.poly) - 1;
    if (!fullyInside) {
      issues.push({
        id: `contain:${n.id}`,
        code: 'containment',
        severity: 'error',
        message: `「${n.id}」が親「${p.id}」の外にはみ出しています`,
        nodes: [n.id, p.id],
        edges: [],
      });
    }
  }

  // 3. pairwise overlap (SAT on convex outlines; bbox pre-filter)
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (!boxesIntersect(a.box, b.box, gap)) continue;
      if (a.parents.includes(b.id) || b.parents.includes(a.id)) continue;
      if (allowsOverlap(a) || allowsOverlap(b)) continue;
      const sep = polySeparation(a.poly, b.poly);
      const [first, second] = a.def.line <= b.def.line ? [a, b] : [b, a];
      if (sep < -0.5) {
        const region = clipPoly(a.poly, b.poly);
        issues.push({
          id: `overlap:${first.id}:${second.id}`,
          code: 'overlap',
          severity: 'error',
          message: `「${first.id}」と「${second.id}」が重なっています（${Math.round(-sep)}px）`,
          nodes: [first.id, second.id],
          edges: [],
          region: region.length >= 3 ? region : undefined,
        });
      } else if (gap > 0 && sep < gap - 0.5) {
        issues.push({
          id: `close:${first.id}:${second.id}`,
          code: 'too-close',
          severity: 'warning',
          message: `「${first.id}」と「${second.id}」の間隔が ${Math.max(0, Math.round(sep))}px（最小 ${gap}px）`,
          nodes: [first.id, second.id],
          edges: [],
        });
      }
    }
  }

  // 4. edges passing through unrelated nodes
  for (const e of layout.edges) {
    if (e.selfLoop) {
      issues.push({ id: `loop:${e.key}`, code: 'self-loop', severity: 'warning', message: `「${e.def.from}」の自己ループ`, nodes: [], edges: [e.key] });
      continue;
    }
    const exempt = new Set([e.def.from, e.def.to, ...(layout.nodeMap.get(e.def.from)?.parents ?? []), ...(layout.nodeMap.get(e.def.to)?.parents ?? [])]);
    const eb = polyBox(e.pts);
    const hits: string[] = [];
    const names: string[] = [];
    for (const n of nodes) {
      if (n.id === e.def.from || n.id === e.def.to || !boxesIntersect(eb, n.box, 1)) continue;
      if (!exempt.has(n.id) && polylineHitsPoly(e.pts, shrinkPoly(n.poly, 1))) {
        hits.push(n.id);
        names.push(n.id);
      } else if (n.def.label && n.textRect.w > 0 && polylineHitsPoly(e.pts, outline('rect', n.textRect, { skew: 0, radius: 0 }))) {
        // a group's title the arrow passes over must stay readable
        hits.push(n.id);
        names.push(`${n.id}」の文字「${n.def.label.split('\n')[0]}`);
      }
    }
    if (hits.length) {
      issues.push({
        id: `through:${e.key}`,
        code: 'edge-through',
        severity: 'error',
        message: `矢印 ${endText(e.def, 'from')} ${e.def.op} ${endText(e.def, 'to')} が「${names.join('」「')}」を貫通しています`,
        nodes: hits,
        edges: [e.key],
      });
    }
  }

  // 5. edge labels colliding with nodes or other labels
  const labeled = layout.edges.filter((e) => e.label);
  for (const e of labeled) {
    const lb = e.label!.box;
    const lpoly = outline('rect', lb, { skew: 0, radius: 0 });
    const exempt = new Set([...(layout.nodeMap.get(e.def.from)?.parents ?? []), ...(layout.nodeMap.get(e.def.to)?.parents ?? [])]);
    const hits = nodes.filter((n) => !exempt.has(n.id) && boxesIntersect(lb, n.box) && polySeparation(lpoly, n.poly) < -0.5).map((n) => n.id);
    const otherHits = labeled.filter((o) => o !== e && o.key > e.key && boxesIntersect(lb, o.label!.box, -0.5)).map((o) => o.key);
    if (hits.length || otherHits.length) {
      issues.push({
        id: `label:${e.key}`,
        code: 'label-overlap',
        severity: 'warning',
        message: `矢印ラベル「${e.def.label}」が${hits.length ? `「${hits.join('」「')}」` : '他のラベル'}と重なっています`,
        nodes: hits,
        edges: [e.key, ...otherHits],
        region: lpoly,
      });
    }
  }

  // 6. shapes leaving the page (`set canvas=` / decks)
  if (doc.canvas) {
    const page = { x: 0, y: 0, w: doc.canvas.w, h: doc.canvas.h };
    for (const n of nodes) {
      if (n.parents.length || boxContains(page, n.box, 0.5)) continue;
      issues.push({ id: `page:${n.id}`, code: 'off-page', severity: 'error', message: `「${n.id}」がページ（${page.w}x${page.h}）の外にはみ出しています`, nodes: [n.id], edges: [] });
    }
  }

  for (const i of issues) if (isIgnored(i, layout, doc)) i.ignored = true;
  // problems among inherited shapes belong to the layout that owns them (reported there once)
  if (doc.deck) {
    const mine = (i: Issue) => i.nodes.some((id) => !doc.nodeMap.get(id)?.locked) || i.edges.some((k) => !layout.edgeMap.get(k)?.def.locked);
    return issues.filter(mine);
  }
  return issues;
}

function polyArea(p: Pt[]) {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return Math.abs(s / 2);
}
function clipArea(a: Pt[], b: Pt[]) {
  const c = clipPoly(a, b);
  return c.length >= 3 ? polyArea(c) : 0;
}
