import { describe, expect, it } from 'vitest';
import { parse, views } from './dsl/parse';
import { addEdge, addNodes, removeItems, setNodeLabel, setNodesAttr, setNodesGeom } from './dsl/patch';

const DECK = `set canvas=1280x720 gap=12
style title { font: 40; weight: bold; }

layout base {
  text  footer "CSCL 2026"      at (40, 680) size 600x24
  text  pageno "{page} / {pages}" at (1100, 680) size 140x24
  slot  title "タイトル"         at (40, 30) size 1200x70 .title
}

layout two extends base {
  slot left  at (40, 120) size 580x540
  slot right rect at (660, 120) size 580x540
}

page intro "はじめに" layout=base {
  title "研究背景"
  rect a "既存手法" at (100, 200) size 200x80
}

page method layout=two {
  title "提案手法" at (40, 60)
  left "左"
  hide footer
}

page empty layout=base {
}
`;

describe('deck', () => {
  it('lists pages and layouts', () => {
    const d = parse(DECK);
    expect(d.deck!.pages.map((p) => [p.id, p.label, p.layout])).toEqual([
      ['intro', 'はじめに', 'base'],
      ['method', '', 'two'],
      ['empty', '', 'base'],
    ]);
    expect(d.deck!.layouts.map((l) => [l.name, l.extends, l.slots])).toEqual([
      ['base', undefined, ['title']],
      ['two', 'base', ['left', 'right']],
    ]);
    expect(d.canvas).toEqual({ w: 1280, h: 720 });
    expect(d.diagnostics).toEqual([]);
    expect(views(DECK)).toEqual([{ page: 'intro' }, { page: 'method' }, { page: 'empty' }, { layout: 'base' }, { layout: 'two' }]);
  });

  it('builds a page from its layout, slots and own shapes', () => {
    const d = parse(DECK, { page: 'intro' });
    expect(d.nodes.map((n) => [n.id, !!n.locked])).toEqual([
      ['footer', true],
      ['pageno', true],
      ['title', false],
      ['a', false],
    ]);
    expect(d.nodeMap.get('pageno')!.label).toBe('1 / 3');
    expect(d.nodeMap.get('title')).toMatchObject({ kind: 'text', label: '研究背景', x: 40, y: 30, w: 1200, h: 70, classes: ['title'], slot: 'title' });
    expect(d.deck!.placeholders).toEqual([]);
  });

  it('inherits layouts, overrides slot geometry and hides layout shapes', () => {
    const d = parse(DECK, { page: 'method' });
    expect(d.nodes.map((n) => n.id)).toEqual(['pageno', 'title', 'left']);
    expect(d.nodeMap.get('title')).toMatchObject({ x: 40, y: 60, w: 1200 });
    expect(d.nodeMap.get('pageno')!.label).toBe('2 / 3');
    expect(d.deck!.placeholders.map((p) => [p.id, p.kind])).toEqual([['right', 'rect']]);
  });

  it('reports unknown slots and layouts', () => {
    const src = DECK.replace('left "左"', 'nope "x"').replace('layout=base {\n}', 'layout=zzz {\n}');
    expect(parse(src, { page: 'method' }).diagnostics.map((d) => d.code)).toContain('unknown-ref');
    expect(parse(src).diagnostics.some((d) => d.message.includes('zzz'))).toBe(true);
  });

  it('edits only the current page', () => {
    const d = parse(DECK, { page: 'intro' });
    // layout shapes are read-only from a page
    expect(setNodesGeom(DECK, d, { footer: { x: 0 } })).toBe(DECK);
    expect(setNodeLabel(DECK, d, 'pageno', 'x')).toBe(DECK);
    expect(removeItems(DECK, d, ['footer'])).toBe(DECK);
    // moving a slot writes the override into the page's fill statement
    const moved = setNodesGeom(DECK, d, { title: { x: 50, y: 30 } });
    expect(moved).toContain('  title "研究背景" at (50, 30)\n');
    expect(parse(moved, { page: 'intro' }).nodeMap.get('title')!.x).toBe(50);
    // attrs on a fill go to the fill
    expect(setNodesAttr(DECK, d, ['title'], 'fill', '#fff')).toContain('title "研究背景" fill=#fff');
  });

  it('inserts into the page block with its indentation', () => {
    const d = parse(DECK, { page: 'empty' });
    const out = addNodes(DECK, d, [{ kind: 'rect', id: 'b', x: 0, y: 0, w: 10, h: 10 }]);
    expect(out).toContain('page empty layout=base {\n  rect b at (0, 0) size 10x10\n}');
    const d2 = parse(out, { page: 'empty' });
    expect(d2.nodes.map((n) => n.id)).toContain('b');
    const out2 = addEdge(out, d2, 'b', 'title');
    expect(out2).toContain('  rect b at (0, 0) size 10x10\n\n  b -> title\n}');
    const intro = parse(DECK, { page: 'intro' });
    expect(addNodes(DECK, intro, [{ kind: 'rect', id: 'c', x: 0, y: 0, w: 10, h: 10 }])).toContain('  rect a "既存手法" at (100, 200) size 200x80\n  rect c at (0, 0) size 10x10\n}');
  });

  it('shows a layout with its parent locked', () => {
    const d = parse(DECK, { layout: 'two' });
    expect(d.nodes.map((n) => [n.id, !!n.locked])).toEqual([
      ['footer', true],
      ['pageno', true],
      ['title', true],
      ['left', false],
      ['right', false],
    ]);
    const out = setNodesGeom(DECK, d, { right: { x: 700 } });
    expect(out).toContain('slot right rect at (700, 120) size 580x540');
    const labeled = setNodeLabel(DECK, d, 'left', '本文');
    expect(labeled).toContain('slot left "本文"  at (40, 120)');
    expect(parse(labeled, { layout: 'two' }).nodeMap.get('left')!.label).toBe('本文');
  });

  it('keeps plain diagrams unchanged and warns about shapes outside pages', () => {
    expect(parse('rect a at (0, 0) size 10x10').deck).toBeUndefined();
    const d = parse('rect a at (0, 0) size 10x10\npage p {\n  rect b at (0, 0) size 10x10\n}\n');
    expect(d.nodes.map((n) => n.id)).toEqual(['b']);
    expect(d.diagnostics.map((x) => x.code)).toEqual(['outside-page']);
  });

  it('reports unclosed blocks', () => {
    const d = parse('page p {\n  rect b at (0, 0) size 10x10\n');
    expect(d.nodes.map((n) => n.id)).toEqual(['b']);
    expect(d.diagnostics.some((x) => x.message.includes('閉じられていません'))).toBe(true);
  });
});

