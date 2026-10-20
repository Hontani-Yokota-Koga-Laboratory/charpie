/**
 * Server-side text measurement with the same Inter metrics the browser uses,
 * so `charpie check` and the canvas agree on what fits.
 */
import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';
import type { Measure } from '../src/text/fit';

const require = createRequire(import.meta.url);
type Font = { unitsPerEm: number; layout(s: string): { advanceWidth: number }; hasGlyphForCodePoint(c: number): boolean };

const WEIGHTS = [400, 500, 600, 700];
const fonts = new Map<string, Font | null>();

function load(subset: 'latin' | 'latin-ext', weight: number): Font | null {
  const key = subset + weight;
  if (!fonts.has(key)) {
    try {
      const file = require.resolve(`@fontsource/inter/files/inter-${subset}-${weight}-normal.woff2`);
      fonts.set(key, fontkit.openSync(file) as unknown as Font);
    } catch {
      fonts.set(key, null);
    }
  }
  return fonts.get(key)!;
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿]/;
const cache = new Map<string, number>();

export const fontMeasure: Measure = (text, weight) => {
  const w = WEIGHTS.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
  const key = w + '|' + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const latin = load('latin', w);
  const ext = load('latin-ext', w);
  let total = 0;
  let run = '';
  let runFont: Font | null = null;
  const flush = () => {
    if (run && runFont) total += (runFont.layout(run).advanceWidth * 100) / runFont.unitsPerEm;
    run = '';
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const f = latin?.hasGlyphForCodePoint(cp) ? latin : ext?.hasGlyphForCodePoint(cp) ? ext : null;
    if (f) {
      if (f !== runFont) flush();
      runFont = f;
      run += ch;
    } else {
      flush();
      runFont = null;
      // CJK falls back to a full-width system font in the browser
      total += WIDE.test(ch) ? 100 : 60;
    }
  }
  flush();
  cache.set(key, total);
  return total;
};
