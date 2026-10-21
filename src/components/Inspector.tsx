import { useState } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Minus,
  StretchHorizontal,
  StretchVertical,
  Maximize2,
  TriangleAlert,
  WandSparkles,
  Columns2,
  Rows2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ArrowUpToLine,
  ArrowDownToLine,
  FoldVertical,
} from 'lucide-react';
import { reparse, useStore, type State } from '../store';
import { isValidId, pointText, renameNode, setEdgeEnds, setNodeBody, setPageHeader, setSetting, setEdgeLabel, setEdgesAttr, setEdgesOp, setNodeLabel, setNodesAttr, setNodesGeom, setNodesKind, type Geom } from '../dsl/patch';
import { assetHref } from '../images';
import { SHAPE_KINDS, type ArrowOp, type Doc, type ShapeKind } from '../dsl/types';
import { align, distribute, matchSize, stack, type AlignMode } from '../ops/arrange';
import { autoFix } from '../check/resolve';
import { canvasMeasure } from '../text/fit';
import { LiveText, NumField, Seg, ShapeIcon, SHAPE_NAMES, Swatches } from './ui';
import { descendants, endText } from '../dsl/parse';
import { IGNORE_NAME } from '../check/check';
import { ignoreIssue, ignoreList, setIgnore } from '../actions';

const FILLS = ['#ffffff', '#f8fafc', '#f1f5f9', '#eef2ff', '#ede9fe', '#fdf4ff', '#fff1f2', '#fff7ed', '#fefce8', '#ecfdf5', '#ecfeff', '#e0f2fe', '#1e293b', '#0f172a'];
const STROKES = ['#0f172a', '#334155', '#64748b', '#94a3b8', '#6366f1', '#7c3aed', '#c026d3', '#e11d48', '#ea580c', '#ca8a04', '#059669', '#0891b2', '#0284c7', '#ffffff'];

export const PRESETS: { name: string; fill: string; stroke: string; text: string }[] = [
  { name: 'Slate', fill: '#f8fafc', stroke: '#475569', text: '#0f172a' },
  { name: 'Indigo', fill: '#eef2ff', stroke: '#6366f1', text: '#312e81' },
  { name: 'Violet', fill: '#f5f3ff', stroke: '#8b5cf6', text: '#4c1d95' },
  { name: 'Cyan', fill: '#ecfeff', stroke: '#0891b2', text: '#164e63' },
  { name: 'Emerald', fill: '#ecfdf5', stroke: '#059669', text: '#064e3b' },
  { name: 'Amber', fill: '#fffbeb', stroke: '#d97706', text: '#78350f' },
  { name: 'Rose', fill: '#fff1f2', stroke: '#e11d48', text: '#881337' },
  { name: 'Ink', fill: '#1e293b', stroke: '#0f172a', text: '#f8fafc' },
];

