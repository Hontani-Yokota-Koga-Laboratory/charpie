/**
 * Server-side text measurement with the same font files the browser uses (Inter, or the
 * `family=` from ./fonts), so `charpie check` and the canvas agree on what fits.
 * Like the drawing, no ligatures or contextual alternates (`->` stays two glyphs).
 */
import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';
import type { Measure } from '../src/text/fit';
import { faceFor, findFamily, openFace, type Face } from './fonts';
import { eastAsianFor } from '../src/text/office';

const require = createRequire(import.meta.url);
type Font = { unitsPerEm: number; layout(s: string, features?: Record<string, boolean>): { advanceWidth: number }; hasGlyphForCodePoint(c: number): boolean };
const AS_WRITTEN = { calt: false, liga: false, clig: false };

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

export const fontMeasure: Measure = (text, weight, family) => {
  const w = WEIGHTS.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
  const faces = family ? findFamily(family) : undefined;
  // a Latin-only Office font's Japanese comes from its partner (as fontStack draws it)
  const ea = eastAsianFor(family);
  const eaFaces = faces && ea ? findFamily(ea) : undefined;
  const key = (faces ? weight + '|' + family : w) + '|' + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const latin = load('latin', w);
  const ext = load('latin-ext', w);
  let total = 0;
  let run = '';
  let runFont: Font | null = null;
  const flush = () => {
    if (run && runFont) total += (runFont.layout(run, AS_WRITTEN).advanceWidth * 100) / runFont.unitsPerEm;
    run = '';
  };
  let face: Face | undefined;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // the family's own glyph if it has one, else the default stack (as the browser falls back)
    face = faces ? (faceFor(faces, weight, cp) ?? (eaFaces ? faceFor(eaFaces, weight, cp) : undefined)) : undefined;
    const f = face ? openFace(face) : latin?.hasGlyphForCodePoint(cp) ? latin : ext?.hasGlyphForCodePoint(cp) ? ext : null;
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
