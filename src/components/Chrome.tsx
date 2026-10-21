import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleCheck,
  CircleQuestionMark,
  Code,
  Columns2,
  Copy,
  Download,
  FileCode,
  FilePlus,
  FolderOpen,
  Hand,
  Image,
  Moon,
  MousePointer2,
  PanelLeft,
  Redo2,
  Save,
  RotateCcw,
  Scan,
  ShieldCheck,
  Spline,
  Sun,
  TriangleAlert,
  Undo2,
  WandSparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useStore, type Tool, type ViewMode } from '../store';
import { IGNORE_NAME, ISSUE_LABEL } from '../check/check';
import { ignoreIssue, unignoreIssue } from '../actions';
import { autoFix } from '../check/resolve';
import { canvasMeasure } from '../text/fit';
import { download, exportPng, exportSvgStandalone, exportTikz, openFile, printPages, resetFileHandle, saveFile } from '../export';
import { createFile, flush, openFile as openRemoteFile, revert, save as saveRemote } from '../remote';
import { Bot, Ellipsis, EyeOff, Layers, Radio, SlidersHorizontal } from 'lucide-react';
import { useMobile } from '../useMobile';
import { pickImages } from '../images';
import { fitView } from './Canvas';
import { ShapeIcon, SHAPE_NAMES } from './ui';
import { FileGallery, useGallery } from './FileGallery';
import { FileDown, LayoutGrid, Presentation } from 'lucide-react';
import { parse } from '../dsl/parse';
import { toDeck } from '../dsl/patch';
import { computeLayout } from '../layout';
import type { ShapeKind } from '../dsl/types';

export function BrandMark() {
  return (
    <div className="brand-mark">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1" y="1.5" width="8" height="6" rx="1.8" fill="white" />
        <rect x="7" y="8.5" width="8" height="6" rx="1.8" fill="white" fillOpacity="0.65" />
        <path d="M5 7.5v3.5h2" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </div>
  );
}

function useClickOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    window.addEventListener('pointerdown', h);
    return () => window.removeEventListener('pointerdown', h);
  }, [open, close]);
  return ref;
}

export async function doSave(saveAs = false) {
  const s = useStore.getState();
  if (s.workspace.on && !saveAs) {
    if (s.autoSave) {
      await flush();
      s.notify(`${s.workspace.file} に保存済み（自動保存）`, 'ok');
    } else if (!s.workspace.dirty) s.notify('変更はありません');
    else if (await saveRemote()) s.notify(`${s.workspace.file} に保存しました`, 'ok');
    return;
  }
  const name = await saveFile(s.fileName, s.src, saveAs);
  if (name) {
    s.setFileName(name);
    s.notify(`${name} を保存しました`, 'ok');
  }
}

export async function doOpen() {
  if (useStore.getState().workspace.on) {
    window.dispatchEvent(new CustomEvent('charpie:file-menu'));
    return;
  }
  const r = await openFile();
  if (!r) return;
  const s = useStore.getState();
  s.setSource(r.text);
  s.setFileName(r.name);
  s.clearSelection();
  const el = document.querySelector('.canvas') as SVGSVGElement | null;
  if (el) {
    const b = el.getBoundingClientRect();
    s.setView(fitView(useStore.getState().layout, b.width, b.height));
  }
  s.notify(`${r.name} を開きました`, 'ok');
}

export function claudePrompt() {
  const s = useStore.getState();
  const base = `${location.origin}/api`;
  return [
    `図の編集には Charpie を使っています（${s.workspace.root} の *.charpie。ブラウザで ${location.origin} を開いて同期中）。`,
    `まず \`curl -s ${base}\` で API と .charpie 記法の説明を読んでください。`,
    `- 図の作成・大きな変更: .charpie ファイルを直接編集してOK（ブラウザに即反映）`,
    `- 状態の確認: \`curl -s ${base}/issues\`（重なり・はみ出し等）, \`curl -s ${base}/selection\`（私が選択中の図形）`,
    `- 細かい操作: \`curl -s -X POST ${base}/ops -d '{"op":"fix"}'\` など`,
    `編集後は必ず issues を確認し、errors を 0 にしてください。現在開いているファイル: ${s.workspace.file ?? '(なし)'}`,
  ].join('\n');
}

