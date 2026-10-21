/**
 * Large modal gallery of the workspace's .charpie files: thumbnails (rendered by `/api/export`),
 * the first `# comment` as a title, folders that expand / collapse, search over names and contents,
 * and a big preview (Space) before opening.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ChevronDown, ChevronLeft, ChevronRight, FilePlus, Folder, FolderOpen, LayoutGrid, Maximize2, Presentation, Search, Shapes, Trash2, TriangleAlert, X } from 'lucide-react';
import { useStore } from '../store';
import { deleteFile, openFile } from '../remote';
import { askConfirm } from './Dialog';
import { newFileDialog } from './NewFile';
import './FileGallery.css';

export const useGallery = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

interface FileInfo {
  hash: string;
  title: string;
  src: string;
  nodes: number;
  edges: number;
  errors: number;
  /** pages of a slide deck; null for a diagram */
  pages: number | null;
}

// ── per-file info, kept across openings; a change on disk drops the entry
const infoStore = create<{ info: Record<string, FileInfo>; stale: Record<string, true> }>(() => ({ info: {}, stale: {} }));
const loading = new Set<string>();

async function loadInfo(file: string) {
  if (loading.has(file)) return;
  loading.add(file);
  try {
    const r = await fetch(`/api/doc?file=${encodeURIComponent(file)}`);
    if (!r.ok) return;
    const d = (await r.json()) as { hash: string; src: string; nodes: unknown[]; edges: unknown[]; issues: { severity: string }[]; deck?: { pages: unknown[] } };
    const info: FileInfo = { hash: d.hash, src: d.src, title: titleOf(d.src), nodes: d.nodes.length, edges: d.edges.length, errors: d.issues.filter((i) => i.severity === 'error').length, pages: d.deck ? d.deck.pages.length : null };
    infoStore.setState((s) => {
      const stale = { ...s.stale };
      delete stale[file];
      return { info: { ...s.info, [file]: info }, stale };
    });
  } catch {
    /* offline: keep what we had */
  } finally {
    loading.delete(file);
  }
}

