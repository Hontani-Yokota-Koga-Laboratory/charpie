import { describe, expect, it } from 'vitest';
import { parse } from './dsl/parse';
import { addEdge, addNodes, extractText, pasteText, removeItems, renameNode, setEdgeEnds, setEdgeLabel, setNodeLabel, setNodesAttr, setNodesGeom } from './dsl/patch';
import { computeLayout } from './layout';
import { checkLayout } from './check/check';
import { autoFix } from './check/resolve';
import { align, distribute, matchSize } from './ops/arrange';
import { approxMeasureFn, fitText } from './text/fit';

const SRC = `# demo
style accent { stroke: #6366f1; fill: #eef2ff; }

rect   api  "API Gateway" at (120, 80)  size 160x60 .accent
trap   db   "Database"    at (120, 240) size 160x70 fill=#fef3c7  // comment kept
ellipse user "User"       at (-120, 80) size 100x60

user -> api "request"
api -> db dash=dashed
`;

describe('parser', () => {
  it('parses nodes, edges and styles', () => {
    const d = parse(SRC);
    expect(d.diagnostics).toEqual([]);
    expect(d.nodes.map((n) => n.id)).toEqual(['api', 'db', 'user']);
    expect(d.nodeMap.get('db')).toMatchObject({ kind: 'trap', x: 120, y: 240, w: 160, h: 70, attrs: { fill: '#fef3c7' } });
    expect(d.edges.map((e) => e.key)).toEqual(['user->api#0', 'api->db#0']);
    expect(d.styles.get('accent')?.props.stroke).toBe('#6366f1');
  });
  it('tolerates errors line by line', () => {
    const d = parse('rect a "A" at (0, 0) size 10x10\nblob b\nrect c at (1,2\nrect d "D"\na -> zz');
    expect(d.nodes.map((n) => n.id)).toEqual(['a', 'c', 'd']);
    expect(d.diagnostics.length).toBeGreaterThanOrEqual(3);
  });
  it('handles japanese ids, ports and compact edges', () => {
    const d = parse('rect 入口 "入口" at (0,0) size 10x10\nrect b at (0,0) size 1x1\n入口.e->b.w');
    expect(d.edges[0]).toMatchObject({ from: '入口', to: 'b', fromPort: 'e', toPort: 'w' });
  });
});

describe('patcher', () => {
  it('moves nodes without touching comments', () => {
    const d = parse(SRC);
    const out = setNodesGeom(SRC, d, { db: { x: 10, y: 20 } });
    expect(out).toContain('trap   db   "Database"    at (10, 20) size 160x70 fill=#fef3c7  // comment kept');
    expect(out.split('\n').length).toBe(SRC.split('\n').length);
  });
  it('inserts missing geometry', () => {
    const s = 'rect a "A"\n';
    expect(setNodesGeom(s, parse(s), { a: { x: 1, y: 2, w: 30, h: 40 } })).toBe('rect a "A" at (1, 2) size 30x40\n');
  });
  it('sets / removes attrs and labels', () => {
    let s = SRC;
    s = setNodesAttr(s, parse(s), ['api'], 'fill', '#ff0000');
    expect(parse(s).nodeMap.get('api')!.attrs.fill).toBe('#ff0000');
    s = setNodesAttr(s, parse(s), ['db'], 'fill', undefined);
    expect(parse(s).nodeMap.get('db')!.attrs.fill).toBeUndefined();
    s = setNodeLabel(s, parse(s), 'api', 'He said "hi"\nok');
    expect(parse(s).nodeMap.get('api')!.label).toBe('He said "hi"\nok');
    s = setEdgeLabel(s, parse(s), 'api->db#0', 'reads');
    expect(parse(s).edges[1].label).toBe('reads');
    expect(parse(s).diagnostics).toEqual([]);
  });
  it('adds, renames and removes', () => {
    let s = SRC;
    s = addNodes(s, parse(s), [{ kind: 'rect', id: 'cache', label: 'Cache', x: 400, y: 80, w: 120, h: 60 }]);
    s = addEdge(s, parse(s), 'api', 'cache');
    s = renameNode(s, parse(s), 'api', 'gateway');
    let d = parse(s);
    expect(d.diagnostics).toEqual([]);
    expect(d.edges.map((e) => e.key)).toContain('gateway->cache#0');
    s = removeItems(s, d, ['gateway']);
    d = parse(s);
    expect(d.nodes.map((n) => n.id)).toEqual(['db', 'user', 'cache']);
    expect(d.edges).toEqual([]);
  });
  it('pastes with fresh ids', () => {
    const d = parse(SRC);
    const r = pasteText(SRC, d, 'rect api "X" at (0,0) size 10x10\nrect q at (0,0) size 5x5\napi -> q', 20, 20);
    const nd = parse(r.src);
    expect(r.ids).toEqual(['api2', 'q']);
    expect(nd.nodeMap.get('api2')!.x).toBe(20);
    expect(nd.edges.some((e) => e.from === 'api2' && e.to === 'q')).toBe(true);
  });
});