export function TopBar({ onHelp }: { onHelp: () => void }) {
  const fileName = useStore((s) => s.fileName);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const viewMode = useStore((s) => s.viewMode);
  const workspace = useStore((s) => s.workspace);
  const autoSave = useStore((s) => s.autoSave);
  const mobile = useMobile();
  const [menu, setMenu] = useState<null | 'file' | 'export'>(null);
  const close = () => setMenu(null);
  const ref = useClickOutside(menu !== null, close);
  const s = useStore.getState();
  useEffect(() => {
    const h = () => setMenu('file');
    window.addEventListener('charpie:file-menu', h);
    return () => window.removeEventListener('charpie:file-menu', h);
  }, []);

  const copyText = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.notify(`${what}をコピーしました`, 'ok');
    } catch {
      s.notify('クリップボードにアクセスできませんでした', 'warn');
    }
  };
  const base = fileName.replace(/\.[^.]+$/, '') || 'diagram';
  const isDeck = useStore((st) => !!st.doc.deck);

  return (
    <header className="topbar" ref={ref}>
      <div className="brand">
        <BrandMark />
        <span className="brand-name">Charpie</span>
      </div>
      {workspace.on ? (
        <>
          <div className={'live-pill ' + workspace.status} title={`${workspace.root}\nこのフォルダの .charpie と同期中${autoSave ? '（自動保存）' : '（保存ボタン / Ctrl+S で書き込み）'}`}>
            <Radio size={13} />
            <span className="btn-label">{workspace.status === 'offline' ? 'OFFLINE' : workspace.status === 'saving' ? 'SAVING' : 'LIVE'}</span>
          </div>
          {!autoSave && workspace.file && (
            <button
              className={'btn save-btn' + (workspace.dirty ? ' dirty' : '') + (workspace.conflict ? ' conflict' : '')}
              disabled={!workspace.dirty}
              title={workspace.conflict ? 'ファイルが外部でも変更されています。保存時に上書きを確認します' : workspace.dirty ? 'ディスクに書き込む（Ctrl+S）' : '保存済み'}
              onClick={() => doSave()}
            >
              <Save size={14} />
              <span className="btn-label">{workspace.conflict ? '保存（競合）' : workspace.dirty ? '保存' : '保存済み'}</span>
            </button>
          )}
        </>
      ) : (
        <input className="file-name" value={fileName} onChange={(e) => s.setFileName(e.target.value)} spellCheck={false} />
      )}

      <div className="menu-wrap">
        {workspace.on ? (
          <div className="file-split">
            <button className="btn" title="ファイル一覧（Ctrl+P）" onClick={() => (close(), useGallery.getState().setOpen(true))}>
              <LayoutGrid size={14} /> <span className="mono-name">{workspace.file ?? 'ファイル'}</span>
            </button>
            <button className="btn" title="その他" onClick={() => setMenu(menu === 'file' ? null : 'file')}>
              <ChevronDown size={13} />
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setMenu(menu === 'file' ? null : 'file')}>
            ファイル <ChevronDown size={13} />
          </button>
        )}
        {menu === 'file' && workspace.on && (
          <div className="float menu" style={{ left: 0, right: 'auto', minWidth: 300 }}>
            <div className="menu-label" title={workspace.root}>
              {workspace.root.split('/').slice(-2).join('/')}
            </div>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                const name = prompt('新しいファイル名（.charpie）', 'untitled');
                if (!name) return;
                const f = await createFile(name);
                if (f) openRemoteFile(f);
              }}
            >
              <FilePlus size={15} /> 新規ファイル…
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => s.setAutoSave(!autoSave)}>
              <input type="checkbox" readOnly checked={autoSave} style={{ margin: 0 }} /> 自動保存（変更をすぐディスクへ）
            </button>
            {workspace.dirty && !autoSave && (
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  if (confirm(workspace.conflict ? '未保存の変更を捨てて、外部で更新された版を読み込みますか？（Ctrl+Z で戻せます）' : '未保存の変更を破棄しますか？（Ctrl+Z で戻せます）')) revert();
                }}
              >
                <RotateCcw size={15} /> {workspace.conflict ? '外部の版を読み込む（未保存の変更を破棄）' : '未保存の変更を破棄'}
              </button>
            )}
            <button
              className="menu-item"
              onClick={() => {
                close();
                copyText(claudePrompt(), 'Claude 用の説明');
              }}
            >
              <Bot size={15} /> Claude Code への指示をコピー
            </button>
          </div>
        )}
        {menu === 'file' && !workspace.on && (
          <div className="float menu" style={{ left: 0, right: 'auto' }}>
            <button
              className="menu-item"
              onClick={() => {
                close();
                s.apply(() => '# 新しい図\nset gap=12 grid=10\n\n');
                s.setFileName('untitled.charpie');
                resetFileHandle();
              }}
            >
              <FilePlus size={15} /> 新規
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                doOpen();
              }}
            >
              <FolderOpen size={15} /> 開く… <span className="hint">Ctrl O</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                doSave();
              }}
            >
              <Save size={15} /> 保存 <span className="hint">Ctrl S</span>
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                doSave(true);
              }}
            >
              <Save size={15} /> 名前を付けて保存…
            </button>
          </div>
        )}
      </div>

      <div className="spacer hide-mobile" />

      <div className="seg">
        {(
          [
            ['canvas', <PanelLeft size={14} key="a" />, 'キャンバス'],
            ['split', <Columns2 size={14} key="b" />, '分割'],
            ['code', <Code size={14} key="c" />, 'テキスト'],
          ] as [ViewMode, JSX.Element, string][]
        ).map(([m, icon, label]) => (
          <button key={m} className={(viewMode === m || (m === 'canvas' && viewMode === 'split' && mobile) ? 'on ' : '') + (m === 'split' ? 'hide-mobile' : '')} onClick={() => s.setViewMode(m)}>
            {icon}
            <span className="seg-label">{label}</span>
          </button>
        ))}
      </div>

      <div className="spacer" />

      <button className="icon-btn tip tip-bottom" data-tip="元に戻す  Ctrl+Z" disabled={!canUndo} onClick={() => s.undo()}>
        <Undo2 size={16} />
      </button>
      <button className="icon-btn tip tip-bottom hide-mobile" data-tip="やり直す  Ctrl+Shift+Z" disabled={!canRedo} onClick={() => s.redo()}>
        <Redo2 size={16} />
      </button>
      <div className="divider-v hide-mobile" />
      <button className="icon-btn tip tip-bottom hide-mobile" data-tip="テーマ切替" onClick={() => s.setTheme(theme === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="icon-btn tip tip-bottom hide-mobile" data-tip="ヘルプ・DSLリファレンス  ?" onClick={onHelp}>
        <CircleQuestionMark size={16} />
      </button>

      <div className="menu-wrap">
        <button className={mobile ? 'icon-btn' : 'btn primary'} aria-label="メニュー" onClick={() => setMenu(menu === 'export' ? null : 'export')}>
          {mobile ? <Ellipsis size={18} /> : <Download size={14} />} <span className="btn-label">エクスポート</span> <ChevronDown size={13} className="hide-mobile" />
        </button>
        {menu === 'export' && (
          <div className="float menu">
            {mobile && (
              <>
                <button
                  className="menu-item"
                  disabled={!canRedo}
                  style={{ opacity: canRedo ? 1 : 0.4 }}
                  onClick={() => {
                    close();
                    s.redo();
                  }}
                >
                  <Redo2 size={15} /> やり直す
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    close();
                    s.setTheme(theme === 'dark' ? 'light' : 'dark');
                  }}
                >
                  {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {theme === 'dark' ? 'ライトテーマ' : 'ダークテーマ'}
                </button>
                <button
                  className="menu-item"
                  onClick={() => {
                    close();
                    onHelp();
                  }}
                >
                  <CircleQuestionMark size={15} /> ヘルプ・記法
                </button>
                <div className="menu-sep" />
              </>
            )}
            <div className="menu-label">スライド</div>
            {isDeck ? (
              <>
                <button
                  className="menu-item"
                  onClick={() => {
                    close();
                    s.setPresenting(true);
                  }}
                >
                  <Presentation size={15} /> 発表 <span className="hint">F5</span>
                </button>
                <button
                  className="menu-item"
                  onClick={async () => {
                    close();
                    const st = useStore.getState();
                    const layouts = (st.doc.deck?.pages ?? []).map((p) => computeLayout(parse(st.src, { page: p.id }), canvasMeasure));
                    await printPages(layouts, base);
                  }}
                >
                  <FileDown size={15} /> PDF（全ページ・印刷から保存）
                </button>
              </>
            ) : (
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  s.apply((src, doc) => toDeck(src, doc));
                  s.notify('1 ページのスライドにしました（左のパネルでページを追加）');
                }}
              >
                <Presentation size={15} /> スライドにする（page で囲む）
              </button>
            )}
            <div className="menu-sep" />
            <div className="menu-label">テキスト</div>
            <button
              className="menu-item"
              onClick={() => {
                close();
                copyText(useStore.getState().src, 'テキスト');
              }}
            >
              <Copy size={15} /> テキストをコピー
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                download(`${base}.charpie`, useStore.getState().src);
              }}
            >
              <FileCode size={15} /> .charpie をダウンロード
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                copyText(exportTikz(useStore.getState().layout), 'TikZ');
              }}
            >
              <FileCode size={15} /> TikZ をコピー
            </button>
            <button
              className="menu-item"
              onClick={() => {
                close();
                download(`${base}.tex`, exportTikz(useStore.getState().layout));
              }}
            >
              <FileCode size={15} /> TikZ (.tex) をダウンロード
            </button>
            <div className="menu-sep" />
            <div className="menu-label">画像</div>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                download(`${base}.svg`, await exportSvgStandalone(useStore.getState().layout), 'image/svg+xml');
              }}
            >
              <Image size={15} /> SVG
            </button>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                download(`${base}-transparent.svg`, await exportSvgStandalone(useStore.getState().layout, null), 'image/svg+xml');
              }}
            >
              <Image size={15} /> SVG（背景なし）
            </button>
            <button
              className="menu-item"
              onClick={async () => {
                close();
                try {
                  download(`${base}.png`, await exportPng(useStore.getState().layout, 2));
                } catch (e) {
                  s.notify((e as Error).message, 'warn');
                }
              }}
            >
              <Image size={15} /> PNG (2x)
            </button>
          </div>
        )}
      </div>
      <FileGallery />
    </header>
  );
}

