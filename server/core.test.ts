import { describe, expect, it } from 'vitest';
import { analyze, applyOps, issuesOut, measureNodes, summarize } from './core';
import { fontMeasure } from './measure';
import { parse } from '../src/dsl/parse';
import { exportSvg, exportTikz, imageSources } from '../src/exportFormats';

const SRC = 'rect a "A" at (0, 0) size 120x60\nrect b "B" at (200, 0) size 120x60\n';

describe('api ops', () => {
  it('adds near another node and connects', () => {
    const r = applyOps(SRC, [{ op: 'add', label: 'C', near: 'b', dir: 'below' }, { op: 'connect', from: 'b', to: 'box1', label: 'x' }], fontMeasure);
    const d = parse(r.src);
    expect(r.created).toEqual(['box1']);
    expect(d.nodeMap.get('box1')).toMatchObject({ x: 190, y: 100 });
    expect(d.edges[0]).toMatchObject({ from: 'b', to: 'box1', label: 'x' });
  });
  it('sets attrs, removes with null, and moves', () => {
    let { src } = applyOps(SRC, [{ op: 'set', id: 'a', attrs: { fill: '#ff0000' }, label: 'AA' }], fontMeasure);
    ({ src } = applyOps(src, [{ op: 'set', id: 'a', attrs: { fill: null } }, { op: 'move', id: 'a', dx: 5 }], fontMeasure));
    expect(src.split('\n')[0]).toBe('rect a "AA" at (5, 0) size 120x60');
  });
  it('rejects unknown ids helpfully', () => {
    expect(() => applyOps(SRC, [{ op: 'move', id: 'zz', dx: 1 }], fontMeasure)).toThrow(/zz.*a, b/);
  });
  it('fix resolves overlaps and reports line numbers', () => {
    const bad = 'rect a "A" at (0, 0) size 120x60\nrect b "B" at (50, 10) size 120x60\n';
    const a = analyze(bad, fontMeasure);
    expect(issuesOut(a, bad)[0]).toMatchObject({ code: 'overlap', line: 1 });
    const { src } = applyOps(bad, [{ op: 'fix' }], fontMeasure);
    expect(issuesOut(analyze(src, fontMeasure), src)).toEqual([]);
  });
  it('summarizes', () => {
    const s = summarize(SRC, analyze(SRC, fontMeasure));
    expect(s.nodes.map((n) => [n.id, n.line])).toEqual([['a', 1], ['b', 2]]);
    expect(s.bounds).toEqual({ x: 0, y: 0, w: 320, h: 60 });
  });
  it('measures text room, and fit is the smallest box that still holds the label', () => {
    const cases = ['rect', 'round', 'ellipse', 'diamond', 'para skew=0.15', 'hex skew=0.2', 'trap', 'trap dir=right', 'rect rotate=90'];
    for (const c of cases) {
      const [kind, ...extra] = c.split(' ');
      const src = (w: number, h: number) => `set padding=8\n${kind} a "Hello world\\n$\\theta_{k+1}$ 二行目" at (0, 0) size ${w}x${h} font=20 ${extra.join(' ')}\n`;
      const [m] = measureNodes(analyze(src(400, 300), fontMeasure), fontMeasure);
      expect(m, c).toMatchObject({ id: 'a', font: 20, auto: false, overflow: false, text: { lines: 2 } });
      expect(m.slack.w, c).toBeGreaterThan(0);
      const text = (w: number, h: number) => analyze(src(w, h), fontMeasure).layout.nodeMap.get('a')!.text;
      expect(text(m.fit.w, m.fit.h), c).toMatchObject({ overflow: false, lines: text(400, 300).lines });
      const narrower = text(m.fit.w - 1, m.fit.h);
      expect(narrower.overflow || narrower.lines.length > 2, c).toBe(true);
      const lower = text(m.fit.w, m.fit.h - 1);
      expect(lower.overflow || lower.lines.length > 2, c).toBe(true);
    }
  });
  it('font metrics are close to Inter', () => {
    // "Hello" in Inter Medium ≈ 2.7 em; guard against falling back to the rough estimate
    const w = fontMeasure('Hello', 500);
    expect(w).toBeGreaterThan(240);
    expect(w).toBeLessThan(300);
  });
});

