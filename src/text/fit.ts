/**
 * Text measurement + wrapping + font-size fitting.
 * Widths are measured once at 100px per (token, weight) and scaled linearly.
 */

import { hasMath, renderMath, splitMath, type MathBox } from './math';

export const FONT_FAMILY = `'Inter Variable', 'Inter', 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', system-ui, sans-serif`;
export const LINE_HEIGHT = 1.25;

export type Measure = (text: string, weight: number) => number; // width at 100px

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

function approxMeasure(text: string): number {
  let w = 0;
  for (const ch of text) w += isWide(ch) ? 100 : ch === ' ' ? 28 : /[A-Z]/.test(ch) ? 68 : 56;
  return w;
}

export const canvasMeasure: Measure = (text, weight) => {
  const key = weight + '|' + text;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  let w: number;
  if (ctx) {
    ctx.font = `${weight} 100px ${FONT_FAMILY}`;
    w = ctx.measureText(text).width;
  } else w = approxMeasure(text);
  cache.set(key, w);
  return w;
};

export const approxMeasureFn: Measure = (t) => approxMeasure(t);

export function clearMeasureCache() {
  cache.clear();
  inkCache.clear();
}

/**
 * Distance (in em) from the alphabetic baseline up to the visual centre of a line.
 * Measured on the fonts the browser actually uses (incl. CJK fallbacks such as
 * Yu Gothic, whose glyphs sit higher than Inter's metrics suggest), so labels look
 * vertically centred everywhere instead of trusting `dominant-baseline: central`.
 */
const inkCache = new Map<string, number>();
function inkCenterRef(weight: number, wide: boolean): number {
  const key = weight + (wide ? 'w' : 'l');
  const hit = inkCache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  // fallbacks for non-DOM rendering: Inter cap-height / 2, typical CJK face centre
  let v = wide ? 0.38 : 0.364;
  if (ctx) {
    ctx.font = `${weight} 100px ${FONT_FAMILY}`;
    // Latin: centre the cap height (descenders shouldn't pull text up). CJK: centre the glyph face.
    const m = ctx.measureText(wide ? '漢国あア' : 'H');
    if (m.actualBoundingBoxAscent > 0) v = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 200;
  }
  inkCache.set(key, v);
  return v;
}

export function inkCenter(line: string, weight: number): number {
  let wide = 0,
    total = 0;
  for (const ch of line) {
    if (ch === ' ') continue;
    total++;
    if (isWide(ch)) wide++;
  }
  if (!total) return inkCenterRef(weight, false);
  const k = wide / total;
  return inkCenterRef(weight, true) * k + inkCenterRef(weight, false) * (1 - k);
}

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿]/;
function isWide(ch: string) {
  return WIDE.test(ch);
}
/** Characters that must not start a line (kinsoku). */
const NO_START = /^[、。，．・：；？！ー）」』】〉》〕｝,.!?:;)\]}]/;

/** Width at 100px of a line that may contain `$...$` formulas. */
export function lineWidth(s: string, weight: number, measure: Measure): number {
  if (!s.includes('$')) return measure(s, weight);
  let w = 0;
  for (const g of splitMath(s)) {
    const m = g.math ? renderMath(g.s) : null;
    w += m && !m.error ? m.width * 100 : g.s ? measure(g.math ? `$${g.s}$` : g.s, weight) : 0;
  }
  return w;
}

/** Split a paragraph into wrap-able tokens: latin words, spaces, single CJK chars. A `$...$` formula never breaks. */
export function tokenizeText(s: string): string[] {
  const out: string[] = [];
  let word = '';
  const flush = () => {
    if (word) out.push(word);
    word = '';
  };
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\' && chars[i + 1] === '$') {
      word += ch + chars[++i];
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < chars.length && chars[j] !== '$') j += chars[j] === '\\' ? 2 : 1;
      if (j < chars.length && j > i + 1) {
        word += chars.slice(i, j + 1).join('');
        i = j;
        continue;
      }
    }
    if (ch === ' ') {
      flush();
      out.push(' ');
    } else if (isWide(ch)) {
      flush();
      if (NO_START.test(ch) && out.length && out[out.length - 1] !== ' ') out[out.length - 1] += ch;
      else out.push(ch);
    } else if (NO_START.test(ch) && !word && out.length && out[out.length - 1] !== ' ') {
      out[out.length - 1] += ch;
    } else word += ch;
  }
  flush();
  return out;
}

export interface WrapResult {
  lines: string[];
  /** max line width in px */
  width: number;
  /** a single token was wider than the box and had to be hard-broken */
  broke: boolean;
}

