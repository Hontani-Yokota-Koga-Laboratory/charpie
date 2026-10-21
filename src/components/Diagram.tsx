import { createContext, memo, useContext, useId } from 'react';
import { arrowHeadPath, isDiagramSrc, lineAnchor, type EdgeLayout, type Layout, type NodeLayout } from '../layout';
import { LINE_HEIGHT, FONT_FAMILY, boldWeight, fontStack, inkCenter, type RichLine } from '../text/fit';
import { plainText } from '../text/inline';
import type { Mark } from '../text/blocks';
import type { CSSProperties } from 'react';

/**
 * Turns an image shape's `src=` into something an <image> can load: the canvas asks the server
 * (relative to the open file), exports embed data: URIs. Unresolved → drawn as a placeholder.
 */
export type ImageHref = (src: string) => string | undefined;
export const ImageHrefContext = createContext<ImageHref>((src) => (/^(https?:|data:)/.test(src) ? src : undefined));

const PRESERVE = { contain: 'xMidYMid meet', cover: 'xMidYMid slice', fill: 'none' } as const;

function NodeImage({ n, interactive }: { n: NodeLayout; interactive?: boolean }) {
  const resolve = useContext(ImageHrefContext);
  const { x, y, w, h } = n.box;
  // a .charpie that is not laid out (yet): never an <image> of its text
  const href = n.style.src && !isDiagramSrc(n.style.src) ? resolve(n.style.src) : undefined;
  if (!href) {
    // missing / unresolvable picture: a crossed box so it is obvious and still selectable
    return (
      <g style={{ pointerEvents: 'none' }}>
        <rect x={x} y={y} width={w} height={h} fill="#f1f5f9" stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 3" />
        <path d={`M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}`} stroke="#cbd5e1" strokeWidth={1} />
        {interactive && (
          <text x={x + w / 2} y={y + h / 2} fontSize={Math.max(9, Math.min(13, w / 12))} fill="#64748b" textAnchor="middle" dominantBaseline="middle" fontFamily={FONT_FAMILY}>
            {!n.style.src ? 'src= がありません' : isDiagramSrc(n.style.src) ? `図: ${n.style.src}（読み込み中 / 見つかりません）` : `画像なし: ${n.style.src}`}
          </text>
        )}
      </g>
    );
  }
  return <image href={href} x={x} y={y} width={w} height={h} preserveAspectRatio={PRESERVE[n.style.fit]} style={{ pointerEvents: 'none' }} />;
}

/**
 * Text is drawn as written: no ligatures / contextual alternates (Inter would turn `->` into an arrow).
 * Measurement (canvas and fontkit) is done the same way.
 */
export const TEXT_FEATURES: CSSProperties = { fontVariantLigatures: 'none', fontFeatureSettings: '"calt" 0, "liga" 0' };

/** Lines of a label with `$...$` formulas or `**bold**` spans: text runs as <text>, formulas as MathJax SVG on the same baseline. */
function RichText({ lines, rich, ax, anchor, baseline, size, weight, family, fill, style }: {
  lines: string[];
  rich: (RichLine | null)[];
  ax: number;
  anchor: 'left' | 'center' | 'right';
  baseline: (i: number, line: string) => number;
  size: number;
  weight: number;
  family?: string;
  fill: string | undefined;
  style?: CSSProperties;
}) {
  const ff = fontStack(family);
  const ta = anchor === 'left' ? 'start' : anchor === 'right' ? 'end' : 'middle';
  return (
    <>
      {lines.map((l, i) => {
        const r = rich[i];
        const text = r ? r.runs.map((x) => (x.math ? '' : x.s)).join('') : plainText(l);
        const y = baseline(i, text);
        if (!r) return <text key={i} x={ax} y={y} fontSize={size} fontWeight={weight} fill={fill} style={style} textAnchor={ta} fontFamily={ff} xmlSpace="preserve">{text || ' '}</text>;
        const x0 = anchor === 'left' ? ax : anchor === 'right' ? ax - r.width : ax - r.width / 2;
        return (
          <g key={i}>
            {r.runs.map((run, j) =>
              run.math ? (
                <svg
                  key={j}
                  x={x0 + run.x}
                  y={y - run.box.ascent * size}
                  width={run.w}
                  height={run.box.height * size}
                  viewBox={run.box.viewBox}
                  overflow="visible"
                  color={fill}
                  style={style ? { color: style.fill as string } : undefined}
                  dangerouslySetInnerHTML={{ __html: run.box.svg }}
                />
              ) : (
                <text key={j} x={x0 + run.x} y={y} fontSize={size} fontWeight={run.bold ? boldWeight(weight) : weight} fill={fill} style={style} textAnchor="start" fontFamily={ff} xmlSpace="preserve">
                  {run.s}
                </text>
              ),
            )}
          </g>
        );
      })}
    </>
  );
}

