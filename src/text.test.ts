import { describe, expect, it } from 'vitest';
import { parse } from './dsl/parse';
import { setSetting } from './dsl/patch';
import { computeLayout, setEmbedResolver } from './layout';
import { approxMeasureFn, richLines, tokenizeText, wrap, type Measure } from './text/fit';
import { plainText, splitInline } from './text/inline';
import { layoutList, parseList, parseTable } from './text/blocks';
import { exportSvg, exportTikz, exportTikzDeck, imageSources } from './exportFormats';

describe('inline bold', () => {
  it('splits **bold** spans, leaves unpaired ** and formulas alone', () => {
    expect(splitInline('構造を**テキストで指定**して')).toEqual([
      { math: false, s: '構造を', bold: false },
      { math: false, s: 'テキストで指定', bold: true },
      { math: false, s: 'して', bold: false },
    ]);
    expect(splitInline('x**2')).toEqual([{ math: false, s: 'x**2', bold: false }]);
    expect(splitInline('**$a**b$ c**').map((g) => [g.math, g.s, g.bold])).toEqual([
      [true, 'a**b', true],
      [false, ' c', true],
    ]);
    expect(plainText('\\*\\* and \\$5 **b**')).toBe('** and $5 b');
  });
  it('keeps every wrapped line balanced', () => {
    const toks = tokenizeText('ab **cd ef** g');
    expect(toks).toEqual(['ab', ' ', '**cd**', ' ', '**ef**', ' ', 'g']);
    const r = wrap('組織レベルで**テキストで指定**して', 12, 60, 500, approxMeasureFn);
    for (const l of r.lines) expect((l.match(/\*\*/g)?.length ?? 0) % 2).toBe(0);
    expect(r.lines.map(plainText).join('')).toBe('組織レベルでテキストで指定して');
  });
  it('measures bold runs at the bold weight', () => {
    const seen: number[] = [];
    const m: Measure = (t, w) => (seen.push(w), t.length * 50);
    const rich = richLines(['a **b** c'], 10, 400, m)!;
    expect(rich[0]!.runs.map((r) => (r.math ? '' : `${r.s}:${r.bold}`))).toEqual(['a :false', 'b:true', ' c:false']);
    expect(seen).toContain(700);
  });
  it('draws partial bold in labels, lists and tables, and exports \\textbf', () => {
    const src = `rect a "x **y** z" at (0, 0) size 200x60
list l at (0, 100) size 400x100 {
  - 構造を**テキストで指定**する
}
a -> (300, 30) "**out**"
`;
    const l = computeLayout(parse(src), approxMeasureFn);
    expect(l.nodeMap.get('a')!.rich![0]!.runs.some((r) => !r.math && r.bold && r.s === 'y')).toBe(true);
    expect(l.nodeMap.get('l')!.blocks!.pieces.some((p) => p.rich?.[0]?.runs.some((r) => !r.math && r.bold))).toBe(true);
    const svg = exportSvg(l);
    expect(svg).toContain('font-weight="700"');
    expect(svg).not.toContain('**');
    const tex = exportTikz(l);
    expect(tex).toContain('x \\textbf{y} z');
    expect(tex).toContain('\\textbf{テキストで指定}');
    expect(tex).toContain('{\\textbf{out}}');
  });
});

