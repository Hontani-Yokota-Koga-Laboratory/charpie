import { describe, expect, it } from 'vitest';
import { parse, views } from './dsl/parse';
import { computeLayout } from './layout';
import { checkLayout } from './check/check';
import { exportPptx, imageSize, parseColor, type RasterJob } from './pptx';
import { approxMeasureFn } from './text/fit';
import { crc32, unzip, zip } from './zip';

const dec = new TextDecoder();

/** Every page of a deck laid out, as the server does it. */
function pages(src: string) {
  const vs = views(src).filter((v) => v && 'page' in v);
  return (vs.length ? vs : [undefined]).map((v) => computeLayout(parse(src, v), approxMeasureFn));
}

async function pptx(src: string, raster: (jobs: RasterJob[]) => Promise<Uint8Array[]> = async (j) => j.map(() => new Uint8Array([137, 80, 78, 71]))) {
  const files = unzip(await exportPptx(pages(src), { image: () => undefined, raster }));
  const text = (name: string) => dec.decode(files.get(name) ?? new Uint8Array());
  return { files, text };
}

/** Tags open and close in order (no XML parser in the test environment). */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      if (stack.pop() !== name) return false;
    } else stack.push(name);
  }
  return stack.length === 0;
}

const DECK = `set canvas=1280x720 family=Calibri
page one "一" {
  rect  a "箱 one" at (100, 100) size 200x80
  trap  t "Encoder" at (400, 100) size 160x100 dir=right
  ellipse e "楕円" at (700, 100) size 160x100
  a -> t "uses"
  t -> e route=ortho
}
page two {
  table tb at (80, 100) size 600x200 {
    | 手法 | 精度 ||
    |------|-----:|---|
    | **提案** | **82.1** | x |
  }
  list ls at (80, 360) size 600x300 {
    - 項目
      - 入れ子
    1. 番号
  }
}
`;