const DASH = { solid: undefined, dashed: (lw: number) => `${lw * 4} ${lw * 3}`, dotted: (lw: number) => `${lw * 0.01} ${lw * 2.4}` } as const;
const dashArray = (d: 'solid' | 'dashed' | 'dotted', lw: number) => (d === 'solid' ? undefined : DASH[d](lw));

export function NodeText({ n, hidden }: { n: NodeLayout; hidden?: boolean }) {
  if (!n.def.label || hidden || n.kind === 'image' || n.blocks) return null;
  const { size, lines } = n.text;
  const lh = size * LINE_HEIGHT;
  const rot = n.style.rotate;
  let h: 'left' | 'center' | 'right', ax: number, top: number, transform: string | undefined;
  if (rot === 0) {
    h = n.style.halign;
    ax = h === 'left' ? n.textBox.x : h === 'right' ? n.textBox.x + n.textBox.w : n.textBox.x + n.textBox.w / 2;
    top = n.textRect.y;
  } else {
    // lay the block out unrotated around the centre of its on-screen rect, then turn it
    h = lineAnchor(n.style);
    const cx = n.textRect.x + n.textRect.w / 2,
      cy = n.textRect.y + n.textRect.h / 2;
    const w = n.text.width;
    ax = h === 'left' ? cx - w / 2 : h === 'right' ? cx + w / 2 : cx;
    top = cy - n.text.height / 2;
    transform = `rotate(${rot} ${cx} ${cy})`;
  }
  if (n.rich)
    return (
      <g transform={transform} style={{ pointerEvents: 'none' }}>
        <RichText lines={lines} rich={n.rich} ax={ax} anchor={h} size={size} weight={n.style.weight} family={n.style.family} fill={n.style.text} baseline={(i, t) => top + lh * (i + 0.5) + inkCenter(t, n.style.weight, n.style.family) * size} />
      </g>
    );
  return (
    <text
      x={ax}
      fontSize={size}
      fontWeight={n.style.weight}
      fill={n.style.text}
      textAnchor={h === 'left' ? 'start' : h === 'right' ? 'end' : 'middle'}
      fontFamily={fontStack(n.style.family)}
      transform={transform}
      style={{ pointerEvents: 'none' }}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={ax} y={top + lh * (i + 0.5) + inkCenter(l, n.style.weight, n.style.family) * size}>
          {plainText(l) || ' '}
        </tspan>
      ))}
    </text>
  );
}