describe('image export', () => {
  const src = 'image p at (0, 0) size 160x120 src="assets/x.png" fit=cover\nimage q at (200, 0) size 80x60 src="assets/missing.png"\n';
  it('embeds resolved pictures and draws a placeholder for the rest', () => {
    const a = analyze(src, fontMeasure);
    expect(imageSources(a.layout)).toEqual(['assets/x.png', 'assets/missing.png']);
    const svg = exportSvg(a.layout, '#ffffff', (s) => (s === 'assets/x.png' ? 'data:image/png;base64,AAAA' : undefined));
    expect(svg).toContain('<image href="data:image/png;base64,AAAA" x="0" y="0" width="160" height="120" preserveAspectRatio="xMidYMid slice"');
    expect(svg.match(/<image /g)!.length).toBe(1);
    expect(svg).toContain('stroke-dasharray="4 3"');
  });
  it('uses includegraphics in TikZ', () => {
    const tex = exportTikz(analyze(src, fontMeasure).layout);
    expect(tex).toContain('\\includegraphics[width=120pt, height=90pt, keepaspectratio]{assets/x.png}');
    expect(tex).toContain('graphicx');
  });
});

import { embedFonts, findFamily, listFamilies, matchWeight } from './fonts';
import { issuesAll as issuesOf } from './core';

describe('font families', () => {
  it('finds bundled Fontsource families and measures with their own glyphs', () => {
    const faces = findFamily('M PLUS Rounded 1c');
    expect(faces?.some((f) => f.weight === 700 && f.ranges)).toBe(true);
    expect(findFamily('m plus 1p')).toBeTruthy();
    expect(findFamily('No Such Font 9')).toBeUndefined();
    const inter = fontMeasure('Hello', 500);
    const rounded = fontMeasure('Hello', 500, 'M PLUS Rounded 1c');
    expect(rounded).toBeGreaterThan(0);
    expect(rounded).not.toBeCloseTo(inter, 1);
    // its own kana (not the 100-per-char fallback)
    expect(fontMeasure('あいう', 700, 'M PLUS Rounded 1c')).toBeGreaterThan(200);
  });
  it('Office fonts fall back to their metric-compatible fonts', () => {
    expect(findFamily('Calibri')?.[0].family).toBe('Carlito');
    expect(findFamily('times new roman')?.[0].family).toBe('Tinos');
    expect(fontMeasure('Proposed method', 400, 'Calibri')).toBeCloseTo(fontMeasure('Proposed method', 400, 'Carlito'), 3);
    expect(listFamilies()).toEqual(expect.arrayContaining(['Calibri', 'Times New Roman', 'Noto Sans JP', 'BIZ UDPGothic']));
  });
  it('measures text as written: no ligatures / contextual arrows', () => {
    expect(fontMeasure('->', 400)).toBeCloseTo(fontMeasure('-', 400) + fontMeasure('>', 400), 0);
  });
  it('picks weights like CSS', () => {
    expect(matchWeight(500, [400, 700])).toBe(400);
    expect(matchWeight(600, [400, 700])).toBe(700);
    expect(matchWeight(300, [400, 700])).toBe(400);
  });
  it('warns about a family it cannot find, and embeds the ones it can', () => {
    const issues = issuesOf('rect a "x" at (0, 0) size 100x50 family="No Such Font 9"\nrect b "y" at (200, 0) size 100x50 family="M PLUS 1p"\n', fontMeasure).issues;
    expect(issues.filter((i) => i.code === 'font').map((i) => i.message)).toEqual([expect.stringContaining('No Such Font 9')]);
    const svg = embedFonts(`<svg xmlns="http://www.w3.org/2000/svg"><text font-family="&#x27;M PLUS 1p&#x27;, Inter" font-weight="500">あ</text><text font-family="&#x27;Inter Variable&#x27;, x">b</text></svg>`);
    expect(svg).toMatch(/<style>@font-face\{font-family:'M PLUS 1p';[^}]*font-weight:500;[^}]*src:url\(data:font\/woff2;base64,/);
    expect(svg.match(/@font-face/g)!.length).toBeLessThan(4);
  });
});
