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

import { setNodeBody, extractText, pasteText } from './dsl/patch';
import { parseList, parseTable } from './text/blocks';
import { exportTikz } from './exportFormats';

const TABLE = `table res at (0, 0) size 400x120 align=l,r {
  | Method | Acc |
  |--------|----:|
  | ViT-S  | 79.8 |
  | **Ours** | **82.1** |
}
list pts at (0, 200) size 400x200 {
  - 一段目
    - 二段目
  1. 番号
  続き
}
rect after "後" at (500, 0) size 100x60
`;

describe('table / list', () => {
  it('parses bodies without breaking the following statements', () => {
    const d = parse(TABLE);
    expect(d.diagnostics).toEqual([]);
    expect(d.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['res', 'table'],
      ['pts', 'list'],
      ['after', 'rect'],
    ]);
    expect(d.nodeMap.get('res')!.body!.text.split('\n')[0]).toBe('| Method | Acc |');
    expect(d.nodeMap.get('res')!.attrs.align).toBe('l,r');
  });
  it('reads Markdown tables and nested lists', () => {
    const t = parseTable('| a | b |\n|:-:|--:|\n| 1 | 2 |\n| x \\| y | $a|b$ |', {});
    expect(t.rows.map((r) => r.cells.map((c) => c.text))).toEqual([['a', 'b'], ['1', '2'], ['x | y', '$a|b$']]);
    expect([t.header, t.align]).toEqual([1, ['c', 'r']]);
    expect(parseList('- a\n  - b\n1. c\nmore').map((i) => [i.level, i.marker, i.text])).toEqual([
      [0, '●', 'a'],
      [1, '○', 'b'],
      [0, '1.', 'c'],
      [0, null, 'more'],
    ]);
  });
  it('fits tables and lists and flags overflow', () => {
    const d = parse(TABLE);
    const l = computeLayout(d, approxMeasureFn);
    const res = l.nodeMap.get('res')!;
    expect(res.blocks!.pieces.length).toBe(6);
    expect(res.blocks!.rules.length).toBe(3); // top, under header, bottom
    expect(res.text.overflow).toBe(false);
    expect(res.blocks!.pieces.find((p) => p.lines[0] === 'Ours')!.weight).toBe(700);
    const tiny = parse(TABLE.replace('size 400x120', 'size 60x20'));
    expect(checkLayout(tiny, computeLayout(tiny, approxMeasureFn)).map((i) => i.id)).toContain('text:res');
    expect(exportTikz(l)).toContain('{Ours}');
  });
  it('rewrites a body in place and keeps it through copy / paste', () => {
    const d = parse(TABLE);
    const s = setNodeBody(TABLE, d, 'pts', '- 新しい\n  - 入れ子');
    expect(s).toContain('list pts at (0, 200) size 400x200 {\n  - 新しい\n    - 入れ子\n}\nrect after');
    const plain = 'list a at (0, 0) size 100x100\n';
    expect(setNodeBody(plain, parse(plain), 'a', '- x')).toBe('list a at (0, 0) size 100x100 {\n  - x\n}\n');
    const clip = extractText(TABLE, d, ['res']);
    expect(clip.startsWith('table res at (0, 0) size 400x120 align=l,r {\n  | Method | Acc |')).toBe(true);
    const r = pasteText(TABLE, d, clip, 10, 10);
    expect(parse(r.src).nodeMap.get(r.ids[0])!.body!.text).toBe(d.nodeMap.get('res')!.body!.text);
  });
  it('fills a list slot with a block on a page', () => {
    const src = `layout base {\n  slot body list at (40, 120) size 600x400\n}\npage p layout=base {\n  body {\n    - a\n    - b\n  }\n  rect x at (700, 120) size 100x60\n}\n`;
    const d = parse(src, { page: 'p' });
    expect(d.diagnostics).toEqual([]);
    expect(d.nodeMap.get('body')).toMatchObject({ kind: 'list', slot: 'body', x: 40 });
    expect(d.nodeMap.get('body')!.body!.text).toBe('- a\n- b');
    expect(d.nodes.map((n) => n.id)).toEqual(['body', 'x']);
  });
});

import { setEmbedResolver, withEmbedBase } from './layout';
import { exportSvg } from './exportFormats';

describe('embedded diagrams', () => {
  it('lays out image src=x.charpie inline, relative to the embedding file, with a page', () => {
    const files: Record<string, string> = {
      'd/inner.charpie': 'rect a "内側" at (0, 0) size 100x50\nrect b at (200, 0) size 100x50\na -> b',
      'd/deck.charpie': 'page one {\n  rect x "一枚目" at (0, 0) size 100x50\n}\npage two {\n  rect y "二枚目" at (0, 0) size 100x50\n}\n',
    };
    setEmbedResolver((src, base) => {
      const key = (base ? base.split('/').slice(0, -1).join('/') + '/' : '') + src;
      return files[key] !== undefined ? { text: files[key], base: key } : undefined;
    });
    try {
      const doc = parse('image fig at (0, 0) size 600x100 src="inner.charpie"\nimage pg at (0, 200) size 128x72 src="deck.charpie#two"');
      const l = withEmbedBase('d/top.charpie', () => computeLayout(doc, approxMeasureFn));
      const fig = l.nodeMap.get('fig')!.embed!;
      expect(fig.layout.nodes.map((n) => n.id)).toEqual(['a', 'b']);
      expect(fig.scale).toBeGreaterThan(1);
      expect(l.nodeMap.get('pg')!.embed!.layout.nodes.map((n) => n.id)).toEqual(['y']);
      expect(l.nodeMap.get('pg')!.embed!.scale).toBeCloseTo(0.1);
      const svg = exportSvg(l);
      expect(svg).toContain('内側');
      expect(svg).toContain('二枚目');
      // unresolved: no embed, and not treated as a picture to embed
      expect(computeLayout(parse('image z at (0, 0) size 10x10 src="nope.charpie"'), approxMeasureFn).nodeMap.get('z')!.embed).toBeUndefined();
    } finally {
      setEmbedResolver(undefined);
    }
  });
});

