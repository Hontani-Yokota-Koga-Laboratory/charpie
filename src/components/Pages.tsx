/**
 * Decks: the page strip (thumbnails, add / duplicate / reorder / delete, layouts),
 * the layout-edit banner and the full-screen slide show.
 */
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Copy, Ellipsis, LayoutTemplate, Play, Plus, Trash2, X } from 'lucide-react';
import { parse } from '../dsl/parse';
import { addPage, duplicatePage, movePage, removePage, setPageHeader, uniquePageId } from '../dsl/patch';
import { askConfirm } from './Dialog';
import { layoutDialog } from './NewFile';
import { sameView, type View } from '../dsl/types';
import { computeLayout, type Layout } from '../layout';
import { checkLayout } from '../check/check';
import { canvasMeasure } from '../text/fit';
import { assetHref } from '../images';
import { useStore } from '../store';
import { EdgeLabel, EdgeShape, ImageHrefContext, NodeShape } from './Diagram';

/** A page / layout rendered like the slide (white page, no editor chrome). */
export const SlideSvg = memo(function SlideSvg({ layout, className }: { layout: Layout; className?: string }) {
  const f = layout.frame ?? { x: 0, y: 0, w: 1280, h: 720 };
  return (
    <svg className={className} viewBox={`${f.x} ${f.y} ${f.w} ${f.h}`} preserveAspectRatio="xMidYMid meet">
      <rect x={f.x} y={f.y} width={f.w} height={f.h} fill="#ffffff" />
      {layout.nodes.map((n) => (
        <NodeShape key={n.id} n={n} />
      ))}
      {layout.edges.map((e) => (
        <EdgeShape key={e.key} e={e} />
      ))}
      {layout.edges.map((e) => (
        <EdgeLabel key={e.key} e={e} bg="#ffffff" />
      ))}
    </svg>
  );
});

interface Thumb {
  view: View;
  layout: Layout;
  errors: number;
}