const TOOLS: { t: Tool; key: string; icon: JSX.Element; name: string }[] = [
  { t: 'select', key: 'V', icon: <MousePointer2 size={17} />, name: '選択' },
  { t: 'pan', key: 'H', icon: <Hand size={17} />, name: '手のひら' },
  { t: 'edge', key: 'A', icon: <Spline size={17} />, name: '矢印' },
];
export const SHAPE_TOOLS: { t: ShapeKind; key: string }[] = [
  { t: 'rect', key: 'R' },
  { t: 'round', key: 'U' },
  { t: 'ellipse', key: 'O' },
  { t: 'diamond', key: 'D' },
  { t: 'trap', key: 'P' },
  { t: 'para', key: 'L' },
  { t: 'hex', key: 'X' },
  { t: 'text', key: 'T' },
];
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries([...TOOLS.map((t) => [t.key.toLowerCase(), t.t]), ...SHAPE_TOOLS.map((t) => [t.key.toLowerCase(), t.t])]);

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const multi = useStore((s) => s.multiSelect);
  const mobile = useMobile();
  return (
    <div className="float toolbar" onPointerDown={(e) => e.stopPropagation()}>
      {mobile && (
        <>
          <button className={'tool-btn' + (multi ? ' on' : '')} aria-label="複数選択" onClick={() => useStore.getState().setMultiSelect(!multi)}>
            <Layers size={17} />
          </button>
          <button className="tool-btn" aria-label="全体表示" onClick={() => fitAll()}>
            <Scan size={17} />
          </button>
          <button
            className="tool-btn"
            aria-label="ドキュメント設定"
            onClick={() => {
              const st = useStore.getState();
              st.clearSelection();
              st.setDocSheet(!st.docSheet);
            }}
          >
            <SlidersHorizontal size={17} />
          </button>
          <div className="sep" />
        </>
      )}
      {TOOLS.filter((x) => !(mobile && x.t === 'pan')).map((x) => (
        <button key={x.t} className={'tool-btn tip' + (tool === x.t ? ' on' : '')} data-tip={`${x.name}  ${x.key}`} onClick={() => setTool(x.t)}>
          {x.icon}
        </button>
      ))}
      <div className="sep" />
      {SHAPE_TOOLS.map((x) => (
        <button key={x.t} className={'tool-btn tip' + (tool === x.t ? ' on' : '')} data-tip={`${SHAPE_NAMES[x.t]}  ${x.key}\n(Shift+クリックで連続配置)`} onClick={() => setTool(x.t)}>
          <ShapeIcon kind={x.t} />
        </button>
      ))}
      <button className="tool-btn tip" data-tip={'画像を追加\n(Ctrl+V で貼り付け・ドロップでも可)'} onClick={() => pickImages()}>
        <ShapeIcon kind="image" />
      </button>
    </div>
  );
}

