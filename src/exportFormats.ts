import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiagramSvg, type ImageHref } from './components/Diagram';
import { junctionStrokes } from './geom/geom';
import { arrowHeadPath, lineAnchor, type Layout } from './layout';
import { LINE_HEIGHT } from './text/fit';
import { splitMath } from './text/math';

/** `images` resolves image shapes' `src=` (exports pass data: URIs so the file stands alone). */
export function exportSvg(layout: Layout, bg: string | null = '#ffffff', images?: ImageHref): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + renderToStaticMarkup(createElement(DiagramSvg, { layout, bg, images }));
}

/** Distinct `src=` of the image shapes in a layout. */
export function imageSources(layout: Layout): string[] {
  return [...new Set(layout.nodes.flatMap((n) => (n.kind === 'image' && n.style.src ? [n.style.src] : [])))];
}

// ───────────── TikZ ─────────────

const PX = 0.75; // 1px = 0.75pt
const f = (n: number) => String(Math.round(n * PX * 100) / 100);

function texEscape(s: string): string {
  return s.replace(/[\\{}$&#^_%~]/g, (c) => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' })[c] ?? '\\' + c);
}

/** A label line for TeX: formulas go through as `$...$`, the rest is escaped. */
const texLine = (l: string) => splitMath(l).map((g) => (g.math ? `$${g.s}$` : texEscape(g.s))).join('');

export function exportTikz(layout: Layout): string {
  const colors = new Map<string, string>();
  const color = (c: string): string | undefined => {
    if (!c || c === 'none') return undefined;
    let hex = c.replace('#', '').toUpperCase();
    if (!/^[0-9A-F]+$/.test(hex)) return c; // named color: pass through
    if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((x) => x + x).join('');
    hex = hex.slice(0, 6);
    if (!colors.has(hex)) colors.set(hex, `cp${colors.size + 1}`);
    return colors.get(hex)!;
  };
  const dash = (d: string) => (d === 'dashed' ? ', dashed' : d === 'dotted' ? ', dotted' : '');
  const body: string[] = [];

  for (const n of layout.nodes) {
    const s = n.style;
    const draw = color(s.stroke);
    const fill = color(s.fill);
    const frame = n.kind === 'table' ? undefined : draw;
    const opts = [frame ? `draw=${frame}` : 'draw=none', fill ? `fill=${fill}` : null, `line width=${f(s.lw)}pt`].filter(Boolean).join(', ') + dash(s.dash) + (n.kind === 'round' ? `, rounded corners=${f(s.radius)}pt` : '');
    const { x, y, w, h } = n.box;
    let shape: string;
    if (n.kind === 'ellipse' || n.kind === 'cross' || n.kind === 'plus') shape = `(${f(x + w / 2)},${f(-(y + h / 2))}) ellipse [x radius=${f(w / 2)}pt, y radius=${f(h / 2)}pt]`;
    else if (n.kind === 'rect' || n.kind === 'round' || n.kind === 'text') shape = `(${f(x)},${f(-y)}) rectangle (${f(x + w)},${f(-(y + h))})`;
    else shape = n.poly.map((p) => `(${f(p.x)},${f(-p.y)})`).join(' -- ') + ' -- cycle';
    body.push(`  % ${n.id}`);
    if (n.kind === 'image' && s.src) {
      // path relative to the .charpie file; keep it next to the .tex (needs \usepackage{graphicx})
      const keep = s.fit === 'fill' ? '' : ', keepaspectratio';
      body.push(`  \\node[anchor=center, inner sep=0pt] at (${f(x + w / 2)},${f(-(y + h / 2))}) {\\includegraphics[width=${f(w)}pt, height=${f(h)}pt${keep}]{${s.src}}};`);
    }
    if (frame || fill) body.push(`  \\path[${opts}] ${shape};`);
    if (n.blocks) {
      // table rules and the text pieces of tables / lists
      const rc = color(s.stroke) ?? color(s.text);
      for (const r of n.blocks.rules) body.push(`  \\draw[${rc ? `draw=${rc}, ` : ''}line width=${f(r.lw)}pt] (${f(r.x1)},${f(-r.y1)}) -- (${f(r.x2)},${f(-r.y2)});`);
      const tc = color(s.text);
      for (const p of n.blocks.pieces) {
        const size = p.size * PX;
        const font = `font=\\fontsize{${size.toFixed(1)}}{${(size * LINE_HEIGHT).toFixed(1)}}\\selectfont${p.weight >= 600 ? '\\bfseries' : ''}`;
        const anchor = p.anchor === 'left' ? 'north west' : p.anchor === 'right' ? 'north east' : 'north';
        body.push(`  \\node[align=${p.anchor}, anchor=${anchor}, inner sep=0pt${tc ? `, text=${tc}` : ''}, ${font}] at (${f(p.x)},${f(-p.y)}) {${p.lines.map(texLine).join('\\\\ ')}};`);
      }
    }
    if (draw && (n.kind === 'cross' || n.kind === 'plus'))
      for (const [p, q] of junctionStrokes(n.kind, n.box)) body.push(`  \\draw[draw=${draw}, line width=${f(s.lw)}pt] (${f(p.x)},${f(-p.y)}) -- (${f(q.x)},${f(-q.y)});`);
    if (n.def.label && n.kind !== 'image' && !n.blocks) {
      const tc = color(s.text);
      const size = n.text.size * PX;
      const lines = n.text.lines.map(texLine).join('\\\\ ');
      const font = `font=\\fontsize{${size.toFixed(1)}}{${(size * LINE_HEIGHT).toFixed(1)}}\\selectfont${s.weight >= 600 ? '\\bfseries' : ''}`;
      const cy = n.textRect.y + n.textRect.h / 2;
      if (s.rotate === 0) {
        body.push(
          `  \\node[align=${s.halign}, anchor=${s.halign === 'left' ? 'west' : s.halign === 'right' ? 'east' : 'center'}, inner sep=0pt${tc ? `, text=${tc}` : ''}, ${font}] at (${f(s.halign === 'left' ? n.textBox.x : s.halign === 'right' ? n.textBox.x + n.textBox.w : n.textBox.x + n.textBox.w / 2)},${f(-cy)}) {${lines}};`,
        );
      } else {
        // TikZ rotates counter-clockwise; ours is clockwise on a y-down canvas
        const cx = n.textRect.x + n.textRect.w / 2;
        body.push(`  \\node[align=${lineAnchor(s)}, anchor=center, rotate=${-s.rotate}, inner sep=0pt${tc ? `, text=${tc}` : ''}, ${font}] at (${f(cx)},${f(-cy)}) {${lines}};`);
      }
    }
  }

  for (const e of layout.edges) {
    const s = e.style;
    const c = color(s.stroke);
    body.push(`  % ${e.def.from} ${e.def.op} ${e.def.to}`);
    const pts = e.pts.map((p) => `(${f(p.x)},${f(-p.y)})`).join(' -- ');
    body.push(`  \\draw[${c ? `draw=${c}` : ''}, line width=${f(s.lw)}pt${dash(s.dash)}${e.style.route === 'ortho' ? ', rounded corners=4pt' : ''}] ${pts};`);
    for (const hd of e.heads) {
      const path = arrowHeadPath(hd, s.lw)
        .replace(/^M/, '')
        .replace(/Z$/, '')
        .split('L')
        .map((pair) => {
          const [px, py] = pair.trim().split(/\s+/).map(Number);
          return `(${f(px)},${f(-py)})`;
        })
        .join(' -- ');
      body.push(`  \\fill[${c ?? 'black'}] ${path} -- cycle;`);
    }
    if (e.label) {
      const tc = color(s.text);
      const size = e.label.size * PX;
      body.push(
        `  \\node[fill=white, rounded corners=2pt, inner sep=2pt, align=center${tc ? `, text=${tc}` : ''}, font=\\fontsize{${size.toFixed(1)}}{${(size * LINE_HEIGHT).toFixed(1)}}\\selectfont] at (${f(e.label.center.x)},${f(-e.label.center.y)}) {${e.label.lines.map(texLine).join('\\\\ ')}};`,
      );
    }
  }

  const defs = [...colors.entries()].map(([hex, name]) => `\\definecolor{${name}}{HTML}{${hex}}`);
  return [
    '% Generated by Charpie — requires \\usepackage{tikz} (and xcolor' + (imageSources(layout).length ? ', graphicx' : '') + ')',
    ...defs,
    '\\begin{tikzpicture}[x=1pt, y=1pt]',
    ...body,
    '\\end{tikzpicture}',
    '',
  ].join('\n');
}