describe('text fit', () => {
  it('finds the largest size that fits', () => {
    const r = fitText('Hello world', { w: 200, h: 40 }, { min: 8, max: 18, weight: 500, measure: approxMeasureFn });
    expect(r.overflow).toBe(false);
    expect(r.size).toBe(18);
    const small = fitText('A very long label that needs wrapping', { w: 80, h: 40 }, { min: 8, max: 18, weight: 500, measure: approxMeasureFn });
    expect(small.size).toBeLessThan(18);
    expect(small.lines.length).toBeGreaterThan(1);
  });
  it('reports overflow', () => {
    const r = fitText('Supercalifragilistic', { w: 20, h: 10 }, { min: 9, max: 18, weight: 500, measure: approxMeasureFn });
    expect(r.overflow).toBe(true);
  });
  it('wraps CJK per character', () => {
    const r = fitText('日本語のテキストを折り返す', { w: 60, h: 200 }, { fixed: 14, min: 9, max: 18, weight: 500, measure: approxMeasureFn });
    expect(r.lines.length).toBeGreaterThan(1);
    expect(r.overflow).toBe(false);
  });
});

describe('checker + resolver', () => {
  const OVER = `rect a "A" at (0, 0) size 100x60
rect b "B" at (50, 20) size 100x60
ellipse c "C" at (300, 0) size 100x60
ellipse d "D" at (395, 55) size 100x60
rect e "Long long long label" at (0, 200) size 30x20 font=14
rect f "F" at (600, 0) size 50x50
rect g "G" at (600, 200) size 50x50
rect blk "" at (590, 100) size 70x40
f -> g
`;
  it('detects overlaps with exact geometry', () => {
    const d = parse(OVER);
    const issues = checkLayout(d, computeLayout(d, approxMeasureFn));
    const codes = issues.map((i) => i.id);
    expect(codes).toContain('overlap:a:b');
    // ellipse bboxes intersect at the corner but outlines don't
    expect(codes).not.toContain('overlap:c:d');
    expect(codes).toContain('text:e');
    expect(codes).toContain('through:f->g#0');
  });
  it('auto-fix resolves all errors', () => {
    const fixed = autoFix(OVER, approxMeasureFn);
    const d = parse(fixed);
    const errs = checkLayout(d, computeLayout(d, approxMeasureFn)).filter((i) => i.severity === 'error');
    expect(errs).toEqual([]);
  });
  it('containment is enforced and fixed', () => {
    const s = 'rect p "Group" at (0,0) size 100x100\nrect k "K" at (80, 80) size 50x50 in=p\nrect m "M" at (200,0) size 50x50\n';
    const d = parse(s);
    expect(checkLayout(d, computeLayout(d, approxMeasureFn)).map((i) => i.code)).toContain('containment');
    const f = parse(autoFix(s, approxMeasureFn));
    expect(checkLayout(f, computeLayout(f, approxMeasureFn)).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('arrange', () => {
  const S = 'rect a at (0, 0) size 100x50\nrect b at (130, 20) size 60x40\nrect c at (400, 10) size 80x30\n';
  it('aligns', () => {
    const d = parse(align(S, parse(S), ['a', 'b', 'c'], 'top'));
    expect(d.nodes.map((n) => n.y)).toEqual([0, 0, 0]);
  });
  it('distributes', () => {
    const d = parse(distribute(S, parse(S), ['a', 'b', 'c'], 'h'));
    const [a, b, c] = d.nodes;
    expect(b.x - (a.x + a.w)).toBeCloseTo(c.x - (b.x + b.w), 0);
  });
  it('matches sizes', () => {
    const d = parse(matchSize(S, parse(S), ['a', 'b', 'c'], 'width'));
    expect(d.nodes.map((n) => n.w)).toEqual([100, 100, 100]);
  });
});

import { SAMPLE } from './sample';
describe('sample', () => {
  it('is clean', () => {
    const d = parse(SAMPLE);
    expect(d.diagnostics).toEqual([]);
    expect(checkLayout(d, computeLayout(d, approxMeasureFn)).map((i) => i.message)).toEqual([]);
  });
  it('detects covered container text', () => {
    const s = 'rect g "Group" at (0,0) size 200x200 valign=top\nrect k "K" at (80, 5) size 50x50 in=g\n';
    const d = parse(s);
    expect(checkLayout(d, computeLayout(d, approxMeasureFn)).map((i) => i.code)).toContain('text-covered');
    const f = parse(autoFix(s, approxMeasureFn));
    expect(checkLayout(f, computeLayout(f, approxMeasureFn))).toEqual([]);
  });
});

import { setSetting } from './dsl/patch';
describe('settings', () => {
  it('rewrites the set line', () => {
    let s = '# hi\nrect a at (0,0) size 10x10\n';
    s = setSetting(s, parse(s), 'gap', 8);
    expect(s).toBe('# hi\nset gap=8\nrect a at (0,0) size 10x10\n');
    s = setSetting(s, parse(s), 'grid', 5);
    expect(parse(s).settings).toMatchObject({ gap: 8, grid: 5 });
  });
});

describe('label fixes', () => {
  it('opens the gap for a squeezed edge label', () => {
    const s = 'rect a "A" at (0,0) size 100x50\nrect b "B" at (120,0) size 100x50\na -> b "a long label"\n';
    const d = parse(s);
    expect(checkLayout(d, computeLayout(d, approxMeasureFn)).map((i) => i.code)).toContain('label-overlap');
    const f = parse(autoFix(s, approxMeasureFn));
    expect(checkLayout(f, computeLayout(f, approxMeasureFn))).toEqual([]);
  });
});

describe('node shape options', () => {
  it('orients a trapezoid with dir= and keeps text inside', () => {
    const d = parse('trap e "Enc" at (0, 0) size 100x80 dir=right\n');
    const n = computeLayout(d, approxMeasureFn).nodeMap.get('e')!;
    // right side is the short one
    const xs = n.poly.filter((p) => p.x === 100).map((p) => p.y).sort((a, b) => a - b);
    expect(xs).toEqual([16, 64]);
    expect(n.textBox.y).toBeGreaterThanOrEqual(16);
    expect(n.textBox.x + n.textBox.w).toBeLessThanOrEqual(100);
  });
  it('lets pad= override the global padding', () => {
    const d = parse('set padding=4\nround g "Title" at (0, 0) size 200x100 valign=top pad=20\n');
    expect(computeLayout(d, approxMeasureFn).nodeMap.get('g')!.textBox.y).toBe(20);
  });
});

describe('junction shapes', () => {
  it('parses otimes/oplus aliases and draws the inner strokes', () => {
    const d = parse('otimes s at (0, 0) size 40x40\noplus p at (60, 0) size 40x40\n');
    expect(d.nodes.map((n) => n.kind)).toEqual(['cross', 'plus']);
    const l = computeLayout(d, approxMeasureFn);
    // ring + two strokes
    expect(l.nodeMap.get('s')!.path.match(/M/g)!.length).toBe(3);
    expect(l.nodeMap.get('p')!.path).toContain('M60 20L100 20');
  });
});

describe('group titles', () => {
  const src = (h: string) => `round g "Title" at (0, 0) size 400x200 valign=top ${h}\nrect a "A" at (40, 120) size 60x40 in=g\nrect b "B" at (180, -120) size 40x40\nb -> a route=ortho\n`;
  it('flags an arrow crossing a group title and halign=left moves it aside', () => {
    const issues = (s: string) => checkLayout(parse(s), computeLayout(parse(s), approxMeasureFn)).filter((i) => i.code === 'edge-through');
    expect(issues(src('')).length).toBe(1);
    const l = computeLayout(parse(src('halign=left')), approxMeasureFn).nodeMap.get('g')!;
    expect(l.textRect.x).toBe(l.textBox.x);
  });
});

describe('port offsets', () => {
  it('slides a port along its side with toat=', () => {
    const d = parse('rect a "A" at (0, 0) size 40x40\nround g "G" at (0, 100) size 400x100\na.s -> g.n route=ortho toat=0.25\n');
    const pts = computeLayout(d, approxMeasureFn).edges[0].pts;
    expect(pts[pts.length - 1].x).toBeCloseTo(100, 0);
  });
});

describe('text rotation', () => {
  it('fits a sideways label into the box turned on its side', () => {
    const src = `rect a "Throughput" at (0, 0) size 30x160\nrect b "Throughput" at (100, 0) size 30x160 rotate=-90\n`;
    const d = parse(src);
    expect(d.diagnostics).toEqual([]);
    const l = computeLayout(d, approxMeasureFn);
    const a = l.nodeMap.get('a')!,
      b = l.nodeMap.get('b')!;
    expect(a.text.overflow).toBe(true);
    expect(b.style.rotate).toBe(270);
    expect(b.text.overflow).toBe(false);
    expect(b.text.lines).toEqual(['Throughput']);
    // on-screen rect is tall and thin, inside the shape
    expect(b.textRect.h).toBeGreaterThan(b.textRect.w);
    expect(b.textRect.y).toBeGreaterThanOrEqual(0);
    expect(b.textRect.y + b.textRect.h).toBeLessThanOrEqual(160);
  });
  it('keeps halign/valign about the box on screen', () => {
    const d = parse(`rect a "Hi" at (0, 0) size 60x200 rotate=90 valign=top halign=left\n`);
    const n = computeLayout(d, approxMeasureFn).nodeMap.get('a')!;
    expect(n.textRect.y).toBeCloseTo(n.textBox.y);
    expect(n.textRect.x).toBeCloseTo(n.textBox.x);
  });
});

describe('point arrow ends', () => {
  const SRC2 = `rect a "A" at (0, 0) size 100x50
rect b "B" at (300, 0) size 100x50

a -> (200, 200) "out"
(0, 300) -> b.s
a.e -> +(60, 0)
(10, 400) -> (90, 400)
`;
  it('parses (x, y) and +(dx, dy) ends', () => {
    const d = parse(SRC2);
    expect(d.diagnostics).toEqual([]);
    expect(d.edges.map((e) => e.key)).toEqual(['a->*#0', '*->b#0', 'a->*#1', '*->*#0']);
    expect(d.edges[0].toPt).toEqual({ x: 200, y: 200, rel: false });
    expect(d.edges[2].toPt).toEqual({ x: 60, y: 0, rel: true });
    expect(d.edges[1].toPort).toBe('s');
  });
  it('rejects two relative ends', () => {
    expect(parse(`+(1, 2) -> +(3, 4)\n`).diagnostics.length).toBeGreaterThan(0);
  });
  it('lays arrows out to the points', () => {
    const l = computeLayout(parse(SRC2), approxMeasureFn);
    const [e0, e1, e2, e3] = l.edges;
    expect(e0.pts[e0.pts.length - 1]).toEqual({ x: 200, y: 200 });
    expect(e1.pts[0]).toEqual({ x: 0, y: 300 });
    expect(e1.pts[1]).toEqual({ x: 350, y: 50 });
    // relative to the e port of a (100, 25)
    expect(e2.pts[e2.pts.length - 1]).toEqual({ x: 160, y: 25 });
    expect(e2.free.to?.base).toEqual({ x: 100, y: 25 });
    expect(e3.pts).toEqual([{ x: 10, y: 400 }, { x: 90, y: 400 }]);
    expect(checkLayout(parse(SRC2), l)).toEqual([]);
  });
  it('routes ortho to a point', () => {
    const d = parse(`rect a "A" at (0, 0) size 100x50\na -> (300, 200) route=ortho\n`);
    const e = computeLayout(d, approxMeasureFn).edges[0];
    expect(e.pts[e.pts.length - 1]).toEqual({ x: 300, y: 200 });
    for (let i = 1; i < e.pts.length; i++) expect(e.pts[i].x === e.pts[i - 1].x || e.pts[i].y === e.pts[i - 1].y).toBe(true);
  });
  it('re-points ends and keeps labels', () => {
    const d = parse(SRC2);
    let out = setEdgeEnds(SRC2, d, [{ key: 'a->*#0', which: 'to', end: '(250, 220)' }]);
    expect(out).toContain('a -> (250, 220) "out"');
    out = setEdgeEnds(out, parse(out), [{ key: '*->b#0', which: 'to', end: 'a.n' }]);
    expect(out).toContain('(0, 300) -> a.n');
    out = setEdgeLabel(out, parse(out), '*->*#0', 'free');
    expect(out).toContain('(10, 400) -> (90, 400) "free"');
  });
  it('removing a shape removes its arrows; renaming leaves points alone', () => {
    const d = parse(SRC2);
    expect(parse(removeItems(SRC2, d, ['a'])).edges.map((e) => e.key)).toEqual(['*->b#0', '*->*#0']);
    expect(renameNode(SRC2, d, 'a', 'z')).toContain('z -> (200, 200)');
  });
  it('pastes free ends with the offset, relative ends unchanged', () => {
    const d = parse(SRC2);
    const text = extractText(SRC2, d, ['a']);
    expect(text).toContain('a -> (200, 200)');
    const r = pasteText(SRC2, d, text, 10, 10);
    expect(r.src).toContain('a2 -> (210, 210)');
    expect(r.src).toContain('a2.e -> +(60, 0)');
  });
});

describe('ignore=', () => {
  const OV = `rect a "A" at (0, 0) size 100x50\nrect b "B" at (50, 20) size 100x50\nrect c "C" at (0, 200) size 100x50\nrect d "D" at (300, 200) size 100x50\nrect m "M" at (180, 200) size 60x50\nc -> d\n`;
  const issues = (src: string) => checkLayout(parse(src), computeLayout(parse(src), approxMeasureFn)).map((i) => i.code).sort();
  it('silences by kind on any involved item', () => {
    expect(issues(OV)).toEqual(['edge-through', 'overlap']);
    expect(issues(OV.replace('size 60x50', 'size 60x50 ignore=through'))).toEqual(['overlap']);
    expect(issues(OV.replace('c -> d', 'c -> d ignore=through'))).toEqual(['overlap']);
    expect(issues(OV.replace('"B" at (50, 20) size 100x50', '"B" at (50, 20) size 100x50 ignore=gap,overlap'))).toEqual(['edge-through']);
    expect(issues(OV.replace('"A" at (0, 0) size 100x50', '"A" at (0, 0) size 100x50 ignore=all'))).toEqual(['edge-through']);
  });
  it('parses lists and works through styles', () => {
    const d = parse(`rect a "A" at (0, 0) size 10x10 ignore=overlap,through\n`);
    expect(d.nodes[0].attrs.ignore).toBe('overlap,through');
    expect(d.diagnostics).toEqual([]);
    expect(issues(`style loose { ignore: overlap; }\n` + OV.replace('size 100x50\nrect c', 'size 100x50 .loose\nrect c'))).toEqual(['edge-through']);
  });
  it('writes lists bare', () => {
    const d = parse(OV);
    expect(setNodesAttr(OV, d, ['a'], 'ignore', 'overlap,gap')).toContain('ignore=overlap,gap');
  });
});

import { quote } from './dsl/patch';
import { splitMath } from './text/math';
import { exportTikz } from './exportFormats';
describe('tex labels', () => {
  it('keeps TeX backslashes inside $...$ and round-trips through quote', () => {
    const src = String.raw`rect a "勾配 \$5\n$\nabla f \le \frac{1}{2}$" at (0, 0) size 200x80`;
    const label = parse(src).nodes[0].label;
    expect(label).toBe('勾配 \\$5\n$\\nabla f \\le \\frac{1}{2}$');
    expect(parse(`rect a ${quote(label)} at (0, 0) size 10x10`).nodes[0].label).toBe(label);
    expect(splitMath(label)).toEqual([
      { math: false, s: '勾配 $5\n' },
      { math: true, s: '\\nabla f \\le \\frac{1}{2}' },
    ]);
  });
  it('lays formulas out as unbreakable runs and exports them to TikZ verbatim', () => {
    const doc = parse(String.raw`rect a "x $a^2 + b^2 = c^2$ y" at (0, 0) size 300x60` + '\n' + String.raw`rect b "$\foo$" at (0, 100) size 100x40`);
    const layout = computeLayout(doc, approxMeasureFn);
    const a = layout.nodeMap.get('a')!;
    expect(a.text.lines.length).toBe(1);
    expect(a.rich?.[0]?.runs.map((r) => r.math)).toEqual([false, true, false]);
    expect(exportTikz(layout)).toContain('{x $a^2 + b^2 = c^2$ y}');
    expect(checkLayout(doc, layout).map((i) => i.code)).toEqual(['tex']);
  });
});