export function ZoomBar() {
  const zoom = useStore((s) => s.view.zoom);
  const zoomBy = (k: number) => {
    const s = useStore.getState();
    const el = document.querySelector('.canvas') as SVGSVGElement;
    const r = el.getBoundingClientRect();
    const v = s.view;
    const z = Math.max(0.1, Math.min(6, v.zoom * k));
    const cx = r.width / 2,
      cy = r.height / 2;
    s.setView({ zoom: z, x: cx - (cx - v.x) * (z / v.zoom), y: cy - (cy - v.y) * (z / v.zoom) });
  };
  return (
    <div className="float zoombar" onPointerDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" onClick={() => zoomBy(1 / 1.2)}>
        <ZoomOut size={15} />
      </button>
      <button className="zoom-val" onClick={() => zoomBy(1 / zoom)} title="100%">
        {Math.round(zoom * 100)}%
      </button>
      <button className="icon-btn" onClick={() => zoomBy(1.2)}>
        <ZoomIn size={15} />
      </button>
      <button className="icon-btn tip" data-tip="全体表示  Shift+1" onClick={() => fitAll()}>
        <Scan size={15} />
      </button>
    </div>
  );
}

export function fitAll() {
  const s = useStore.getState();
  const el = document.querySelector('.canvas') as SVGSVGElement | null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  s.setView(fitView(s.layout, r.width, r.height, 2));
}

