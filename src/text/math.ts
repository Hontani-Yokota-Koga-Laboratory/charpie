/**
 * Inline TeX in labels: `$...$` is typeset by MathJax into plain SVG paths.
 * Same output in the browser and in Node (no DOM, no web fonts), so `check`,
 * the canvas and every export agree on the size of a formula.
 */
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';

export interface MathBox {
  /** inner SVG markup in em/1000 units, baseline at y=0 */
  svg: string;
  viewBox: string;
  /** sizes in em */
  width: number;
  ascent: number;
  height: number;
  error?: string;
}

type Doc = ReturnType<typeof mathjax.document>;
let adaptor: ReturnType<typeof liteAdaptor> | null = null;
let doc: Doc | null = null;
const cache = new Map<string, MathBox>();

export function renderMath(tex: string): MathBox {
  const hit = cache.get(tex);
  if (hit) return hit;
  if (!doc) {
    adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    doc = mathjax.document('', {
      InputJax: new TeX({ packages: ['base', 'ams', 'newcommand', 'boldsymbol'] }),
      OutputJax: new SVG({ fontCache: 'none' }),
    });
  }
  const a = adaptor!;
  const svgEl = a.firstChild(doc.convert(tex, { display: false })) as Parameters<typeof a.getAttribute>[0];
  const vb = (a.getAttribute(svgEl, 'viewBox') ?? '0 0 0 0').split(/\s+/).map(Number);
  const inner = a.innerHTML(svgEl);
  const err = /data-mjx-error="([^"]*)"/.exec(inner)?.[1];
  const box: MathBox = { svg: inner, viewBox: vb.join(' '), width: vb[2] / 1000, ascent: -vb[1] / 1000, height: vb[3] / 1000, error: err };
  cache.set(tex, box);
  return box;
}

export type Seg = { math: false; s: string } | { math: true; s: string };

/** Split a label value at unescaped `$`. `\$` is a literal dollar. An unclosed `$` is plain text. */
export function splitMath(s: string): Seg[] {
  if (!s.includes('$')) return [{ math: false, s }];
  const out: Seg[] = [];
  let text = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && s[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }
    if (s[i] === '$') {
      const end = findClose(s, i + 1);
      if (end > i + 1) {
        if (text) out.push({ math: false, s: text });
        text = '';
        out.push({ math: true, s: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    text += s[i++];
  }
  if (text || !out.length) out.push({ math: false, s: text });
  return out;
}

/** index of the `$` closing a formula that starts at `from`, or -1 */
function findClose(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '$') return j;
  }
  return -1;
}

export const hasMath = (s: string) => s.includes('$') && splitMath(s).some((g) => g.math);