describe('table: spans, row / cell styles, indent', () => {
  const body = `| 手法 | A | B |
|:--|--:|--:|
| **VOLTA 型** | bbox の長辺の 2 倍 {text=#6b7280 scale=0.85} || {fill=#f1f5f9}
| ViT-S | 1 | 2 | {indent=1}
| x {.hi} | 3 | 4 |`;
  it('parses || as a span and {...} as cell / row attributes', () => {
    const t = parseTable(body, {}, (n) => (n === 'hi' ? { fill: '#fef3c7', weight: 'bold' } : undefined));
    expect(t.align).toEqual(['l', 'r', 'r']);
    const sec = t.rows[1];
    expect(sec.fill).toBe('#f1f5f9');
    expect(sec.cells.map((c) => [c.text, c.span])).toEqual([
      ['**VOLTA 型**', 1],
      ['bbox の長辺の 2 倍', 2],
    ]);
    expect(sec.cells[1]).toMatchObject({ color: '#6b7280', scale: 0.85 });
    expect(t.rows[2].cells.map((c) => c.indent)).toEqual([1, undefined, undefined]);
    expect(t.rows[3].cells[0]).toMatchObject({ text: 'x', fill: '#fef3c7', weight: 700 });
    // `{x}` that is not an attribute block is text; TeX braces are left alone
    expect(parseTable('| a {x} | $b_{1}$ |', {}).rows[0].cells.map((c) => c.text)).toEqual(['a {x}', '$b_{1}$']);
  });
  it('lays out the span, fills the row and indents the cell', () => {
    const src = `style hi { fill: #fef3c7; weight: bold; }\ntable t at (0, 0) size 600x200 {\n${body
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n')}\n}\n`;
    const d = parse(src);
    expect(d.diagnostics).toEqual([]);
    const n = computeLayout(d, approxMeasureFn).nodeMap.get('t')!;
    const b = n.blocks!;
    expect(b.fills.find((f) => f.fill === '#f1f5f9')).toMatchObject({ x: 8, w: 584 });
    expect(b.fills.some((f) => f.fill === '#fef3c7')).toBe(true);
    const note = b.pieces.find((p) => p.lines[0]?.startsWith('bbox'))!;
    expect(note.color).toBe('#6b7280');
    expect(note.size).toBeCloseTo(b.size * 0.85);
    // spans columns 2-3: wider than one column
    expect(note.w).toBeGreaterThan(b.pieces.find((p) => p.lines[0] === '1')!.w * 1.5);
    const vit = b.pieces.find((p) => p.lines[0] === 'ViT-S')!;
    const x = b.pieces.find((p) => p.lines[0] === 'x')!;
    expect(vit.x - x.x).toBeCloseTo(b.size);
    const tex = exportTikz(computeLayout(d, approxMeasureFn));
    expect(tex).toMatch(/\\fill\[cp\d+\] \(6,-[\d.]+\) rectangle \(444,/);
  });
});

describe('list: bullets, placement, level sizes', () => {
  it('uses ● ○ ■ by level, drawn as shapes', () => {
    const items = parseList('- a\n  - b\n    - c\n      - d');
    expect(items.map((i) => i.marker)).toEqual(['●', '○', '■', '●']);
    const b = layoutList(items, { x: 0, y: 0, w: 300, h: 300 }, { min: 9, max: 18, weight: 500, measure: approxMeasureFn });
    expect(b.marks.map((m) => m.kind)).toEqual(['disc', 'circle', 'square', 'disc']);
    expect(b.pieces.some((p) => p.lines[0] === '●')).toBe(false);
    expect(exportSvg(computeLayout(parse('list l at (0, 0) size 300x100 {\n  - a\n    - b\n}\n'), approxMeasureFn))).toMatch(/<circle[^>]*fill="none"/);
  });
  it('honours valign / halign and levelscale', () => {
    const src = (a: string) => `list l at (0, 0) size 400x400 ${a} {\n  - a\n    - b\n      - c\n}\n`;
    const top = computeLayout(parse(src('')), approxMeasureFn).nodeMap.get('l')!;
    const mid = computeLayout(parse(src('valign=middle')), approxMeasureFn).nodeMap.get('l')!;
    const bottom = computeLayout(parse(src('valign=bottom halign=right')), approxMeasureFn).nodeMap.get('l')!;
    const h = top.blocks!.height;
    expect(mid.blocks!.pieces[0].y - top.blocks!.pieces[0].y).toBeCloseTo((top.textBox.h - h) / 2);
    expect(bottom.blocks!.y + h).toBeCloseTo(top.textBox.y + top.textBox.h);
    expect(bottom.blocks!.x + bottom.blocks!.width).toBeCloseTo(top.textBox.x + top.textBox.w);
    expect(mid.textRect.y).toBeCloseTo(mid.blocks!.y);
    const ls = computeLayout(parse(src('levelscale=1,1,0.8')), approxMeasureFn).nodeMap.get('l')!;
    const sizes = ls.blocks!.pieces.map((p) => p.size);
    expect(sizes[2]).toBeCloseTo(sizes[0] * 0.8);
    expect(sizes[1]).toBeCloseTo(sizes[0]);
  });
  it('takes line height, item gap, indent and marker gap in em', () => {
    const src = `list l at (0, 0) size 800x400 font=20 lineheight=1.8 itemgap=0 indent=2 markgap=1.3 {\n  - a\n  - b\n    - c\n}\n`;
    const b = computeLayout(parse(src), approxMeasureFn).nodeMap.get('l')!.blocks!;
    const [a, bb, c] = b.pieces;
    expect(bb.y - a.y).toBeCloseTo(36); // 1.8 × 20, no extra gap
    expect(c.x - bb.x).toBeCloseTo(40); // 2em per level
    expect(a.x - b.marks[0].cx).toBeCloseTo(20 * 1.3 - 20 * 0.3); // marker column 1.3em
    expect(a.lh).toBe(1.8);
    expect(b.marks[0].cy - a.y).toBeCloseTo(18); // centred on the taller line
    expect(b.height).toBeCloseTo(36 * 2 + 18 * 1.8);
    const t = (a: string) => computeLayout(parse(`table t at (0, 0) size 300x300 valign=top font=10 ${a} {\n  | a |\n  |---|\n  | 1 |\n}\n`), approxMeasureFn).nodeMap.get('t')!.blocks!.height;
    expect(t('lineheight=2') - t('')).toBeCloseTo(2 * 10 * (2 - 1.25));
  });
  it('places a table with valign= instead of stretching its rows', () => {
    const t = (a: string) => computeLayout(parse(`table t at (0, 0) size 300x300 ${a} {\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n}\n`), approxMeasureFn).nodeMap.get('t')!.blocks!;
    expect(t('').height).toBeCloseTo(300 - 16);
    const m = t('valign=middle');
    expect(m.height).toBeLessThan(100);
    expect(m.y).toBeGreaterThan(100);
  });
});

describe('font family', () => {
  const src = `set family="M PLUS 1p"
style head { family: M PLUS Rounded 1c; weight: bold; }
rect a "見出し" at (0, 0) size 200x60 .head
rect b "本文" at (300, 0) size 200x60
rect c "既定" at (600, 0) size 200x60 family=default
a -> b "ラベル"
`;
  it('resolves set → style → attribute and measures with it', () => {
    const d = parse(src);
    expect(d.diagnostics).toEqual([]);
    expect(d.styles.get('head')!.props.family).toBe('M PLUS Rounded 1c');
    const calls = new Set<string | undefined>();
    const m: Measure = (t, w, f) => (calls.add(f), approxMeasureFn(t, w));
    const l = computeLayout(d, m);
    expect(['a', 'b', 'c'].map((id) => l.nodeMap.get(id)!.style.family)).toEqual(['M PLUS Rounded 1c', 'M PLUS 1p', undefined]);
    expect(l.edges[0].style.family).toBe('M PLUS 1p');
    expect([...calls]).toEqual(expect.arrayContaining(['M PLUS Rounded 1c', 'M PLUS 1p', undefined]));
    const svg = exportSvg(l);
    expect(svg).toContain(`font-family="&#x27;M PLUS Rounded 1c&#x27;`);
    expect(svg).toContain('font-variant-ligatures:none');
  });
  it('writes set family= quoted and keeps it when another setting changes', () => {
    let s = 'set gap=12\nrect a "x" at (0, 0) size 100x50\n';
    s = setSetting(s, parse(s), 'family', 'M PLUS 1p');
    expect(s.split('\n')[0]).toBe('set gap=12 family="M PLUS 1p"');
    s = setSetting(s, parse(s), 'gap', 8);
    expect(s.split('\n')[0]).toBe('set gap=8 family="M PLUS 1p"');
    expect(parse(s).settings.family).toBe('M PLUS 1p');
  });
  it('keeps unrelated style values and semicolon-less styles intact', () => {
    const d = parse('style s {\n  fill: #fff\n  stroke: #000\n}\n');
    expect(d.styles.get('s')!.props).toEqual({ fill: '#fff', stroke: '#000' });
  });
  it('selects the family in TikZ through luatexja-fontspec', () => {
    const l = computeLayout(parse(src), approxMeasureFn);
    const tex = exportTikz(l);
    expect(tex).toContain('\\newfontfamily\\cpfMPLUSRoundedbcL{M PLUS Rounded 1c}');
    expect(tex).toContain('\\newjfontfamily\\cpfMPLUSbpJ{M PLUS 1p}');
    expect(tex).toContain('font=\\cpfMPLUSRoundedbc\\fontsize');
    const deck = exportTikzDeck([computeLayout(parse('set family="M PLUS 1p"\npage p {\n  rect a "x" at (0, 0) size 100x50\n}\n', { page: 'p' }), approxMeasureFn)]);
    expect(deck).toContain('\\usepackage{luatexja-fontspec}');
    expect(deck.indexOf('\\newfontfamily')).toBeLessThan(deck.indexOf('\\begin{document}'));
  });
});

describe('embedded diagrams: pictures', () => {
  it('rewrites a picture inside an embedded file to be relative to the embedding file', () => {
    const files: Record<string, string> = {
      'sub/inner.charpie': 'image p at (0, 0) size 100x100 src="assets/win.png"\nimage q at (200, 0) size 100x100 src="https://x/y.png"\n',
    };
    setEmbedResolver((s, base) => {
      const key = base ? base.split('/').slice(0, -1).concat(s).join('/') : s;
      return files[key] ? { text: files[key], base: key } : undefined;
    });
    try {
      const l = computeLayout(parse('image e at (0, 0) size 300x100 src="sub/inner.charpie"\n'), approxMeasureFn);
      expect(imageSources(l)).toEqual(['sub/assets/win.png', 'https://x/y.png']);
    } finally {
      setEmbedResolver(undefined);
    }
  });
});
