import { describe, expect, it } from 'vitest';
import { parseList, parseTable } from './text/blocks';
import {
  fromSegs,
  insertCol,
  insertRow,
  markupSegs,
  readList,
  readTable,
  removeCol,
  removeRow,
  renumber,
  segsMarkup,
  setCell,
  setColAlign,
  toSegs,
  writeList,
  writeTable,
} from './text/blockEdit';

describe('inline markup for editing', () => {
  it('round-trips bold, escapes and formulas', () => {
    for (const s of ['a **b** c', 'x**2', '\\*\\* $a**b$ **c**', '**全体**', '']) expect(fromSegs(toSegs(s))).toBe(s);
    expect(toSegs('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
    // bold never crosses a line
    expect(segsMarkup([{ text: 'a\nb', bold: true }])).toBe('**a**\n**b**');
    expect(segsMarkup(markupSegs('**a**\nb'))).toBe('**a**\nb');
  });
});

describe('list editing model', () => {
  const body = '- one\n  - nested\n    more\n# note\n1. first\n2. second';
  it('reads like parseList and writes untouched items back as written', () => {
    const l = readList(body);
    expect(l.items.map((i) => [i.level, i.marker, i.text])).toEqual(parseList(body).map((i, k) => [i.level, ['-', '-', '1.', '2.'][k], (i.bold ? `**${i.text}**` : i.text)]));
    expect(writeList(l)).toBe(body);
  });
  it('writes changed items and renumbers', () => {
    const l = readList(body);
    l.items[0].text = 'one **bold**';
    l.items[0].raw = undefined;
    l.items.splice(3, 0, { level: 0, marker: '2.', text: 'inserted', before: [] });
    renumber(l.items);
    expect(writeList(l)).toBe('- one **bold**\n  - nested\n    more\n# note\n1. first\n2. inserted\n3. second');
  });
  it('an empty item is a bare marker', () => {
    const l = readList('- a');
    l.items.push({ level: 1, marker: '-', text: '', before: [] });
    const out = writeList(l);
    expect(out).toBe('- a\n  -');
    expect(parseList(out).map((i) => [i.level, i.text])).toEqual([
      [0, 'a'],
      [1, ''],
    ]);
  });
});

describe('table editing model', () => {
  const body = '| Method | Acc |\n|--------|----:|\n| Ours {.hl} | 82.1 |\n| span || {fill=#eee}';
  it('keeps untouched rows as written', () => {
    const t = readTable(body);
    setCell(t, 1, 1, '83.0');
    const out = writeTable(t);
    expect(out.split('\n')[0]).toBe('| Method | Acc |');
    expect(out.split('\n')[2]).toBe('| Ours {.hl} | 83.0 |');
    expect(out.split('\n')[3]).toBe('| span || {fill=#eee}');
    expect(parseTable(out, {}).rows[1].cells.map((c) => c.text)).toEqual(['Ours', '83.0']);
  });
  it('adds and removes rows and columns (spans follow)', () => {
    const t = readTable(body);
    insertCol(t, 1);
    expect(writeTable(t).split('\n')).toEqual(['| Method |  | Acc |', '|--------|--------|----:|', '| Ours {.hl} |  | 82.1 |', '| span ||| {fill=#eee}']);
    removeCol(t, 0);
    insertRow(t, 1);
    removeRow(t, 0);
    const spec = parseTable(writeTable(t), {});
    expect(spec.rows.map((r) => r.cells.map((c) => [c.text, c.span]))).toEqual([
      [
        ['', 1],
        ['', 1],
      ],
      [
        ['', 1],
        ['82.1', 1],
      ],
      [['span', 2]],
    ]);
  });
  it('escapes pipes, sets alignment, and lines up a lined-up table again', () => {
    const t = readTable('| a   | b   |\n|-----|-----|\n| 1   | 2   |');
    expect(t.aligned).toBe(true);
    setCell(t, 1, 0, 'x|y 日本');
    setColAlign(t, 1, 'r');
    const out = writeTable(t);
    expect(out).toBe('| a         | b   |\n|-----------|----:|\n| x\\|y 日本 | 2   |');
    expect(parseTable(out, {}).align).toEqual(['l', 'r']);
    expect(parseTable(out, {}).rows[1].cells[0].text).toBe('x|y 日本');
  });
  it('alignment without a |---| line adds one under the first row', () => {
    const t = readTable('| a | b |\n| 1 | 2 |');
    setColAlign(t, 0, 'l');
    expect(writeTable(t)).toBe('| a | b |\n|:---|:---:|\n| 1 | 2 |');
    expect(parseTable(writeTable(t), {}).align).toEqual(['l', 'c']);
  });
});