export function HealthPanel() {
  const issues = useStore((s) => s.issues);
  const ignored = useStore((s) => s.ignored);
  const [showIgnored, setShowIgnored] = useState(false);
  const syntax = useStore((s) => s.doc.diagnostics.filter((d) => d.severity === 'error').length);
  const focusIssue = useStore((s) => s.focusIssue);
  const [open, setOpen] = useState(false);
  const s = useStore.getState();
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errors;
  const state = errors || syntax ? 'bad' : warns ? 'warn' : 'ok';

  const focus = (id: string) => {
    const iss = issues.find((i) => i.id === id);
    if (!iss) return;
    s.setFocusIssue(id);
    s.select({ nodes: iss.nodes, edges: iss.edges });
  };
  const fixAll = () => {
    const before = useStore.getState().issues.length;
    s.apply((src) => autoFix(src, canvasMeasure, { view: useStore.getState().page, pinned: new Set(useStore.getState().selection.nodes) }));
    const after = useStore.getState().issues.filter((i) => i.severity === 'error').length;
    s.notify(after === 0 ? `${before} 件の問題を解消しました` : `一部を解消しました（残り ${after} 件）`, after === 0 ? 'ok' : 'warn');
  };

  return (
    <div className="float health" onPointerDown={(e) => e.stopPropagation()}>
      <div className="health-head" onClick={() => setOpen(!open)}>
        <div className={'health-dot ' + state}>{state === 'ok' ? <ShieldCheck size={16} /> : <TriangleAlert size={16} />}</div>
        <div style={{ flex: 1 }}>
          <div className="health-title">
            {state === 'ok' ? '整合性チェック OK' : `${errors + syntax} 件のエラー`}
            {state !== 'ok' && warns > 0 && <span className="hide-mobile">{` · ${warns} 件の警告`}</span>}
          </div>
          <div className="health-sub">
            {state === 'ok' ? '重なり・はみ出し・貫通なし' : syntax ? `構文エラー ${syntax} 件（テキスト側を確認）` : '赤い箇所をクリックで該当図形を選択'}
            {ignored.length > 0 && <span>{` · 無視中 ${ignored.length} 件`}</span>}
          </div>
        </div>
        {issues.length > 0 && (
          <button
            className="btn primary"
            style={{ height: 28, padding: '0 10px' }}
            onClick={(e) => {
              e.stopPropagation();
              fixAll();
            }}
          >
            <WandSparkles size={13} /> <span>すべて解消</span>
          </button>
        )}
        {(issues.length > 0 || ignored.length > 0) && <ChevronDown size={15} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s', color: 'var(--muted)' }} />}
      </div>
      {open && issues.length > 0 && (
        <div className="issue-list">
          {issues.map((i) => (
            <div
              key={i.id}
              className={'issue' + (focusIssue === i.id ? ' focus' : '')}
              onMouseEnter={() => s.setHoverIssue(i.id)}
              onMouseLeave={() => s.setHoverIssue(null)}
              onClick={() => focus(i.id)}
            >
              <span className={'tag ' + i.severity}>{ISSUE_LABEL[i.code]}</span>
              <span className="msg">{i.message}</span>
              <button
                className="chip-btn fix"
                title={`この種類の警告（${IGNORE_NAME[i.code]}）を、関係する図形/矢印の ignore= に追加`}
                onClick={(e) => {
                  e.stopPropagation();
                  ignoreIssue(i);
                  s.setHoverIssue(null);
                }}
              >
                無視
              </button>
              <button
                className="chip-btn fix"
                onClick={(e) => {
                  e.stopPropagation();
                  s.apply((src) => autoFix(src, canvasMeasure, { view: useStore.getState().page, only: new Set([i.id]) }));
                  s.setHoverIssue(null);
                }}
              >
                解消
              </button>
            </div>
          ))}
        </div>
      )}
      {open && ignored.length > 0 && (
        <div className="issue-list ignored-list">
          <button className="ignored-toggle" onClick={() => setShowIgnored(!showIgnored)}>
            <EyeOff size={13} /> 無視中の警告 {ignored.length} 件 <ChevronDown size={13} style={{ transform: showIgnored ? 'rotate(180deg)' : undefined }} />
          </button>
          {showIgnored &&
            ignored.map((i) => (
              <div key={i.id} className="issue ignored" onMouseEnter={() => s.setHoverIssue(null)} onClick={() => s.select({ nodes: i.nodes, edges: i.edges })}>
                <span className="tag">{ISSUE_LABEL[i.code]}</span>
                <span className="msg">{i.message}</span>
                <button
                  className="chip-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    unignoreIssue(i);
                  }}
                >
                  戻す
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast || !visible) return null;
  return (
    <div className="float toast" key={toast.id}>
      {toast.tone === 'warn' ? <TriangleAlert size={16} color="var(--warn)" /> : <CircleCheck size={16} color="var(--ok)" />}
      {toast.text}
    </div>
  );
}

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="float help">
        <h3>Charpie — DSL リファレンス</h3>
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>テキストが正本です。キャンバスでの操作は、この形式の該当行だけを書き換えます。</div>
        <h4>基本</h4>
        <pre>{`# コメント（# + 空白）または // コメント
set gap=12 grid=10 padding=8 fontmin=9 fontmax=18

style accent { fill: #eef2ff; stroke: #6366f1; text: #312e81; }

rect    api  "API Gateway"  at (120, 80) size 160x60 .accent
trap    db   "Database"     at (120, 240) size 160x70 fill=#fef3c7
round   grp  "グループ"      at (0, 0) size 400x300 valign=top
rect    c1   "子"           at (20, 40) size 100x50 in=grp

user -> api "request"           # ->  <-  <->  --
api.s -> db.n route=ortho       # ポート n/e/s/w を指定
api -> cache route=curve bend=40 dash=dashed`}</pre>
        <h4>図形</h4>
        <table>
          <tbody>
            <tr>
              <td>rect round ellipse diamond trap para hex text</td>
              <td>矩形 / 角丸 / 楕円 / ひし形 / 台形 / 平行四辺形 / 六角形 / 枠なしテキスト</td>
            </tr>
          </tbody>
        </table>
        <h4>図形の属性</h4>
        <table>
          <tbody>
            <tr><td>fill stroke text</td><td>塗り・枠線・文字色（#hex または none）</td></tr>
            <tr><td>lw dash</td><td>線幅 / solid・dashed・dotted</td></tr>
            <tr><td>font</td><td>auto（既定：図形に合わせて自動調整）または px 固定</td></tr>
            <tr><td>weight valign halign</td><td>bold・light / top・middle・bottom / left・center・right</td></tr>
            <tr><td>rotate</td><td>文字の向き。90（右回り：上→下に読む）・-90（左回り：下→上に読む）・180</td></tr>
            <tr><td>in</td><td>親コンテナ。子は親の内側にあることが検査される</td></tr>
            <tr><td>overlap=allow</td><td>この図形の重なりチェックを無効化</td></tr>
            <tr><td>skew radius opacity</td><td>台形などの傾き(0–0.45) / 角丸半径 / 不透明度</td></tr>
          </tbody>
        </table>
        <h4>矢印の属性</h4>
        <table>
          <tbody>
            <tr><td>route</td><td>straight（既定）/ curve / ortho（直角）</td></tr>
            <tr><td>bend</td><td>曲がり量 px（正負で向き）</td></tr>
            <tr><td>stroke lw dash text font</td><td>線色 / 線幅 / 線種 / ラベル色 / ラベルサイズ</td></tr>
            <tr><td>端に座標</td><td>a -&gt; (300, 120) / (0, 50) -&gt; a / a.e -&gt; +(80, 0)（もう一方の端からの相対）</td></tr>
          </tbody>
        </table>
        <h4>警告を無視（図形・矢印・style 共通）</h4>
        <table>
          <tbody>
            <tr><td>ignore=all</td><td>この図形/矢印が関わる警告をすべて出さない</td></tr>
            <tr><td>ignore=overlap,through</td><td>種類を指定: overlap gap text contain covered through label loop</td></tr>
          </tbody>
        </table>
        <h4>整合性チェック（常時）</h4>
        <table>
          <tbody>
            <tr><td>重なり</td><td>図形の実際の輪郭（凸多角形）同士で判定。gap 設定で最小間隔も検査</td></tr>
            <tr><td>はみ出し</td><td>最小フォントでも図形に収まらない文字 / 親からはみ出す子 / 子に隠れる親の文字</td></tr>
            <tr><td>貫通</td><td>矢印が無関係な図形を横切る / 矢印ラベルが図形に重なる</td></tr>
          </tbody>
        </table>
        <h4>操作</h4>
        <table>
          <tbody>
            <tr><td>V H A / R U O D P L X T</td><td>選択 / 手のひら / 矢印 / 各図形ツール</td></tr>
            <tr><td>ダブルクリック</td><td>文字を編集（空白部分なら図形を追加）</td></tr>
            <tr><td>ホバー時の ● をドラッグ</td><td>矢印を引く（何もない所で離すと図形ごと追加）</td></tr>
            <tr><td>Shift / Alt (ドラッグ中)</td><td>軸固定・比率固定 / スナップ無効・中心から拡縮</td></tr>
            <tr><td>ホイール / Space+ドラッグ</td><td>ズーム / パン（Shift+ホイールで横、トラックパッドの 2 本指はパン）</td></tr>
            <tr><td>Ctrl C / V / D</td><td>コピー（テキストとして）/ 貼り付け / 複製</td></tr>
            <tr><td>矢印キー</td><td>1px 移動（Shift で 10px）</td></tr>
            <tr><td>Ctrl S / O</td><td>保存 / 開く</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