/** Update text through the store, coalescing while a scrub gesture is active. */
function edit(fn: (src: string, doc: Doc) => string) {
  const s = useStore.getState();
  if (s.gestureBase !== null) s.setSource(fn(s.src, s.doc), { history: 'none' });
  else s.apply(fn);
}

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const layout = useStore((s) => s.layout);
  const issues = useStore((s) => s.issues);
  const doc = useStore((s) => s.doc);
  if (!selection.nodes.length && !selection.edges.length) return <DocInspector doc={doc} />;
  const nodes = selection.nodes.map((id) => layout.nodeMap.get(id)).filter(Boolean) as State['layout']['nodes'];
  const edges = selection.edges.map((k) => layout.edgeMap.get(k)).filter(Boolean) as State['layout']['edges'];
  const related = issues.filter((i) => i.nodes.some((n) => selection.nodes.includes(n)) || i.edges.some((e) => selection.edges.includes(e)));

  return (
    <div className="inspector">
      {nodes.length > 0 ? <NodeInspector nodes={nodes} doc={doc} /> : <EdgeInspector edges={edges} />}
      {related.length > 0 && (
        <div className="inline-issues">
          <TriangleAlert size={14} style={{ flex: 'none', marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            {related.slice(0, 3).map((i) => (
              <div key={i.id} className="inline-issue-row">
                <span style={{ flex: 1 }}>{i.message}</span>
                <button className="link-btn" title={`ignore=${IGNORE_NAME[i.code]} を付けてこの種類の警告を出さない`} onClick={() => ignoreIssue(i)}>
                  無視
                </button>
              </div>
            ))}
            {related.length > 3 && <div>…ほか {related.length - 3} 件</div>}
          </div>
          <button
            className="chip-btn"
            onClick={() => {
              const s = useStore.getState();
              s.apply((src) => autoFix(src, canvasMeasure, { view: useStore.getState().page, only: new Set(related.map((r) => r.id)) }));
              s.notify('解消しました', 'ok');
            }}
          >
            解消
          </button>
        </div>
      )}
    </div>
  );
}

/** Image shapes: the file, how it fills the box, and snapping the box to the picture's aspect ratio. */
function ImageSection({ n, setAttr, setH }: { n: State['layout']['nodes'][number]; setAttr: (k: string, v: string | undefined) => void; setH: (h: number) => void }) {
  const file = useStore((s) => (s.workspace.on ? s.workspace.file : null));
  const fitAspect = () => {
    const href = n.style.src && assetHref(file)(n.style.src);
    if (!href) return;
    const img = new Image();
    img.onload = () => img.naturalWidth && setH(Math.round((n.box.w * img.naturalHeight) / img.naturalWidth));
    img.onerror = () => useStore.getState().notify(`画像を読めません: ${n.style.src}`, 'warn');
    img.src = href;
  };
  return (
    <div className="section">
      <div className="section-label">画像</div>
      <LiveText key={n.id} value={n.def.attrs.src ?? ''} onChange={(v) => setAttr('src', v || undefined)} placeholder="assets/x.png（.charpie からの相対パス）" />
      <div className="row" style={{ marginTop: 6 }}>
        <label>収め方</label>
        <Seg
          small
          value={n.style.fit}
          onChange={(v) => setAttr('fit', v === 'contain' ? undefined : v)}
          options={[
            { v: 'contain', label: '全体', tip: '縦横比を保って全体を表示（fit=contain）' },
            { v: 'cover', label: '切抜', tip: '縦横比を保って枠を埋める（fit=cover）' },
            { v: 'fill', label: '伸縮', tip: '枠に合わせて伸縮（fit=fill）' },
          ]}
        />
      </div>
      <button className="btn" style={{ marginTop: 6 }} onClick={fitAspect}>
        縦横比を画像に合わせる
      </button>
    </div>
  );
}

function NodeInspector({ nodes, doc }: { nodes: State['layout']['nodes']; doc: Doc }) {
  const ids = nodes.map((n) => n.id);
  const first = nodes[0];
  const single = nodes.length === 1 ? first : undefined;
  const [idDraft, setIdDraft] = useState<string | null>(null);
  const setAttr = (k: string, v: string | undefined) => edit((src, d) => setNodesAttr(src, d, ids, k, v));
  /** `resize`: x/y change only to keep the centre fixed, so children stay put */
  const setGeom = (g: Partial<Geom>, resize = false) =>
    edit((src, d) => {
      if (!single) return src;
      const n = d.nodeMap.get(single.id)!;
      // moving a container drags its children along
      const out = new Map<string, Partial<Geom>>([[single.id, g]]);
      if (!resize && (g.x !== undefined || g.y !== undefined)) {
        const dx = (g.x ?? n.x) - n.x,
          dy = (g.y ?? n.y) - n.y;
        for (const c of descendants(d, [single.id])) {
          const cn = d.nodeMap.get(c)!;
          out.set(c, { x: cn.x + dx, y: cn.y + dy });
        }
      }
      return setNodesGeom(src, d, out);
    });
  const s = useStore.getState();
  const st = first.style;
  const containers = doc.nodes.filter((n) => !ids.includes(n.id) && !descendants(doc, ids).has(n.id));

  return (
    <>
      <div className="insp-head">
        <div className="insp-kind">
          <ShapeIcon kind={first.kind} size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="insp-title">{single ? SHAPE_NAMES[single.kind] : `${nodes.length} 個の図形`}</div>
          {single ? (
            <input
              className="field mono"
              style={{ height: 22, padding: '0 6px', marginTop: 2, borderColor: idDraft !== null && !isValidId(idDraft) ? 'var(--danger)' : undefined }}
              value={idDraft ?? single.id}
              onChange={(e) => setIdDraft(e.target.value)}
              onBlur={() => {
                if (idDraft && idDraft !== single.id) {
                  if (!isValidId(idDraft) || doc.nodeMap.has(idDraft)) s.notify(`ID「${idDraft}」は使えません`, 'warn');
                  else {
                    s.apply((src, d) => renameNode(src, d, single.id, idDraft));
                    useStore.getState().select({ nodes: [idDraft] });
                  }
                }
                setIdDraft(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <div className="insp-sub">{ids.join(', ')}</div>
          )}
        </div>
      </div>

      {single?.def.body && (single.kind === 'table' || single.kind === 'list') && (
        <div className="section">
          <div className="section-label">{single.kind === 'table' ? '表の中身（| a | b | の行、|---| で見出しの区切り）' : '項目（- / 1. で始める、2 文字下げで入れ子）'}</div>
          <LiveText multiline mono rows={6} key={single.id + ':body'} value={single.def.body.text} onChange={(v) => edit((src, d) => setNodeBody(src, d, single.id, v))} />
          {single.kind === 'table' && <div className="hint-text">属性: align=l,c,r（列ごとの寄せ）· cols=2,1,1（列幅の比）· header=N · rules=booktabs|grid|none</div>}
        </div>
      )}

      {single && single.kind !== 'table' && single.kind !== 'list' && (
        <div className="section">
          <div className="section-label">{single.kind === 'image' ? '説明（代替テキスト・図には描かれません）' : 'ラベル'}</div>
          <LiveText multiline rows={2} key={single.id} value={single.def.labelSource ?? single.def.label} onChange={(v) => edit((src, d) => setNodeLabel(src, d, single.id, v))} />
        </div>
      )}

      {single?.kind === 'image' && <ImageSection n={single} setAttr={setAttr} setH={(h) => setGeom({ h })} />}

      <div className="section">
        <div className="section-label">形</div>
        <div className="seg small" style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', width: '100%' }}>
          {SHAPE_KINDS.filter((k) => k !== 'image').map((k) => (
            <button key={k} className={(first.kind === k ? 'on ' : '') + 'tip tip-bottom'} data-tip={SHAPE_NAMES[k]} style={{ justifyContent: 'center', padding: '5px 0' }} onClick={() => s.apply((src, d) => setNodesKind(src, d, ids, k as ShapeKind))}>
              <ShapeIcon kind={k} size={16} />
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-label">スタイル</div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="preset"
              title={p.name}
              style={{ background: p.fill, borderColor: p.stroke, color: p.text }}
              onClick={() =>
                s.apply((src, d) => {
                  let out = setNodesAttr(src, d, ids, 'fill', p.fill);
                  out = setNodesAttr(out, reparse(out), ids, 'stroke', p.stroke);
                  out = setNodesAttr(out, reparse(out), ids, 'text', p.text);
                  return out;
                })
              }
            >
              Aa
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-label">塗り</div>
        <Swatches colors={FILLS} value={st.fill} onChange={(c) => setAttr('fill', c)} allowNone />
      </div>
      <div className="section">
        <div className="section-label">枠線</div>
        <Swatches colors={STROKES} value={st.stroke} onChange={(c) => setAttr('stroke', c)} allowNone />
        <div className="row" style={{ marginTop: 10 }}>
          <input className="slider" type="range" min={0} max={6} step={0.25} value={st.lw} onChange={(e) => edit((src, d) => setNodesAttr(src, d, ids, 'lw', e.target.value))} onPointerDown={() => s.beginGesture()} onPointerUp={() => s.endGesture()} />
          <span className="val">{st.lw}px</span>
        </div>
        <Seg
          small
          value={st.dash}
          onChange={(v) => setAttr('dash', v === 'solid' ? undefined : v)}
          options={[
            { v: 'solid', label: <DashIcon d="solid" />, tip: '実線' },
            { v: 'dashed', label: <DashIcon d="dashed" />, tip: '破線' },
            { v: 'dotted', label: <DashIcon d="dotted" />, tip: '点線' },
          ]}
        />
      </div>

      <div className="section">
        <div className="section-label">
          文字
          <label className="toggle" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
            自動サイズ
            <input type="checkbox" checked={st.font === undefined} onChange={(e) => setAttr('font', e.target.checked ? undefined : String(Math.round(first.text.size)))} />
          </label>
        </div>
        <Swatches colors={STROKES} value={st.text} onChange={(c) => setAttr('text', c)} />
        <div className="row" style={{ marginTop: 10 }}>
          {st.font === undefined ? (
            <span className="val" style={{ textAlign: 'left', flex: 1 }}>
              {single ? `${single.text.size}px に自動調整` : '図形ごとに自動調整'}
            </span>
          ) : (
            <>
              <input className="slider" type="range" min={6} max={Math.max(120, Number(st.font))} step={1} value={st.font} onChange={(e) => edit((src, d) => setNodesAttr(src, d, ids, 'font', e.target.value))} onPointerDown={() => s.beginGesture()} onPointerUp={() => s.endGesture()} />
              <NumField label="px" value={Number(st.font)} min={1} onChange={(v) => edit((src, d) => setNodesAttr(src, d, ids, 'font', String(Math.round(v))))} onScrubStart={() => s.beginGesture()} onScrubEnd={() => s.endGesture()} />
            </>
          )}
        </div>
        <div className="row">
          <Seg
            small
            value={st.weight >= 650 ? 'bold' : st.weight <= 420 ? 'light' : 'normal'}
            onChange={(v) => setAttr('weight', v === 'normal' ? undefined : v)}
            options={[
              { v: 'light', label: <span style={{ fontWeight: 400 }}>Aa</span>, tip: '細字' },
              { v: 'normal', label: <span style={{ fontWeight: 550 }}>Aa</span>, tip: '標準' },
              { v: 'bold', label: <span style={{ fontWeight: 750 }}>Aa</span>, tip: '太字' },
            ]}
          />
        </div>
        <div className="row">
          <Seg
            small
            value={st.halign}
            onChange={(v) => setAttr('halign', v === 'center' ? undefined : v)}
            options={[
              { v: 'left', label: <AlignLeft size={14} />, tip: '左寄せ' },
              { v: 'center', label: <AlignCenter size={14} />, tip: '左右中央' },
              { v: 'right', label: <AlignRight size={14} />, tip: '右寄せ' },
            ]}
          />
          <Seg
            small
            value={st.valign}
            onChange={(v) => setAttr('valign', v === 'middle' ? undefined : v)}
            options={[
              { v: 'top', label: <ArrowUpToLine size={14} />, tip: '上揃え' },
              { v: 'middle', label: <FoldVertical size={14} />, tip: '上下中央' },
              { v: 'bottom', label: <ArrowDownToLine size={14} />, tip: '下揃え' },
            ]}
          />
        </div>
        <div className="row">
          <label>向き</label>
          <Seg
            small
            value={String(st.rotate)}
            onChange={(v) => setAttr('rotate', v === '0' ? undefined : v === '270' ? '-90' : v)}
            options={[
              { v: '0', label: <span className="rot-a">A</span>, tip: '横書き' },
              { v: '270', label: <span className="rot-a" style={{ transform: 'rotate(-90deg)' }}>A</span>, tip: '左に 90°（下から上へ読む）' },
              { v: '90', label: <span className="rot-a" style={{ transform: 'rotate(90deg)' }}>A</span>, tip: '右に 90°（上から下へ読む）' },
              { v: '180', label: <span className="rot-a" style={{ transform: 'rotate(180deg)' }}>A</span>, tip: '180°' },
            ]}
          />
        </div>
      </div>

      {single && <GeomSection def={single.def} setGeom={setGeom} />}

      {nodes.length > 1 && <ArrangeSection ids={ids} />}

      <div className="section">
        <div className="section-label">構造</div>
        <div className="row">
          <label>親</label>
          <select className="field" value={first.def.attrs.in ?? ''} onChange={(e) => setAttr('in', e.target.value || undefined)}>
            <option value="">（なし）</option>
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}
                {c.label ? ` — ${c.label.split('\n')[0]}` : ''}
              </option>
            ))}
          </select>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={first.def.attrs.overlap === 'allow'} onChange={(e) => setAttr('overlap', e.target.checked ? 'allow' : undefined)} />
          重なりを許可（チェック対象外）
        </label>
        {single && <IgnoreRow item={{ kind: 'node', id: single.id }} attrs={single.def.attrs} />}
      </div>
    </>
  );
}

const IGNORE_HINT: Record<string, string> = {
  all: 'すべて',
  overlap: '重なり',
  gap: '間隔不足',
  text: '文字のはみ出し',
  contain: '親からのはみ出し',
  covered: '文字が子に隠れる',
  through: '貫通',
  label: 'ラベルの衝突',
  loop: '自己ループ',
};

/** The item's `ignore=` list: chips to remove, plus an "ignore everything" switch. */
function IgnoreRow({ item, attrs }: { item: Parameters<typeof setIgnore>[0]; attrs: Record<string, string> }) {
  const list = ignoreList(attrs);
  const all = list.includes('all');
  return (
    <>
      <label className="toggle">
        <input type="checkbox" checked={all} onChange={(e) => setIgnore(item, e.target.checked ? ['all'] : list.filter((x) => x !== 'all'))} />
        警告をすべて無視（ignore=all）
      </label>
      {list.length > 0 && !all && (
        <div className="row">
          <label>無視中</label>
          <div className="ignore-chips">
            {list.map((n) => (
              <span key={n} className="ignore-chip" title={IGNORE_HINT[n] ?? n}>
                {n}
                <button aria-label={`${n} を戻す`} onClick={() => setIgnore(item, list.filter((x) => x !== n))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function GeomSection({ def, setGeom }: { def: { x: number; y: number; w: number; h: number }; setGeom: (g: Partial<Geom>, resize?: boolean) => void }) {
  const anchor = useStore((st) => st.geomAnchor);
  const s = useStore.getState();
  const scrub = { onScrubStart: () => s.beginGesture(), onScrubEnd: () => s.endGesture() };
  const centered = anchor === 'center';
  const cx = def.x + def.w / 2,
    cy = def.y + def.h / 2;
  return (
    <div className="section">
      <div className="section-label">
        位置とサイズ
        <div className="seg small anchor-seg">
          <button className={(centered ? '' : 'on ') + 'tip tip-bottom'} data-tip="X/Y は左上。サイズ変更で左上が固定" onClick={() => s.setGeomAnchor('corner')}>
            左上
          </button>
          <button className={(centered ? 'on ' : '') + 'tip tip-bottom'} data-tip="X/Y は中心。サイズ変更で中心が固定" onClick={() => s.setGeomAnchor('center')}>
            中心
          </button>
        </div>
      </div>
      <div className="num-grid">
        {centered ? (
          <>
            <NumField label="CX" value={cx} onChange={(v) => setGeom({ x: v - def.w / 2 })} {...scrub} />
            <NumField label="CY" value={cy} onChange={(v) => setGeom({ y: v - def.h / 2 })} {...scrub} />
            <NumField label="W" value={def.w} min={1} onChange={(v) => setGeom({ w: v, x: cx - v / 2 }, true)} {...scrub} />
            <NumField label="H" value={def.h} min={1} onChange={(v) => setGeom({ h: v, y: cy - v / 2 }, true)} {...scrub} />
          </>
        ) : (
          <>
            <NumField label="X" value={def.x} onChange={(v) => setGeom({ x: v })} {...scrub} />
            <NumField label="Y" value={def.y} onChange={(v) => setGeom({ y: v })} {...scrub} />
            <NumField label="W" value={def.w} min={1} onChange={(v) => setGeom({ w: v })} {...scrub} />
            <NumField label="H" value={def.h} min={1} onChange={(v) => setGeom({ h: v })} {...scrub} />
          </>
        )}
      </div>
    </div>
  );
}

function ArrangeSection({ ids }: { ids: string[] }) {
  const s = useStore.getState();
  const doAlign = (m: AlignMode) => s.apply((src, d) => align(src, d, ids, m));
  const [gap, setGap] = useState(24);
  return (
    <div className="section">
      <div className="section-label">整列</div>
      <div className="arrange-grid">
        <button className="icon-btn tip tip-bottom" data-tip="左揃え" onClick={() => doAlign('left')}>
          <AlignStartVertical size={16} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="左右中央" onClick={() => doAlign('hcenter')}>
          <AlignCenterVertical size={16} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="右揃え" onClick={() => doAlign('right')}>
          <AlignEndVertical size={16} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="上揃え" onClick={() => doAlign('top')}>
          <AlignStartHorizontal size={16} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="上下中央" onClick={() => doAlign('vcenter')}>
          <AlignCenterHorizontal size={16} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="下揃え" onClick={() => doAlign('bottom')}>
          <AlignEndHorizontal size={16} />
        </button>
      </div>
      <div className="wide-btns">
        <button onClick={() => s.apply((src, d) => matchSize(src, d, ids, 'width'))}>
          <StretchHorizontal size={13} /> 等幅
        </button>
        <button onClick={() => s.apply((src, d) => matchSize(src, d, ids, 'height'))}>
          <StretchVertical size={13} /> 等高
        </button>
        <button onClick={() => s.apply((src, d) => matchSize(src, d, ids, 'both'))}>
          <Maximize2 size={13} /> 同サイズ
        </button>
        <button disabled={ids.length < 3} style={{ opacity: ids.length < 3 ? 0.4 : 1 }} onClick={() => s.apply((src, d) => distribute(src, d, ids, 'h'))}>
          <AlignHorizontalDistributeCenter size={13} /> 横等間隔
        </button>
        <button disabled={ids.length < 3} style={{ opacity: ids.length < 3 ? 0.4 : 1 }} onClick={() => s.apply((src, d) => distribute(src, d, ids, 'v'))}>
          <AlignVerticalDistributeCenter size={13} /> 縦等間隔
        </button>
        <button
          onClick={() => {
            s.apply((src) => autoFix(src, canvasMeasure, { view: useStore.getState().page, pinned: new Set() }));
          }}
          title="重なり・はみ出しを解消"
        >
          <WandSparkles size={13} /> 整える
        </button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label>詰める</label>
        <div className="num-field" style={{ width: 70, flex: 'none' }}>
          <span>gap</span>
          <input value={gap} onChange={(e) => setGap(Number(e.target.value) || 0)} />
        </div>
        <button className="icon-btn tip tip-bottom" data-tip="横に並べる" onClick={() => s.apply((src, d) => stack(src, d, ids, 'h', gap))}>
          <Columns2 size={15} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="縦に並べる" onClick={() => s.apply((src, d) => stack(src, d, ids, 'v', gap))}>
          <Rows2 size={15} />
        </button>
      </div>
    </div>
  );
}

function EdgeInspector({ edges }: { edges: State['layout']['edges'] }) {
  const keys = edges.map((e) => e.key);
  const first = edges[0];
  const st = first.style;
  const s = useStore.getState();
  const setAttr = (k: string, v: string | undefined) => edit((src, d) => setEdgesAttr(src, d, keys, k, v));
  return (
    <>
      <div className="insp-head">
        <div className="insp-kind">
          <ArrowRight size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="insp-title">{edges.length === 1 ? '矢印' : `${edges.length} 本の矢印`}</div>
          <div className="insp-sub">
            {endText(first.def, 'from')} {first.def.op} {endText(first.def, 'to')}
          </div>
        </div>
      </div>
      {edges.length === 1 && (
        <div className="section">
          <div className="section-label">ラベル</div>
          <LiveText key={first.key} value={first.def.label} onChange={(v) => edit((src, d) => setEdgeLabel(src, d, first.key, v))} placeholder="（なし）" />
        </div>
      )}
      <div className="section">
        <div className="section-label">向き</div>
        <Seg<ArrowOp>
          value={first.def.op}
          onChange={(op) => {
            s.apply((src, d) => setEdgesOp(src, d, keys, op));
          }}
          options={[
            { v: '->', label: <ArrowRight size={15} />, tip: '->' },
            { v: '<-', label: <ArrowLeft size={15} />, tip: '<-' },
            { v: '<->', label: <ArrowLeftRight size={15} />, tip: '<->' },
            { v: '--', label: <Minus size={15} />, tip: '--' },
          ]}
        />
      </div>
      <div className="section">
        <div className="section-label">経路</div>
        <Seg
          value={st.route === 'straight' && st.bend !== 0 ? 'curve' : st.route}
          onChange={(r) => {
            s.apply((src, d) => {
              let out = setEdgesAttr(src, d, keys, 'route', r === 'straight' ? undefined : r);
              out = setEdgesAttr(out, reparse(out), keys, 'bend', undefined);
              return out;
            });
          }}
          options={[
            { v: 'straight', label: '直線' },
            { v: 'curve', label: '曲線' },
            { v: 'ortho', label: '直角' },
          ]}
        />
        {(st.route === 'curve' || st.bend !== 0) && st.route !== 'ortho' && (
          <div className="row" style={{ marginTop: 10 }}>
            <label>曲がり</label>
            <input className="slider" type="range" min={-200} max={200} step={5} value={st.bend} onChange={(e) => setAttr('bend', e.target.value)} onPointerDown={() => s.beginGesture()} onPointerUp={() => s.endGesture()} />
            <span className="val">{st.bend}</span>
          </div>
        )}
      </div>
      <div className="section">
        <div className="section-label">線</div>
        <Swatches colors={STROKES} value={st.stroke} onChange={(c) => setAttr('stroke', c)} />
        <div className="row" style={{ marginTop: 10 }}>
          <input className="slider" type="range" min={0.5} max={6} step={0.25} value={st.lw} onChange={(e) => setAttr('lw', e.target.value)} onPointerDown={() => s.beginGesture()} onPointerUp={() => s.endGesture()} />
          <span className="val">{st.lw}px</span>
        </div>
        <Seg
          small
          value={st.dash}
          onChange={(v) => setAttr('dash', v === 'solid' ? undefined : v)}
          options={[
            { v: 'solid', label: <DashIcon d="solid" />, tip: '実線' },
            { v: 'dashed', label: <DashIcon d="dashed" />, tip: '破線' },
            { v: 'dotted', label: <DashIcon d="dotted" />, tip: '点線' },
          ]}
        />
      </div>
      {edges.length === 1 && (first.free.from || first.free.to) && (
        <div className="section">
          <div className="section-label">端点（座標）</div>
          {(['from', 'to'] as const).map((which) => {
            const pt = which === 'from' ? first.def.fromPt : first.def.toPt;
            if (!pt) return null;
            const write = (x: number, y: number) => edit((src, d) => setEdgeEnds(src, d, [{ key: first.key, which, end: pointText(x, y, pt.rel) }]));
            return (
              <div key={which} className="row" title={pt.rel ? 'もう一方の端からの相対位置 +(dx, dy)' : '絶対座標 (x, y)'}>
                <label style={{ width: 44 }}>{which === 'from' ? '始点' : '終点'}</label>
                <div className="num-grid" style={{ flex: 1 }}>
                  <NumField label={pt.rel ? 'dX' : 'X'} value={pt.x} onChange={(v) => write(v, pt.y)} onScrubStart={() => s.beginGesture()} onScrubEnd={() => s.endGesture()} />
                  <NumField label={pt.rel ? 'dY' : 'Y'} value={pt.y} onChange={(v) => write(pt.x, v)} onScrubStart={() => s.beginGesture()} onScrubEnd={() => s.endGesture()} />
                </div>
              </div>
            );
          })}
          <div className="hint-text">端点をドラッグで移動、図形の上で離すと接続します。</div>
        </div>
      )}
      {edges.length === 1 && (
        <div className="section">
          <div className="section-label">警告</div>
          <IgnoreRow item={{ kind: 'edge', key: first.key }} attrs={first.def.attrs} />
        </div>
      )}
    </>
  );
}

function DashIcon({ d }: { d: 'solid' | 'dashed' | 'dotted' }) {
  return (
    <svg width={28} height={10} viewBox="0 0 28 10">
      <line x1={2} y1={5} x2={26} y2={5} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray={d === 'dashed' ? '6 4' : d === 'dotted' ? '0.1 4' : undefined} />
    </svg>
  );
}

const SETTING_INFO: { key: 'gap' | 'grid' | 'padding' | 'fontmin' | 'fontmax'; label: string; hint: string; min: number }[] = [
  { key: 'gap', label: '最小間隔', hint: '図形同士がこれより近いと警告', min: 0 },
  { key: 'grid', label: 'グリッド', hint: 'ドラッグ時のスナップ間隔（0 で無効）', min: 0 },
  { key: 'padding', label: '内側余白', hint: '図形の枠と文字の間の余白', min: 0 },
  { key: 'fontmin', label: '最小文字', hint: 'これでも収まらなければ「はみ出し」', min: 4 },
  { key: 'fontmax', label: '最大文字', hint: '自動調整の上限サイズ', min: 6 },
];

/** The page (or layout) on the canvas: its title, id and layout. */
function DeckSection({ doc }: { doc: Doc }) {
  const deck = doc.deck!;
  const view = deck.view;
  if ('layout' in view) {
    const lay = deck.layouts.find((l) => l.name === view.layout)!;
    return (
      <div className="section">
        <div className="section-label">レイアウト {lay.name}</div>
        <div className="hint-text">
          ここで置いた図形はこのレイアウトを使う全ページに出ます。slot はページが中身を入れる枠です（例: <code>slot title at (40, 30) size 1200x70</code>、ページ側は <code>title "見出し"</code>）。
          {lay.extends ? ` 親 ${lay.extends} の図形は薄く表示され、ここでは動かせません。` : ''}
        </div>
      </div>
    );
  }
  const page = deck.pages.find((p) => p.id === view.page)!;
  const index = deck.pages.indexOf(page);
  const header = (h: Parameters<typeof setPageHeader>[3]) => edit((src, d) => setPageHeader(src, d, page.id, h));
  const written = useStore.getState().src.slice(page.header.from, page.header.to).includes('layout=');
  return (
    <div className="section">
      <div className="section-label">
        ページ {index + 1} / {deck.pages.length}
      </div>
      <div className="row">
        <label style={{ width: 64 }}>名前</label>
        <LiveText key={page.id} value={page.label} placeholder={page.id} onChange={(v) => header({ label: v })} />
      </div>
      <div className="row">
        <label style={{ width: 64 }}>ID</label>
        <input
          key={page.id}
          className="field"
          defaultValue={page.id}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v === page.id) return;
            if (!isValidId(v) || deck.pages.some((p) => p.id === v)) {
              e.target.value = page.id;
              useStore.getState().notify('使えない ID です（英数字・重複なし）', 'warn');
              return;
            }
            header({ id: v });
            useStore.getState().setPage({ page: v }, { fit: false });
          }}
        />
      </div>
      <div className="row">
        <label style={{ width: 64 }}>レイアウト</label>
        <select className="field" value={written ? (page.layout ?? '') : ''} onChange={(e) => header({ layout: e.target.value || undefined })}>
          <option value="">{deck.layouts.some((l) => l.name === 'default') ? '既定（default）' : 'なし'}</option>
          {deck.layouts.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {deck.placeholders.length > 0 && <div className="hint-text">空のスロット（{deck.placeholders.map((p) => p.id).join(', ')}）はキャンバスの点線枠をダブルクリックで埋められます。</div>}
    </div>
  );
}

function DocInspector({ doc }: { doc: Doc }) {
  const s = useStore.getState();
  const issues = useStore((st) => st.issues);
  const kinds = new Map<string, number>();
  for (const n of doc.nodes) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
  return (
    <div className="inspector">
      <div className="insp-head">
        <div className="insp-kind">
          <ShapeIcon kind="round" size={16} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="insp-title">ドキュメント</div>
          <div className="insp-sub">
            {doc.nodes.length} shapes · {doc.edges.length} arrows · {doc.styles.size} styles
          </div>
        </div>
      </div>
      {doc.deck && <DeckSection doc={doc} />}
      <div className="section">
        <div className="section-label">制約とレイアウト（set 行）</div>
        {SETTING_INFO.map((it) => (
          <div key={it.key} className="row" title={it.hint}>
            <label style={{ width: 64 }}>{it.label}</label>
            <NumField label="px" value={doc.settings[it.key]} min={it.min} onChange={(v) => edit((src, d) => setSetting(src, d, it.key, v))} onScrubStart={() => s.beginGesture()} onScrubEnd={() => s.endGesture()} />
          </div>
        ))}
        <div className="hint-text">数値ラベル（px）を左右にドラッグでも調整できます。</div>
      </div>
      <div className="section">
        <div className="section-label">スタイル定義</div>
        {doc.styles.size === 0 && <div className="hint-text">style name {'{ fill: #...; }'} をテキストに書くと、.name で使えます。</div>}
        <div className="style-chips">
          {[...doc.styles.values()].map((st) => (
            <span key={st.name} className="style-chip" style={{ background: st.props.fill, borderColor: st.props.stroke, color: st.props.text }}>
              .{st.name}
            </span>
          ))}
        </div>
      </div>
      <div className="section">
        <div className="section-label">状態</div>
        <div className="stat-grid">
          <div>
            <b>{doc.nodes.length}</b>図形
          </div>
          <div>
            <b>{doc.edges.length}</b>矢印
          </div>
          <div className={issues.length ? 'bad' : 'good'}>
            <b>{issues.length}</b>問題
          </div>
        </div>
      </div>
      <div className="section">
        <div className="section-label">ヒント</div>
        <ul className="tips">
          <li>ダブルクリックで図形を追加・文字を編集</li>
          <li>図形にホバーして出る ● をドラッグで矢印</li>
          <li>何もない所で離すと、図形ごと追加して接続</li>
          <li>グループの中にドロップすると自動で in= が付きます</li>
        </ul>
      </div>
    </div>
  );
}
