import { describe, expect, it } from 'vitest';
import { analyze, applyOps, issuesOut, measureNodes, summarize } from './core';
import { fontMeasure } from './measure';
import { parse } from '../src/dsl/parse';

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