export const NodeShape = memo(function NodeShape({ n, hideText, interactive }: { n: NodeLayout; hideText?: boolean; interactive?: boolean }) {
  const s = n.style;
  return (
    <g data-node={interactive ? n.id : undefined} className={interactive ? 'node' : undefined} opacity={s.opacity}>
      {n.kind === 'image' && (n.embed ? <EmbeddedDiagram n={n} /> : <NodeImage n={n} interactive={interactive} />)}
      <path
        d={n.path}
        fill={s.fill === 'none' ? (interactive ? 'transparent' : 'none') : s.fill}
        stroke={s.stroke === 'none' || n.kind === 'table' ? 'none' : s.stroke}
        strokeWidth={s.lw}
        strokeDasharray={dashArray(s.dash, s.lw)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <NodeText n={n} hidden={hideText} />
      {n.blocks && <BlockContent n={n} hidden={hideText} />}
    </g>
  );
});

/** Another .charpie drawn inside an image shape (clipped to the shape's box). */
function EmbeddedDiagram({ n }: { n: NodeLayout }) {
  const e = n.embed!;
  const clip = 'emb' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const b = n.box;
  return (
    <g style={{ pointerEvents: 'none' }}>
      <clipPath id={clip}>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <g transform={`translate(${e.dx} ${e.dy}) scale(${e.scale})`}>
          {e.layout.frame && <rect x={e.layout.frame.x} y={e.layout.frame.y} width={e.layout.frame.w} height={e.layout.frame.h} fill="#ffffff" />}
          {e.layout.nodes.map((m) => (
            <NodeShape key={m.id} n={m} />
          ))}
          {e.layout.edges.map((x) => (
            <EdgeShape key={x.key} e={x} />
          ))}
          {e.layout.edges.map((x) => (
            <EdgeLabel key={x.key} e={x} bg="#ffffff" />
          ))}
        </g>
      </g>
    </g>
  );
}

function MarkShape({ m, color }: { m: Mark; color: string }) {
  if (m.kind === 'square') return <rect x={m.cx - m.r} y={m.cy - m.r} width={m.r * 2} height={m.r * 2} fill={color} />;
  if (m.kind === 'circle') return <circle cx={m.cx} cy={m.cy} r={m.r * 0.86} fill="none" stroke={color} strokeWidth={m.r * 0.28} />;
  return <circle cx={m.cx} cy={m.cy} r={m.r} fill={color} />;
}

/** table / list content: row / cell backgrounds, positioned text pieces, bullets and (table) rules. */
function BlockContent({ n, hidden }: { n: NodeLayout; hidden?: boolean }) {
  const b = n.blocks!;
  if (hidden) return null;
  const color = n.style.text;
  const fam = n.style.family;
  return (
    <g style={{ pointerEvents: 'none' }}>
      {b.fills.map((f, i) => (
        <rect key={'f' + i} x={f.x} y={f.y} width={f.w} height={f.h} fill={f.fill} />
      ))}
      {b.marks.map((m, i) => (
        <MarkShape key={'m' + i} m={m} color={color} />
      ))}
      {b.rules.map((r, i) => (
        <line key={'r' + i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke={n.style.stroke === 'none' ? color : n.style.stroke} strokeWidth={r.lw} />
      ))}
      {b.pieces.map((p, i) => {
        const lh = p.size * (p.lh ?? LINE_HEIGHT);
        const baseline = (k: number, t: string) => p.y + lh * (k + 0.5) + inkCenter(t, p.weight, fam) * p.size;
        if (p.rich) return <RichText key={i} lines={p.lines} rich={p.rich} ax={p.x} anchor={p.anchor} size={p.size} weight={p.weight} family={fam} fill={p.color ?? color} baseline={baseline} />;
        return (
          <text key={i} fontSize={p.size} fontWeight={p.weight} fill={p.color ?? color} textAnchor={p.anchor === 'left' ? 'start' : p.anchor === 'right' ? 'end' : 'middle'} fontFamily={fontStack(fam)}>
            {p.lines.map((l, k) => (
              <tspan key={k} x={p.x} y={baseline(k, l)}>
                {plainText(l) || ' '}
              </tspan>
            ))}
          </text>
        );
      })}
    </g>
  );
}

export const EdgeShape = memo(function EdgeShape({ e, interactive }: { e: EdgeLayout; interactive?: boolean }) {
  const s = e.style;
  return (
    <g data-edge={interactive ? e.key : undefined}>
      {interactive && <path d={e.path} className="edge-hit" stroke="transparent" strokeWidth={14} fill="none" />}
      <path
        d={e.path}
        fill="none"
        stroke={s.stroke}
        strokeWidth={s.lw}
        strokeDasharray={dashArray(s.dash, s.lw)}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ pointerEvents: 'none' }}
      />
      {e.heads.map((h, i) => (
        <path key={i} d={arrowHeadPath(h, s.lw)} fill={s.stroke} stroke={s.stroke} strokeWidth={s.lw * 0.6} strokeLinejoin="round" style={{ pointerEvents: 'none' }} />
      ))}
    </g>
  );
});