export function wrap(text: string, size: number, maxW: number, weight: number, measure: Measure): WrapResult {
  const k = size / 100;
  const mw = (s: string) => lineWidth(s, weight, measure) * k;
  const lines: string[] = [];
  let broke = false;
  let width = 0;
  for (const para of text.split('\n')) {
    const toks = tokenizeText(para);
    let line = '';
    const pushLine = (l: string) => {
      const t = l.replace(/ +$/, '');
      lines.push(t);
      width = Math.max(width, mw(t));
    };
    for (const tok of toks) {
      const cand = line + tok;
      if (mw(cand.replace(/ +$/, '')) <= maxW + 0.01 || (!line && tok === ' ')) {
        line = cand;
        continue;
      }
      if (tok === ' ') {
        pushLine(line);
        line = '';
        continue;
      }
      if (line.trim()) pushLine(line);
      line = '';
      if (mw(tok) <= maxW + 0.01) {
        line = tok;
        continue;
      }
      // hard break a token that cannot fit on its own
      broke = true;
      let piece = '';
      for (const ch of tok) {
        if (piece && mw(piece + ch) > maxW) {
          pushLine(piece);
          piece = '';
        }
        piece += ch;
      }
      line = piece;
    }
    pushLine(line.replace(/^ +/, ''));
  }
  return { lines, width, broke };
}

export interface FitResult {
  size: number;
  lines: string[];
  width: number;
  height: number;
  overflow: boolean;
  /** true when the size came from automatic fitting */
  auto: boolean;
}

export interface FitOpts {
  /** fixed font size; undefined = auto */
  fixed?: number;
  min: number;
  max: number;
  weight: number;
  measure: Measure;
}

function layoutAt(text: string, size: number, box: { w: number; h: number }, o: FitOpts) {
  const r = wrap(text, size, box.w, o.weight, o.measure);
  const height = r.lines.length * size * LINE_HEIGHT;
  const fits = !r.broke && r.width <= box.w + 0.5 && height <= box.h + 0.5;
  return { ...r, height, fits };
}

export function fitText(text: string, box: { w: number; h: number }, o: FitOpts): FitResult {
  if (!text) return { size: o.fixed ?? o.max, lines: [], width: 0, height: 0, overflow: false, auto: o.fixed === undefined };
  if (o.fixed !== undefined) {
    const r = layoutAt(text, o.fixed, box, o);
    return { size: o.fixed, lines: r.lines, width: r.width, height: r.height, overflow: !r.fits, auto: false };
  }
  const min = Math.max(1, Math.min(o.min, o.max));
  // binary search on half-pixel steps for the largest fitting size
  let lo = Math.round(min * 2),
    hi = Math.round(o.max * 2);
  let best: ReturnType<typeof layoutAt> | undefined;
  let bestSize = min;
  if (layoutAt(text, hi / 2, box, o).fits) lo = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = layoutAt(text, mid / 2, box, o);
    if (r.fits) {
      best = r;
      bestSize = mid / 2;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!best) {
    const r = layoutAt(text, min, box, o);
    return { size: min, lines: r.lines, width: r.width, height: r.height, overflow: true, auto: true };
  }
  return { size: bestSize, lines: best.lines, width: best.width, height: best.height, overflow: false, auto: true };
}

/** A line split into positioned pieces; `x` and `w` in px from the line start. */
export type Run = { x: number; w: number } & ({ math: false; s: string } | { math: true; s: string; box: MathBox });
export interface RichLine {
  width: number;
  runs: Run[];
}

/** Positioned runs for lines that contain formulas (`undefined` when none do, so plain labels stay plain). */
export function richLines(lines: string[], size: number, weight: number, measure: Measure): (RichLine | null)[] | undefined {
  if (!lines.some(hasMath)) return undefined;
  const k = size / 100;
  return lines.map((l) => {
    if (!hasMath(l)) return null;
    const runs: Run[] = [];
    let x = 0;
    for (const g of splitMath(l)) {
      const box = g.math ? renderMath(g.s) : null;
      if (g.math && box?.error) {
        // untypesettable: show the source (check reports it)
        const s = `$${g.s}$`;
        const w = measure(s, weight) * k;
        runs.push({ math: false, s, x, w });
        x += w;
      } else if (g.math && box) {
        runs.push({ math: true, s: g.s, box, x, w: box.width * size });
        x += box.width * size;
      } else if (g.s) {
        const w = measure(g.s, weight) * k;
        runs.push({ math: false, s: g.s, x, w });
        x += w;
      }
    }
    return { width: x, runs };
  });
}