async function loadAll(files: string[]) {
  const queue = [...files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) await loadInfo(f);
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

if (typeof window !== 'undefined') {
  window.addEventListener('charpie:file-change', (e) => {
    const { file } = (e as CustomEvent<{ file: string }>).detail;
    infoStore.setState((s) => ({ stale: { ...s.stale, [file]: true } }));
    if (useGallery.getState().open) loadInfo(file);
  });
}

/** First comment line = what the diagram is about. */
function titleOf(src: string): string {
  for (const line of src.split('\n').slice(0, 20)) {
    const m = /^#\s+(.+)/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
}

// ── recently opened (per browser)
const RECENT = 'charpie:recentFiles';
const COLLAPSED = 'charpie:gallery:collapsed';
const CARD = 'charpie:gallery:card';
const SORT = 'charpie:gallery:sort';
const KIND = 'charpie:gallery:kind';

type KindFilter = 'all' | 'diagram' | 'slides';

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

useStore.subscribe((s, prev) => {
  const f = s.workspace.file;
  if (f && f !== prev.workspace.file) writeJson(RECENT, { ...readJson<Record<string, number>>(RECENT, {}), [f]: Date.now() });
});

function ago(t: number | undefined): string {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'さっき開いた';
  if (m < 60) return `${m} 分前に開いた`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 時間前に開いた`;
  return `${Math.round(h / 24)} 日前に開いた`;
}

// ── folder tree
interface Dir {
  path: string; // '' = root, else 'a/b'
  name: string;
  dirs: Dir[];
  files: string[];
  count: number; // files below, recursively
  /** display order: by name a folder's files then its subfolders; by recency both interleaved */
  items: (string | Dir)[];
}

function buildTree(files: string[], order: (a: string, b: string) => number, byName: boolean): Dir {
  const root: Dir = { path: '', name: '', dirs: [], files: [], count: 0, items: [] };
  for (const f of files) {
    const parts = f.split('/');
    let d = root;
    d.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let sub = d.dirs.find((x) => x.path === path);
      if (!sub) d.dirs.push((sub = { path, name: parts[i], dirs: [], files: [], count: 0, items: [] }));
      sub.count++;
      d = sub;
    }
    d.files.push(f);
  }
  // by name: folders alphabetically; by recency: a folder sits where its most recent file would
  const head = (d: Dir): string => [...d.files, ...d.dirs.map(head)].sort(order)[0];
  const sort = (d: Dir) => {
    d.files.sort(order);
    d.dirs.forEach(sort);
    d.dirs.sort((a, b) => (byName ? a.name.localeCompare(b.name) : order(head(a), head(b))));
    const key = (x: string | Dir) => (typeof x === 'string' ? x : head(x));
    d.items = byName ? [...d.files, ...d.dirs] : [...d.files, ...d.dirs].sort((a, b) => order(key(a), key(b)));
  };
  sort(root);
  return root;
}

/** Files in display order, skipping collapsed folders. */
function flatten(d: Dir, collapsed: Set<string>, all: boolean): string[] {
  const out: string[] = [];
  for (const x of d.items) {
    if (typeof x === 'string') out.push(x);
    else if (all || !collapsed.has(x.path)) out.push(...flatten(x, collapsed, all));
  }
  return out;
}

/** Runs of consecutive files share one grid; folders break the run. */
function runs(d: Dir): (string[] | Dir)[] {
  const out: (string[] | Dir)[] = [];
  for (const x of d.items) {
    if (typeof x !== 'string') out.push(x);
    else if (Array.isArray(out[out.length - 1])) (out[out.length - 1] as string[]).push(x);
    else out.push([x]);
  }
  return out;
}

const baseName = (f: string) => f.split('/').pop()!.replace(/\.charpie$/, '');

export function FileGallery() {
  const open = useGallery((g) => g.open);
  const setOpen = useGallery((g) => g.setOpen);
  const workspace = useStore((s) => s.workspace);

  useEffect(() => {
    if (!workspace.on) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setOpen(!useGallery.getState().open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspace.on, setOpen]);

  if (!open || !workspace.on) return null;
  return createPortal(<GalleryModal onClose={() => setOpen(false)} />, document.body);
}

function GalleryModal({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const files = workspace.files;
  const { info, stale } = infoStore();
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<'name' | 'recent'>(() => readJson(SORT, 'recent'));
  const [kind, setKindState] = useState<KindFilter>(() => readJson(KIND, 'all'));
  const setKind = (v: KindFilter) => (setKindState(v), writeJson(KIND, v));
  const [card, setCardState] = useState<number>(() => readJson(CARD, 300));
  const [collapsed, setCollapsedState] = useState<Set<string>>(() => new Set(readJson<string[]>(COLLAPSED, [])));
  const [preview, setPreview] = useState<string | null>(null);
  const recent = useMemo(() => readJson<Record<string, number>>(RECENT, {}), []);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const setSort = (v: 'name' | 'recent') => (setSortState(v), writeJson(SORT, v));
  const setCard = (v: number) => (setCardState(v), writeJson(CARD, v));
  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsedState(next);
    writeJson(COLLAPSED, [...next]);
  };

  // load what is missing / changed; the open file may have been saved from this tab (no echo event)
  useEffect(() => {
    const st = infoStore.getState();
    const need = files.filter((f) => !st.info[f] || st.stale[f] || f === workspace.file);
    loadAll(need);
  }, [files.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const isKind = (f: string, k: KindFilter) => k === 'all' || (!!info[f] && (info[f].pages !== null) === (k === 'slides'));
  const count = (k: KindFilter) => files.filter((f) => isKind(f, k)).length;
  const matches = (f: string) => {
    if (!isKind(f, kind)) return false;
    if (!q) return true;
    const i = info[f];
    return q.split(/\s+/).every((w) => f.toLowerCase().includes(w) || (!!i && (i.title.toLowerCase().includes(w) || i.src.toLowerCase().includes(w))));
  };
  const visible = files.filter(matches);
  const order = (a: string, b: string) => (sort === 'recent' ? (recent[b] ?? 0) - (recent[a] ?? 0) || a.localeCompare(b) : a.localeCompare(b));
  const tree = buildTree(visible, order, sort === 'name');
  const flat = flatten(tree, collapsed, !!q);

  const go = async (f: string) => {
    onClose();
    if (f !== workspace.file) await openFile(f);
  };

  const remove = async (f: string) => {
    const i = info[f];
    const current = f === workspace.file;
    // other files that draw this one (image src="….charpie")
    const users = files.filter((g) => g !== f && info[g]?.src.includes(baseName(f) + '.charpie'));
    const what = i?.pages != null ? `スライド（${i.pages} ページ）` : '図';
    const ok = await askConfirm({
      title: `「${baseName(f)}」を削除しますか？`,
      message: (
        <>
          {f} （{what}）をワークスペースの <code>.trash/</code> に移動します。直後のトーストの「元に戻す」か、<code>.trash/</code> から取り出せば戻せます。
          {current && workspace.dirty && (
            <>
              <br />
              <b>このファイルには未保存の編集があります。</b>削除すると失われます。
            </>
          )}
          {users.length > 0 && (
            <>
              <br />
              このファイルを埋め込んでいる図があります: {users.map(baseName).join('、')}
            </>
          )}
        </>
      ),
      ok: '削除',
      danger: true,
    });
    if (!ok) return;
    if (preview === f) setPreview(null);
    await deleteFile(f, i?.hash);
  };

  const newFile = async (dir: string) => {
    onClose();
    await newFileDialog(dir, kind === 'slides' ? 'slides' : kind === 'diagram' ? 'diagram' : undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (preview) setPreview(null);
      else onClose();
      return;
    }
    if (preview && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const i = flat.indexOf(preview);
      const n = flat[(i + (e.key === 'ArrowRight' ? 1 : -1) + flat.length) % flat.length];
      if (n) setPreview(n);
      return;
    }
    if (preview && e.key === 'Enter') {
      e.preventDefault();
      go(preview);
      return;
    }
    if (preview && e.key === ' ') {
      e.preventDefault();
      setPreview(null);
    }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && flat[0]) {
      e.preventDefault();
      go(flat[0]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      bodyRef.current?.querySelector<HTMLElement>('.gal-card')?.focus();
    }
  };

  // arrow keys move between cards by their position on screen
  const onCardKey = (e: React.KeyboardEvent, f: string) => {
    if (e.key === ' ') {
      e.preventDefault();
      setPreview(f);
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      remove(f);
      return;
    }
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const cards = [...(bodyRef.current?.querySelectorAll<HTMLElement>('.gal-card') ?? [])];
    const cur = e.currentTarget.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (const c of cards) {
      if (c === e.currentTarget) continue;
      const r = c.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      const ok = e.key === 'ArrowRight' ? dx > 4 && Math.abs(dy) < cur.height / 2 : e.key === 'ArrowLeft' ? dx < -4 && Math.abs(dy) < cur.height / 2 : e.key === 'ArrowDown' ? dy > 4 : dy < -4;
      if (!ok) continue;
      const d = Math.abs(dx) + Math.abs(dy) * 2;
      if (d < bestD) (bestD = d), (best = c);
    }
    if (best) best.focus();
    else if (e.key === 'ArrowUp') searchRef.current?.focus();
  };

  const thumb = (f: string) => `/api/export?file=${encodeURIComponent(f)}&format=svg&v=${info[f]?.hash ?? ''}`;

  const renderCard = (f: string) => {
    const i = info[f];
    const current = f === workspace.file;
    return (
      <div
        key={f}
        className={'gal-card' + (current ? ' current' : '')}
        tabIndex={0}
        role="button"
        title={f}
        onClick={() => go(f)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go(f);
          else onCardKey(e, f);
        }}
      >
        <div className="gal-thumb">
          {i ? <Thumb src={thumb(f)} /> : <div className="gal-thumb-empty" />}
          <button
            className="gal-zoom"
            title="大きく見る（Space）"
            onClick={(e) => {
              e.stopPropagation();
              setPreview(f);
            }}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="gal-zoom gal-del"
            title="削除（Delete）"
            onClick={(e) => {
              e.stopPropagation();
              remove(f);
            }}
          >
            <Trash2 size={14} />
          </button>
          <div className="gal-badges">
            {i && i.pages !== null && (
              <span className="gal-badge slides">
                <Presentation size={11} /> スライド
              </span>
            )}
            {current && <span className="gal-badge accent">編集中</span>}
            {current && workspace.dirty && <span className="gal-badge warn">未保存</span>}
            {!!i?.errors && (
              <span className="gal-badge danger">
                <TriangleAlert size={11} /> {i.errors}
              </span>
            )}
          </div>
        </div>
        <div className="gal-meta">
          <div className="gal-name">{baseName(f)}</div>
          <div className="gal-title">{i?.title || ' '}</div>
          <div className="gal-sub">
            {!i ? '読み込み中…' : i.pages !== null ? `${i.pages} ページ` : `図形 ${i.nodes} · 矢印 ${i.edges}`}
            {recent[f] && <span>{ago(recent[f])}</span>}
          </div>
        </div>
      </div>
    );
  };

  const renderDir = (d: Dir): React.ReactNode => {
    const shut = !q && collapsed.has(d.path);
    const isRoot = d.path === '';
    const body = (
      <>
        {runs(d).map((r) =>
          Array.isArray(r) ? (
            <div key={'f:' + r[0]} className="gal-grid">
              {r.map(renderCard)}
            </div>
          ) : (
            renderDir(r)
          ),
        )}
      </>
    );
    if (isRoot) return body;
    return (
      <section key={d.path} className={'gal-dir' + (shut ? ' shut' : '')}>
        <div className="gal-dir-head">
          <button className="gal-dir-toggle" onClick={() => toggle(d.path)} aria-expanded={!shut}>
            <ChevronDown size={15} className="gal-chev" />
            {shut ? <Folder size={16} /> : <FolderOpen size={16} />}
            <span className="gal-dir-name">{d.name}</span>
            <span className="gal-dir-count">{d.count}</span>
          </button>
          <button className="gal-dir-add" title={`${d.path}/ に新規ファイル`} onClick={() => newFile(d.path)}>
            <FilePlus size={14} />
          </button>
        </div>
        {shut ? (
          <div className="gal-dir-peek" onClick={() => toggle(d.path)}>
            {flatten(d, new Set(), true)
              .slice(0, 6)
              .map((f) => (info[f] ? <img key={f} src={thumb(f)} alt="" loading="lazy" /> : <div key={f} className="gal-thumb-empty" />))}
          </div>
        ) : (
          <div className="gal-dir-body">{body}</div>
        )}
      </section>
    );
  };

  return (
    <div className="gal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div className="gal-modal" role="dialog" aria-label="ファイル一覧" style={{ '--card-w': `${card}px` } as React.CSSProperties}>
        <header className="gal-head">
          <div className="gal-head-title">
            <LayoutGrid size={17} />
            <span>ファイル</span>
            <span className="gal-root" title={workspace.root}>
              {workspace.root.split('/').slice(-2).join('/')} · {files.length} 件
            </span>
          </div>
          <label className="gal-search">
            <Search size={15} />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} placeholder="名前・説明・中身で検索（Enter で先頭を開く）" spellCheck={false} />
            {query && (
              <button onClick={() => setQuery('')} title="クリア">
                <X size={13} />
              </button>
            )}
          </label>
          <div className="gal-tools">
            <div className="gal-seg">
              {(
                [
                  ['all', 'すべて', null],
                  ['diagram', '図', <Shapes key="d" size={13} />],
                  ['slides', 'スライド', <Presentation key="s" size={13} />],
                ] as [KindFilter, string, JSX.Element | null][]
              ).map(([k, label, icon]) => (
                <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                  {icon} {label} <span className="gal-count">{count(k)}</span>
                </button>
              ))}
            </div>
            <div className="gal-seg">
              <button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>
                名前
              </button>
              <button className={sort === 'recent' ? 'on' : ''} onClick={() => setSort('recent')}>
                最近開いた
              </button>
            </div>
            <input className="gal-size" type="range" min={200} max={520} step={20} value={card} onChange={(e) => setCard(+e.target.value)} title="サムネイルの大きさ" />
            <button className="btn" onClick={() => newFile('')}>
              <FilePlus size={14} /> <span className="btn-label">新規</span>
            </button>
            <button className="gal-close" onClick={onClose} title="閉じる（Esc）">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="gal-body" ref={bodyRef}>
          {visible.length === 0 ? (
            <div className="gal-empty">
              {q ? `「${query}」に一致するファイルはありません` : kind === 'slides' ? 'スライドはまだありません' : kind === 'diagram' ? '図はまだありません' : '.charpie ファイルがありません'}
              {!q && kind !== 'all' && (
                <button className="btn" style={{ marginTop: 12 }} onClick={() => newFile('')}>
                  <FilePlus size={14} /> {kind === 'slides' ? 'スライドを作る' : '図を作る'}
                </button>
              )}
            </div>
          ) : (
            renderDir(tree)
          )}
        </div>

        <footer className="gal-foot">
          <span>
            <kbd>Enter</kbd> 開く
          </span>
          <span>
            <kbd>Space</kbd> 大きく見る
          </span>
          <span>
            <kbd>←</kbd>
            <kbd>→</kbd> 移動
          </span>
          <span>
            <kbd>Delete</kbd> 削除
          </span>
          <span>
            <kbd>Esc</kbd> 閉じる
          </span>
          <span>
            <kbd>Ctrl</kbd>
            <kbd>P</kbd> この一覧
          </span>
          {Object.keys(stale).length > 0 && <span className="gal-updating">更新を読み込み中…</span>}
        </footer>

        {preview && (
          <div className="gal-preview" onPointerDown={(e) => e.target === e.currentTarget && setPreview(null)}>
            <div className="gal-preview-box">
              <div className="gal-preview-head">
                <div>
                  <div className="gal-name">{preview}</div>
                  <div className="gal-title">{info[preview]?.title}</div>
                </div>
                <div className="gal-tools">
                  <button className="gal-close" title="前へ（←）" onClick={() => setPreview(flat[(flat.indexOf(preview) - 1 + flat.length) % flat.length])}>
                    <ChevronLeft size={18} />
                  </button>
                  <button className="gal-close" title="次へ（→）" onClick={() => setPreview(flat[(flat.indexOf(preview) + 1) % flat.length])}>
                    <ChevronRight size={18} />
                  </button>
                  <button className="gal-close" title="削除" onClick={() => remove(preview)}>
                    <Trash2 size={17} />
                  </button>
                  <button className="btn primary" onClick={() => go(preview)}>
                    開く <kbd>Enter</kbd>
                  </button>
                  <button className="gal-close" onClick={() => setPreview(null)} title="戻る（Esc）">
                    <X size={18} />
                  </button>
                </div>
              </div>
              <div className="gal-preview-img">{info[preview] ? <img src={thumb(preview)} alt={preview} /> : <div className="gal-thumb-empty" />}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <div className="gal-thumb-empty">プレビューできません</div>;
  return <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />;
}