import { addLayout, addPage, duplicatePage, movePage, removePage, setPageHeader } from './dsl/patch';
import { computeLayout } from './layout';
import { checkLayout } from './check/check';
import { approxMeasureFn } from './text/fit';

describe('deck operations', () => {
  const ids = (s: string) => parse(s).deck!.pages.map((p) => p.id);
  it('adds, duplicates, moves and removes pages', () => {
    const d = parse(DECK);
    let s = addPage(DECK, d, { id: 'p9', label: '新規', layout: 'two', after: 'intro' });
    expect(ids(s)).toEqual(['intro', 'p9', 'method', 'empty']);
    expect(s).toContain('page p9 "新規" layout=two {\n}');
    s = duplicatePage(s, parse(s), 'intro', 'intro2');
    expect(ids(s)).toEqual(['intro', 'intro2', 'p9', 'method', 'empty']);
    expect(parse(s, { page: 'intro2' }).nodeMap.get('a')!.label).toBe('既存手法');
    s = movePage(s, parse(s), 'empty', 0);
    expect(ids(s)).toEqual(['empty', 'intro', 'intro2', 'p9', 'method']);
    s = movePage(s, parse(s), 'empty', 4);
    expect(ids(s)).toEqual(['intro', 'intro2', 'p9', 'method', 'empty']);
    s = removePage(s, parse(s), 'p9');
    expect(ids(s)).toEqual(['intro', 'intro2', 'method', 'empty']);
    expect(parse(s).diagnostics).toEqual([]);
  });
  it('rewrites page headers', () => {
    const s = setPageHeader(DECK, parse(DECK), 'intro', { label: '序論', layout: 'two' });
    expect(s).toContain('page intro "序論" layout=two {');
  });
  it('turns a plain diagram into a deck', () => {
    const plain = 'set gap=12\n\nrect a at (0, 0) size 10x10\nrect b at (40, 0) size 10x10\na -> b\n';
    const s = addPage(plain, parse(plain), { id: 'p2' });
    expect(s).toBe('set gap=12\n\npage p1 {\n  rect a at (0, 0) size 10x10\n  rect b at (40, 0) size 10x10\n  a -> b\n}\n\npage p2 {\n}\n');
    expect(parse(s, { page: 'p1' }).edges.length).toBe(1);
  });
  it('adds layouts before the pages', () => {
    const s = addLayout(DECK, parse(DECK), 'wide', 'base');
    expect(parse(s).deck!.layouts.map((l) => l.name)).toEqual(['base', 'two', 'wide']);
  });
});

describe('deck checks', () => {
  it('flags shapes off the page and leaves layout problems to the layout', () => {
    const src = DECK.replace('rect a "既存手法" at (100, 200)', 'rect a "既存手法" at (1200, 200)').replace('at (1100, 680) size 140x24', 'at (1100, 680) size 140x2');
    const page = parse(src, { page: 'intro' });
    const codes = checkLayout(page, computeLayout(page, approxMeasureFn)).map((i) => i.id);
    expect(codes).toContain('page:a');
    expect(codes).not.toContain('text:pageno');
    const lay = parse(src, { layout: 'base' });
    expect(checkLayout(lay, computeLayout(lay, approxMeasureFn)).map((i) => i.id)).toContain('text:pageno');
  });
});
