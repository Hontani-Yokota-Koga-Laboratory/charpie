import { descendants, parse } from '../dsl/parse';
import { setEdgesAttr, setNodesAttr, setNodesGeom, type Geom } from '../dsl/patch';
import type { Doc } from '../dsl/types';
import { outline, polySeparation, polylineHitsPoly, shrinkPoly, boxesIntersect, polyBox, type Box } from '../geom/geom';
import { computeLayout, edgeEnds, layoutEdge, layoutNode } from '../layout';
import type { Measure } from '../text/fit';
import { checkLayout, type Issue } from './check';

export interface FixOptions {
  /** nodes that should stay put if possible */
  pinned?: Set<string>;
  /** only fix these issue ids (default: all) */
  only?: Set<string>;
}

const snap = (v: number) => Math.round(v);

/**
 * Resolve overlaps / overflow / containment / edges-through-nodes with
 * minimal movement. Returns the patched source (unchanged if nothing to do).
 */
export function autoFix(src: string, measure: Measure, opts: FixOptions = {}): string {
  let out = src;
  for (let pass = 0; pass < 5; pass++) {
    const next = fixOnce(out, measure, pass === 0 ? opts : { pinned: opts.pinned });
    if (next === out) break;
    out = next;
    const d = parse(out);
    if (!checkLayout(d, computeLayout(d, measure)).some((i) => i.severity === 'error')) break;
  }
  return out;
}