describe('zip', () => {
  it('round-trips entries (stored)', () => {
    const buf = zip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.bin', data: new Uint8Array([1, 2, 3]) },
    ]);
    const files = unzip(buf);
    expect(dec.decode(files.get('a.txt'))).toBe('hello');
    expect([...files.get('dir/b.bin')!]).toEqual([1, 2, 3]);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('pptx export', () => {
  it('writes one slide per page at the page size, every part well-formed', async () => {
    const { files, text } = await pptx(DECK);
    expect(files.has('ppt/slides/slide1.xml')).toBe(true);
    expect(files.has('ppt/slides/slide2.xml')).toBe(true);
    expect(files.has('ppt/slides/slide3.xml')).toBe(false);
    // 1280×720 px is PowerPoint's 16:9 exactly
    expect(text('ppt/presentation.xml')).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(text('[Content_Types].xml')).toContain('/ppt/slides/slide2.xml');
    for (const [name, data] of files) if (/\.(xml|rels)$/.test(name)) expect(wellFormed(dec.decode(data)), name).toBe(true);
  });

  it('turns shapes into presets or exact outlines, with the label as text', async () => {
    const s = (await pptx(DECK)).text('ppt/slides/slide1.xml');
    expect(s).toContain('<a:off x="952500" y="952500"/><a:ext cx="1905000" cy="762000"/>');
    expect(s).toContain('<a:prstGeom prst="ellipse">');
    // a sideways trapezoid keeps its polygon (and its text area, as guides)
    expect(s).toMatch(/name="t"\/>.*?<a:custGeom>.*?<a:gd name="txl" fmla="\*\/ w /);
    // Calibri's Japanese goes to its Office partner
    expect(s).toContain('<a:latin typeface="Calibri"/><a:ea typeface="BIZ UDPGothic"/>');
    expect(s).toContain('<a:t>箱 one</a:t>');
    expect(s).toContain('wrap="none"');
  });

  it('glues straight arrows as connectors and draws routed ones as freeforms', async () => {
    const s = (await pptx(DECK)).text('ppt/slides/slide1.xml');
    expect(s).toMatch(/<p:cxnSp>.*?<a:stCxn id="\d+" idx="\d"\/>.*?straightConnector1.*?<a:tailEnd type="stealth"/);
    expect(s).toMatch(/name="t -&gt; e"\/>.*?<a:custGeom>.*?<a:path [^>]*fill="none"/);
    // the arrow label is a text box of its own
    expect(s).toContain('<a:t>uses</a:t>');
  });

  it('makes tables and lists PowerPoint objects', async () => {
    const s = (await pptx(DECK)).text('ppt/slides/slide2.xml');
    expect(s).toContain('<a:tbl>');
    expect((s.match(/<a:gridCol /g) ?? []).length).toBe(3);
    // `||` widens the cell: one spanning cell + one merged
    expect(s).toContain('gridSpan="2"');
    expect(s).toContain('hMerge="1"');
    expect(s).toMatch(/b="1"[^>]*>.*?<a:t>提案<\/a:t>/);
    // booktabs: a rule above the header
    expect(s).toMatch(/<a:lnT w="\d+"/);
    expect(s).toContain('<a:buChar char="•"/>');
    expect(s).toContain('<a:buChar char="○"/>');
    expect(s).toContain('<a:buAutoNum type="arabicPeriod" startAt="1"/>');
  });

  it('draws a label with a formula as a picture (SVG + PNG), over the native shape', async () => {
    let jobs: RasterJob[] = [];
    const { files, text } = await pptx('rect m "loss $\\frac{1}{n}$" at (0, 0) size 200x80', async (j) => {
      jobs = j;
      return j.map(() => new Uint8Array([137, 80, 78, 71]));
    });
    const s = text('ppt/slides/slide1.xml');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].svg).toContain('<svg');
    expect(s).toContain('<p:pic>');
    expect(s).toContain('asvg:svgBlip');
    expect(s).not.toContain('<a:t>loss');
    expect([...files.keys()].some((k) => k.endsWith('.svg'))).toBe(true);
    expect(text('[Content_Types].xml')).toContain('Extension="svg"');
  });

  it('a single diagram becomes one slide around its bounds', async () => {
    const { text } = await pptx('rect a "A" at (0, 0) size 100x50');
    expect(text('ppt/presentation.xml')).toMatch(/<p:sldSz cx="\d+" cy="\d+"\/>/);
    // 24 px margin around the shape, its stroke included
    expect(text('ppt/slides/slide1.xml')).toContain('<a:off x="242888" y="242888"/>');
  });
});

describe('pptx helpers', () => {
  it('reads colours as hex + alpha', () => {
    expect(parseColor('#abc')).toEqual({ hex: 'AABBCC', alpha: 1 });
    expect(parseColor('#11223380')?.alpha).toBeCloseTo(0.5, 2);
    expect(parseColor('rgb(255, 0, 10)')).toEqual({ hex: 'FF000A', alpha: 1 });
    expect(parseColor('white')).toEqual({ hex: 'FFFFFF', alpha: 1 });
    expect(parseColor('none')).toBeUndefined();
  });

  it('reads picture sizes from their headers', () => {
    const png = new Uint8Array(24);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(imageSize(png, 'image/png')).toEqual({ w: 640, h: 480 });
    expect(imageSize(new TextEncoder().encode('<svg viewBox="0 0 30 20">'), 'image/svg+xml')).toEqual({ w: 30, h: 20 });
  });
});

describe('set compat=pptx', () => {
  const issues = (src: string) => {
    const doc = parse(src);
    return checkLayout(doc, computeLayout(doc, approxMeasureFn)).filter((i) => i.id.startsWith('compat:'));
  };
  it('warns about fonts PowerPoint does not have, the default included', () => {
    expect(issues('set compat=pptx\nrect a "A" at (0, 0) size 100x50')).toHaveLength(1);
    expect(issues('set compat=pptx\nrect a "A" at (0, 0) size 100x50 family="Noto Sans JP"')[0].message).toContain('Noto Sans JP');
  });
  it('is quiet for Office fonts, and without compat', () => {
    expect(issues('set compat=pptx family=Calibri\nrect a "A" at (0, 0) size 100x50\nrect b "B" at (200, 0) size 100x50 family="BIZ UDPGothic"')).toHaveLength(0);
    expect(issues('rect a "A" at (0, 0) size 100x50')).toHaveLength(0);
  });
  it('rejects other values', () => {
    expect(parse('set compat=keynote').diagnostics.some((d) => d.message.includes('compat'))).toBe(true);
  });
});