export function EdgeLabel({ e, bg, interactive }: { e: EdgeLayout; bg: string; interactive?: boolean }) {
  if (!e.label) return null;
  const { box, lines, size } = e.label;
  const lh = size * LINE_HEIGHT;
  return (
    <g data-edge={interactive ? e.key : undefined} className={interactive ? 'edge-hit' : undefined}>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={Math.min(8, box.h / 2)} style={{ fill: bg }} />
      {e.label.rich ? (
        <g style={{ pointerEvents: 'none' }}>
          <RichText
            lines={lines}
            rich={e.label.rich}
            ax={box.x + box.w / 2}
            anchor="center"
            size={size}
            weight={500}
            family={e.style.family}
            fill={undefined}
            style={{ fill: interactive && !e.style.textExplicit ? 'var(--text-2)' : e.style.text }}
            baseline={(i, t) => box.y + 3 + lh * (i + 0.5) + inkCenter(t, 500, e.style.family) * size}
          />
        </g>
      ) : (
        <text
          fontSize={size}
          fontWeight={500}
          style={{ pointerEvents: 'none', fill: interactive && !e.style.textExplicit ? 'var(--text-2)' : e.style.text }}
          textAnchor="middle"
          fontFamily={fontStack(e.style.family)}
        >
          {lines.map((l, i) => (
            <tspan key={i} x={box.x + box.w / 2} y={box.y + 3 + lh * (i + 0.5) + inkCenter(l, 500, e.style.family) * size}>
              {plainText(l)}
            </tspan>
          ))}
        </text>
      )}
    </g>
  );
}

/** Static diagram (used for export). */
export function DiagramSvg({ layout, bg, padding = 24, images }: { layout: Layout; bg: string | null; padding?: number; images?: ImageHref }) {
  const b = layout.frame ?? diagramBounds(layout);
  const pad = layout.frame ? 0 : padding;
  const x = b.x - pad,
    y = b.y - pad,
    w = b.w + pad * 2,
    h = b.h + pad * 2;
  const svg = (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox={`${x} ${y} ${w} ${h}`} width={w} height={h} fontFamily={FONT_FAMILY} style={TEXT_FEATURES}>
      {bg && <rect x={x} y={y} width={w} height={h} fill={bg} />}
      {layout.nodes.map((n) => (
        <NodeShape key={n.id} n={n} />
      ))}
      {layout.edges.map((e) => (
        <EdgeShape key={e.key} e={e} />
      ))}
      {layout.edges.map((e) => (
        <EdgeLabel key={e.key} e={e} bg={bg ?? '#ffffff'} />
      ))}
    </svg>
  );
  return images ? <ImageHrefContext.Provider value={images}>{svg}</ImageHrefContext.Provider> : svg;
}

export function diagramBounds(layout: Layout) {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  const add = (x: number, y: number) => {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  };
  for (const n of layout.nodes) {
    add(n.box.x - n.style.lw, n.box.y - n.style.lw);
    add(n.box.x + n.box.w + n.style.lw, n.box.y + n.box.h + n.style.lw);
  }
  for (const e of layout.edges) {
    for (const p of e.pts) add(p.x, p.y);
    if (e.label) {
      add(e.label.box.x, e.label.box.y);
      add(e.label.box.x + e.label.box.w, e.label.box.y + e.label.box.h);
    }
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: 400, h: 300 };
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