import { importLayouts, rebasePath } from './dsl/patch';
import { slideFromDeck, slideTemplate } from './templates';

describe('templates and layout import', () => {
  it('starts a clean deck', () => {
    const s = slideTemplate('研究発表');
    const d = parse(s);
    expect(d.diagnostics).toEqual([]);
    expect(d.deck!.pages.map((p) => p.id)).toEqual(['cover', 'p2']);
    for (const v of [{ page: 'cover' }, { page: 'p2' }, { layout: 'default' }, { layout: 'content' }]) {
      const pd = parse(s, v);
      expect(checkLayout(pd, computeLayout(pd, approxMeasureFn)).filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
  it('imports layouts with their parents and styles, renaming clashes and rebasing pictures', () => {
    const other = `set canvas=1280x720\nstyle band { fill: #4f46e5;\n  stroke: none; }\nstyle x { fill: #fff; }\nlayout default {\n  rect band at (0, 0) size 1280x12 .band\n  image logo at (1200, 20) size 40x40 src="assets/logo.png"\n}\nlayout two extends default {\n  slot left at (40, 120) size 580x540\n}\npage p {\n}\n`;
    const mine = `set canvas=1280x720\nstyle x { fill: #000; }\nlayout default {\n  text t "mine" at (0, 0) size 100x30\n}\npage a {\n}\n`;
    const r = importLayouts(mine, parse(mine), other, ['two'], (p) => rebasePath(p, 'decks/old.charpie', 'new.charpie'));
    expect(r.layouts).toEqual(['default2', 'two']);
    expect(r.renamed).toEqual({ default: 'default2' });
    expect(r.styles).toEqual(['band']);
    const d = parse(r.src);
    expect(d.diagnostics).toEqual([]);
    expect(d.deck!.layouts.map((l) => [l.name, l.extends])).toEqual([
      ['default', undefined],
      ['default2', undefined],
      ['two', 'default2'],
    ]);
    expect(d.styles.get('x')!.props.fill).toBe('#000'); // own style kept
    expect(d.styles.get('band')!.props.stroke).toBe('none');
    expect(r.src).toContain('src="decks/assets/logo.png"');
    expect(parse(r.src, { layout: 'two' }).nodes.map((n) => n.id)).toEqual(['band', 'logo', 'left']);
  });
  it('makes a new deck in the look of another one', () => {
    const s = slideFromDeck('新しい発表', slideTemplate('元'), 'a.charpie', 'b.charpie');
    const d = parse(s);
    expect(d.diagnostics).toEqual([]);
    expect(d.deck!.layouts.map((l) => l.name)).toEqual(['default', 'content']);
    expect(parse(s, { page: 'p1' }).nodeMap.get('title')!.label).toBe('新しい発表');
    expect(rebasePath('../x.png', 'a/b/c.charpie', 'a/d.charpie')).toBe('x.png');
    expect(rebasePath('img/x.png', 'c.charpie', 'sub/d.charpie')).toBe('../img/x.png');
  });
});

describe('layout import: same layouts', () => {
  it('reuses a layout that is already here as written instead of copying it again', () => {
    const base = slideTemplate('a');
    const r = importLayouts(base, parse(base), base, ['content']);
    expect(r.src).toBe(base);
    expect(r.layouts).toEqual(['default', 'content']);
    // a changed child is copied, its unchanged parent reused
    const other = base.replace('slot  body list at (40, 132)', 'slot  body list at (40, 140)');
    const r2 = importLayouts(base, parse(base), other, ['content']);
    expect(parse(r2.src).deck!.layouts.map((l) => [l.name, l.extends])).toEqual([
      ['default', undefined],
      ['content', 'default'],
      ['content2', 'default'],
    ]);
  });
});

describe('layout import: twice', () => {
  it('does not copy a layout again after it was imported under another name', () => {
    const other = slideTemplate('x').replace('size 1200x72 .title', 'size 1200x80 .title');
    const mine = slideTemplate('y');
    const once = importLayouts(mine, parse(mine), other, ['content']);
    expect(once.renamed).toEqual({ default: 'default2', content: 'content2' });
    const twice = importLayouts(once.src, parse(once.src), other, ['content']);
    expect(twice.src).toBe(once.src);
    expect(twice.layouts).toEqual(['default2', 'content2']);
  });
});