/** Every page of the deck laid out (deferred: thumbnails may lag a keystroke behind). */
function usePageLayouts(): Thumb[] {
  const src = useDeferredValue(useStore((s) => s.src));
  // re-measured (fonts, embedded diagrams arriving) without a text change
  const measured = useStore((s) => s.measured);
  return useMemo(() => {
    const d = parse(src);
    return (d.deck?.pages ?? []).map((p) => {
      const doc = parse(src, { page: p.id });
      const layout = computeLayout(doc, canvasMeasure);
      return { view: { page: p.id }, layout, errors: checkLayout(doc, layout).filter((i) => i.severity === 'error').length };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, measured]);
}

export function PagesPanel() {
  const deck = useStore((s) => s.doc.deck);
  const wsFile = useStore((s) => (s.workspace.on ? s.workspace.file : null));
  const imageHref = useMemo(() => assetHref(wsFile), [wsFile]);
  const thumbs = usePageLayouts();
  const [menu, setMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // keep the current page in view
  const current = deck?.view;
  useEffect(() => {
    if (!current || !('page' in current)) return;
    listRef.current?.querySelector(`[data-page="${CSS.escape(current.page)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  if (!deck) return null;
  const s = useStore.getState;
  const go = (v: View) => s().setPage(v);
  const curPage = current && 'page' in current ? current.page : undefined;

  const add = () => {
    const st = s();
    const cur = st.doc.deck?.pages.find((p) => p.id === curPage);
    const id = uniquePageId(st.doc);
    const written = cur && /\slayout=/.test(st.src.slice(cur.header.from, cur.header.to));
    st.apply((src, doc) => addPage(src, doc, { id, layout: written ? cur.layout : undefined, after: curPage }));
    st.setPage({ page: id });
  };
  const act = (fn: (src: string) => string, then?: View) => {
    const st = s();
    st.apply((src) => fn(src));
    if (then) st.setPage(then);
    setMenu(null);
  };
  const full = (src: string) => parse(src);

  return (
    <aside className="pages-dock" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pages-head">
        <span className="pages-title">ページ</span>
        <span className="pages-count">{deck.pages.length}</span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn tip tip-bottom" data-tip="発表（F5）" onClick={() => s().setPresenting(true)}>
          <Play size={15} />
        </button>
        <button className="icon-btn tip tip-bottom" data-tip="ページを追加" onClick={add}>
          <Plus size={16} />
        </button>
      </div>
      <ImageHrefContext.Provider value={imageHref}>
        <div className="pages-list" ref={listRef}>
          {deck.pages.map((p, i) => {
            const t = thumbs.find((x) => 'page' in x.view && x.view.page === p.id);
            const on = p.id === curPage;
            return (
              <div
                key={p.id}
                data-page={p.id}
                className={'page-item' + (on ? ' on' : '') + (drag && drag.over === i && drag.id !== p.id ? ' drop' : '')}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', p.id);
                  setDrag({ id: p.id, over: i });
                }}
                onDragOver={(e) => {
                  if (!drag) return;
                  e.preventDefault();
                  if (drag.over !== i) setDrag({ ...drag, over: i });
                }}
                onDragEnd={() => setDrag(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag && drag.id !== p.id) act((src) => movePage(src, full(src), drag.id, i));
                  setDrag(null);
                }}
                onClick={() => go({ page: p.id })}
              >
                <div className="page-num">{i + 1}</div>
                <div className="page-body">
                  <div className="page-thumb">{t ? <SlideSvg layout={t.layout} /> : null}</div>
                  <div className="page-meta">
                    <span className="page-label" title={p.id}>
                      {p.label || p.id}
                    </span>
                    {p.layout && <span className="page-layout">{p.layout}</span>}
                    {!!t?.errors && <span className="page-errors">{t.errors}</span>}
                  </div>
                </div>
                <button
                  className="icon-btn page-more"
                  aria-label="ページの操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === p.id ? null : p.id);
                  }}
                >
                  <Ellipsis size={14} />
                </button>
                {menu === p.id && (
                  <div className="float menu page-menu" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="menu-item"
                      onClick={() => {
                        const id = uniquePageId(s().doc);
                        act((src) => duplicatePage(src, full(src), p.id, id), { page: id });
                      }}
                    >
                      <Copy size={14} /> 複製
                    </button>
                    <button className="menu-item" disabled={i === 0} onClick={() => act((src) => movePage(src, full(src), p.id, i - 1))}>
                      <ChevronUp size={14} /> 上へ
                    </button>
                    <button className="menu-item" disabled={i === deck.pages.length - 1} onClick={() => act((src) => movePage(src, full(src), p.id, i + 1))}>
                      <ChevronDown size={14} /> 下へ
                    </button>
                    <div className="menu-sep" />
                    <div className="menu-label">レイアウト</div>
                    {[undefined, ...deck.layouts.map((l) => l.name)].map((name) => (
                      <button key={name ?? '-'} className={'menu-item' + ((p.layout ?? undefined) === name ? ' checked' : '')} onClick={() => act((src) => setPageHeader(src, full(src), p.id, { layout: name }))}>
                        <LayoutTemplate size={14} /> {name ?? (deck.layouts.some((l) => l.name === 'default') ? '既定（default）' : 'なし')}
                      </button>
                    ))}
                    <div className="menu-sep" />
                    <button
                      className="menu-item danger"
                      disabled={deck.pages.length <= 1}
                      onClick={async () => {
                        setMenu(null);
                        if (!(await askConfirm({ title: `ページ「${p.label || p.id}」を削除しますか？`, message: 'Ctrl+Z で戻せます。', ok: '削除', danger: true }))) return;
                        const next = deck.pages[i + 1] ?? deck.pages[i - 1];
                        act((src) => removePage(src, full(src), p.id), next && { page: next.id });
                      }}
                    >
                      <Trash2 size={14} /> 削除
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ImageHrefContext.Provider>
      <div className="pages-head layouts-head">
        <span className="pages-title">レイアウト</span>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn tip tip-bottom"
          data-tip="レイアウトを追加"
          onClick={async () => {
            const name = await layoutDialog();
            if (name) s().setPage({ layout: name });
          }}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="layouts-list">
        {deck.layouts.map((l) => {
          const uses = deck.pages.filter((p) => p.layout === l.name).length;
          return (
            <button key={l.name} className={'layout-item' + (current && 'layout' in current && current.layout === l.name ? ' on' : '')} onClick={() => go({ layout: l.name })} title="クリックでレイアウトを編集">
              <LayoutTemplate size={14} />
              <span className="layout-name">{l.name}</span>
              {l.extends && <span className="layout-ext">← {l.extends}</span>}
              <span className="layout-uses">{uses}</span>
            </button>
          );
        })}
        {!deck.layouts.length && <div className="layouts-empty">共通部分（ロゴ・ページ番号・タイトル枠）はレイアウトに書くと全ページに出ます</div>}
      </div>
    </aside>
  );
}

/** Shown while a layout is on the canvas: edits there change every page that uses it. */
export function LayoutBanner() {
  const deck = useStore((s) => s.doc.deck);
  if (!deck || !('layout' in deck.view)) return null;
  const name = deck.view.layout;
  const users = deck.pages.filter((p) => p.layout === name || deck.layouts.some((l) => l.extends === name && l.name === p.layout));
  const back = users[0] ?? deck.pages[0];
  return (
    <div className="float layout-banner">
      <LayoutTemplate size={15} />
      <span>
        レイアウト <b>{name}</b> を編集中 — {users.length} ページに反映されます
      </span>
      {back && (
        <button className="btn" onClick={() => useStore.getState().setPage({ page: back.id })}>
          <ArrowLeft size={14} /> ページに戻る
        </button>
      )}
    </div>
  );
}

/** Full-screen slide show from the current page. */
export function Presenter() {
  const presenting = useStore((s) => s.presenting);
  const src = useStore((s) => s.src);
  const wsFile = useStore((s) => (s.workspace.on ? s.workspace.file : null));
  const imageHref = useMemo(() => assetHref(wsFile), [wsFile]);
  const rootRef = useRef<HTMLDivElement>(null);
  const pages = useMemo(() => (presenting ? (parse(src).deck?.pages ?? []) : []), [presenting, src]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!presenting) return;
    const st = useStore.getState();
    const v = st.doc.deck?.view;
    setIndex(Math.max(0, v && 'page' in v ? pages.findIndex((p) => p.id === v.page) : 0));
    rootRef.current?.requestFullscreen?.().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting]);

  const measured = useStore((s) => s.measured);
  const layout = useMemo(() => {
    const p = pages[index];
    return p ? computeLayout(parse(src, { page: p.id }), canvasMeasure) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, index, src, measured]);

  useEffect(() => {
    if (!presenting) return;
    const stop = () => {
      const p = pages[index];
      const st = useStore.getState();
      st.setPresenting(false);
      if (p && !sameView(st.doc.deck?.view, { page: p.id })) st.setPage({ page: p.id });
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    const onKey = (e: KeyboardEvent) => {
      const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(e.key);
      const prev = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(e.key);
      if (next || prev || e.key === 'Home' || e.key === 'End' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
      if (next) setIndex((i) => Math.min(pages.length - 1, i + 1));
      else if (prev) setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(pages.length - 1);
      else if (e.key === 'Escape') stop();
    };
    const onFs = () => {
      if (!document.fullscreenElement) stop();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, [presenting, pages, index]);

  if (!presenting) return null;
  return (
    <div
      className="presenter"
      ref={rootRef}
      onClick={(e) => setIndex((i) => (e.clientX < window.innerWidth / 3 ? Math.max(0, i - 1) : Math.min(pages.length - 1, i + 1)))}
    >
      <ImageHrefContext.Provider value={imageHref}>{layout && <SlideSvg layout={layout} className="presenter-slide" />}</ImageHrefContext.Provider>
      <div className="presenter-hud">
        {index + 1} / {pages.length}
        <button
          className="icon-btn"
          aria-label="発表を終了"
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