function fixOnce(src: string, measure: Measure, opts: FixOptions): string {
  let doc = parse(src);
  const issues = checkLayout(doc, computeLayout(doc, measure)).filter((i) => !opts.only || opts.only.has(i.id));
  if (!issues.length) return src;

  const want = (code: Issue['code']) => issues.some((i) => i.code === code);
  const geoms = new Map<string, Box>(doc.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }]));
  const touched = new Set<string>();
  const pinned = opts.pinned ?? new Set<string>();
  const scope = (code: Issue['code']) => new Set(issues.filter((i) => i.code === code).flatMap((i) => i.nodes));

  // 1. grow nodes whose text doesn't fit (target: fits at a readable 12px or fontmin)
  if (want('text-overflow')) {
    for (const id of scope('text-overflow')) {
      const n = doc.nodeMap.get(id)!;
      const g = geoms.get(id)!;
      for (let step = 0; step < 40; step++) {
        const lay = layoutNode(doc, n, measure, g);
        if (!lay.text.overflow) break;
        // grow the dimension that is relatively tighter, keeping the center
        const growW = lay.text.width > lay.textBox.w || g.w / g.h < 2.2;
        if (growW) {
          g.x -= 5;
          g.w += 10;
        } else {
          g.y -= 5;
          g.h += 10;
        }
        touched.add(id);
      }
    }
  }

  const isAncestor = (a: string, b: string) => {
    let cur = doc.nodeMap.get(b)?.attrs.in;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === a) return true;
      seen.add(cur);
      cur = doc.nodeMap.get(cur)?.attrs.in;
    }
    return false;
  };

  const moveTree = (id: string, dx: number, dy: number) => {
    for (const t of [id, ...descendants(doc, [id])]) {
      const g = geoms.get(t)!;
      g.x = snap(g.x + dx);
      g.y = snap(g.y + dy);
      touched.add(t);
    }
  };

  // covered container labels: push the parent's top edge up to make room
  const toTop: string[] = [];
  for (const iss of issues.filter((i) => i.code === 'text-covered')) {
    const pid = iss.nodes[0];
    const p = geoms.get(pid)!;
    const pdef = doc.nodeMap.get(pid)!;
    if (!pdef.attrs.valign || pdef.attrs.valign === 'middle') {
      pdef.attrs.valign = 'top';
      toTop.push(pid);
    }
    const lay = layoutNode(doc, doc.nodeMap.get(pid)!, measure, p);
    const need = lay.textRect.y + lay.textRect.h + 6;
    const kids = iss.nodes.slice(1).map((id) => geoms.get(id)!);
    const top = Math.min(...kids.map((k) => k.y));
    if (lay.style.valign !== 'bottom' && need > top) {
      const d = Math.ceil(need - top);
      p.y -= d;
      p.h += d;
      touched.add(pid);
    } else {
      p.h += Math.ceil(lay.textRect.h + 12);
      touched.add(pid);
    }
  }

  // edge labels squeezed between their own endpoints: open up the gap
  const labelBend: string[] = [];
  {
    const lay = computeLayout(doc, measure);
    for (const iss of issues.filter((i) => i.code === 'label-overlap')) {
      const e = lay.edgeMap.get(iss.edges[0]);
      if (!e?.label) continue;
      const own = iss.nodes.filter((id) => id === e.def.from || id === e.def.to);
      if (own.length && own.length === iss.nodes.length && e.def.from !== e.def.to && geoms.has(e.def.from) && geoms.has(e.def.to)) {
        const a = geoms.get(e.def.from)!,
          b = geoms.get(e.def.to)!;
        const dx = b.x + b.w / 2 - (a.x + a.w / 2),
          dy = b.y + b.h / 2 - (a.y + a.h / 2);
        const pad = 10;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const avail = dx > 0 ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
          const need = e.label.box.w + pad * 2;
          if (avail < need) moveTree(e.def.to, Math.sign(dx || 1) * Math.ceil(need - avail), 0);
        } else {
          const avail = dy > 0 ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
          const need = e.label.box.h + pad * 2;
          if (avail < need) moveTree(e.def.to, 0, Math.sign(dy || 1) * Math.ceil(need - avail));
        }
      } else labelBend.push(e.key);
    }
  }

  const overlapIds = new Set([...scope('overlap'), ...scope('too-close'), ...scope('containment'), ...(touched.size ? touched : [])]);
  if (overlapIds.size) {
    const gap = Math.max(doc.settings.gap, 0);
    for (let iter = 0; iter < 300; iter++) {
      const lays = new Map(doc.nodes.map((n) => [n.id, layoutNode(doc, n, measure, geoms.get(n.id))]));
      let changed = false;

      // containment: grow parents around children
      for (const n of doc.nodes) {
        const pid = n.attrs.in;
        if (!pid || !geoms.has(pid)) continue;
        const c = geoms.get(n.id)!,
          p = geoms.get(pid)!;
        const pad = 16;
        const x1 = Math.min(p.x, c.x - pad),
          y1 = Math.min(p.y, c.y - pad - 12);
        const x2 = Math.max(p.x + p.w, c.x + c.w + pad),
          y2 = Math.max(p.y + p.h, c.y + c.h + pad);
        if (x1 < p.x || y1 < p.y || x2 > p.x + p.w || y2 > p.y + p.h) {
          Object.assign(p, { x: snap(x1), y: snap(y1), w: snap(x2 - x1), h: snap(y2 - y1) });
          touched.add(pid);
          changed = true;
        }
      }

      for (let i = 0; i < doc.nodes.length; i++) {
        for (let j = i + 1; j < doc.nodes.length; j++) {
          const A = doc.nodes[i],
            B = doc.nodes[j];
          if (!overlapIds.has(A.id) && !overlapIds.has(B.id) && iter === 0) continue;
          if (isAncestor(A.id, B.id) || isAncestor(B.id, A.id)) continue;
          if ([A, B].some((n) => n.attrs.overlap === 'allow' || n.attrs.overlap === 'true')) continue;
          const ga = geoms.get(A.id)!,
            gb = geoms.get(B.id)!;
          if (!boxesIntersect(ga, gb, gap)) continue;
          const sep = polySeparation(lays.get(A.id)!.poly, lays.get(B.id)!.poly);
          if (sep >= gap - 0.5) continue;
          // siblings must be compared at the same tree level: move the top-most differing ancestors
          let ma = A.id,
            mb = B.id;
          const pa = lays.get(A.id)!.parents,
            pb = lays.get(B.id)!.parents;
          const common = pa.find((x) => pb.includes(x));
          const lift = (id: string, chain: string[]) => {
            const idx = common ? chain.indexOf(common) : chain.length;
            return idx > 0 ? chain[idx - 1] : id;
          };
          ma = lift(A.id, pa);
          mb = lift(B.id, pb);
          if (ma === mb) continue;
          const a = geoms.get(ma)!,
            b = geoms.get(mb)!;
          // minimal translation along x or y (bbox-based → always separates)
          const pushRight = b.x + b.w / 2 >= a.x + a.w / 2;
          const pushDown = b.y + b.h / 2 >= a.y + a.h / 2;
          const ox = pushRight ? a.x + a.w + gap - b.x : b.x + b.w + gap - a.x;
          const oy = pushDown ? a.y + a.h + gap - b.y : b.y + b.h + gap - a.y;
          // decide who moves: unpinned, later-declared, smaller
          let mover = mb,
            other = ma;
          const order = (id: string) => doc.nodeMap.get(id)!.line;
          if (pinned.has(mb) && !pinned.has(ma)) [mover, other] = [ma, mb];
          else if (pinned.has(mb) === pinned.has(ma) && order(ma) > order(mb)) [mover, other] = [ma, mb];
          const sign = mover === mb ? 1 : -1;
          if (ox <= oy) moveTree(mover, sign * (pushRight ? 1 : -1) * Math.ceil(ox), 0);
          else moveTree(mover, 0, sign * (pushDown ? 1 : -1) * Math.ceil(oy));
          void other;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  let out = src;
  if (toTop.length) touched.add(toTop[0]);
  if (touched.size) {
    const g: Record<string, Partial<Geom>> = {};
    for (const id of touched) g[id] = geoms.get(id)!;
    out = setNodesGeom(out, doc, g);
    doc = parse(out);
  }
  if (toTop.length) {
    out = setNodesAttr(out, doc, toTop, 'valign', 'top');
    doc = parse(out);
  }

  // edges through nodes: try bends / orthogonal routing
  const through = [...issues.filter((i) => i.code === 'edge-through').flatMap((i) => i.edges), ...labelBend];
  if (through.length) {
    const lay = computeLayout(doc, measure);
    for (const key of through) {
      const e = doc.edges.find((x) => x.key === key);
      if (!e) continue;
      const ends = edgeEnds(doc, e, lay.nodeMap);
      if (!ends) continue;
      const { a, b } = ends;
      const parentsOf = (x: typeof a) => ('parents' in x ? x.parents : []);
      const exempt = new Set([e.from, e.to, ...parentsOf(a), ...parentsOf(b)]);
      const clear = (attrs: Record<string, string>) => {
        const el = layoutEdge(doc, { ...e, attrs: { ...e.attrs, ...attrs } }, a, b, measure);
        const eb = polyBox(el.pts);
        if (lay.nodes.some((n) => !exempt.has(n.id) && boxesIntersect(eb, n.box, 1) && polylineHitsPoly(el.pts, shrinkPoly(n.poly, 1)))) return false;
        if (!el.label) return true;
        const lp = outline('rect', el.label.box, { skew: 0, radius: 0 });
        const anc = new Set([...parentsOf(a), ...parentsOf(b)]);
        return !lay.nodes.some((n) => !anc.has(n.id) && boxesIntersect(el.label!.box, n.box) && polySeparation(lp, n.poly) < -0.5);
      };
      const candidates: Record<string, string>[] = [{ route: 'ortho' }];
      for (const b of [30, -30, 60, -60, 90, -90, 130, -130, 180, -180]) candidates.push({ route: 'curve', bend: String(b) });
      const hit = candidates.find(clear);
      if (hit) {
        for (const [k, v] of Object.entries(hit)) {
          out = setEdgesAttr(out, doc, [key], k, v);
          doc = parse(out);
        }
        if (hit.route === 'ortho') {
          out = setEdgesAttr(out, doc, [key], 'bend', undefined);
          doc = parse(out);
        }
      }
    }
  }
  return out;
}

export function describeFix(before: Doc, after: Doc): number {
  let moved = 0;
  for (const n of after.nodes) {
    const o = before.nodeMap.get(n.id);
    if (o && (o.x !== n.x || o.y !== n.y || o.w !== n.w || o.h !== n.h)) moved++;
  }
  return moved;
}
