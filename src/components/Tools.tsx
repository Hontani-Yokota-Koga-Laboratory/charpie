/**
 * The tool bar and the insert palette, both driven by one registry of things that can be put on the
 * canvas. A new kind of shape is one entry in INSERTS: it then shows up in its toolbar group, in the
 * `/` palette, and gets its shortcut key.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Hand, Layers, MousePointer2, Plus, Scan, Search, SlidersHorizontal, Spline } from 'lucide-react';
import type { ShapeKind } from '../dsl/types';
import { useStore, type Tool } from '../store';
import { useMobile } from '../useMobile';
import { pickImages } from '../images';
import { ShapeIcon, SHAPE_NAMES } from './ui';
import { fitAll } from './Chrome';

type Group = 'shape' | 'text' | 'table' | 'media';

interface InsertItem {
  kind: ShapeKind;
  group: Group;
  key?: string;
  /** extra words the palette matches */
  words: string;
  /** runs instead of arming a drawing tool */
  run?: () => void;
  hint?: string;
}

export const INSERTS: InsertItem[] = [
  { kind: 'rect', group: 'shape', key: 'R', words: 'rect box 四角 矩形' },
  { kind: 'round', group: 'shape', key: 'U', words: 'round rounded 角丸' },
  { kind: 'ellipse', group: 'shape', key: 'O', words: 'ellipse circle oval 円 楕円' },
  { kind: 'diamond', group: 'shape', key: 'D', words: 'diamond 条件 ひし形' },
  { kind: 'trap', group: 'shape', key: 'P', words: 'trap trapezoid 台形 encoder' },
  { kind: 'para', group: 'shape', key: 'L', words: 'para parallelogram 平行四辺形 io' },
  { kind: 'hex', group: 'shape', key: 'X', words: 'hex hexagon 六角形' },
  { kind: 'cross', group: 'shape', words: 'cross otimes 積 ×' },
  { kind: 'plus', group: 'shape', words: 'plus oplus 和 +' },
  { kind: 'text', group: 'text', key: 'T', words: 'text label テキスト 文字' },
  { kind: 'list', group: 'text', key: 'B', words: 'list bullet 箇条書き リスト', hint: '- 項目 / 1. 項目、字下げで入れ子' },
  { kind: 'table', group: 'table', key: 'G', words: 'table grid 表 テーブル', hint: 'Markdown の | a | b | で書く' },
  { kind: 'image', group: 'media', words: 'image picture 画像 写真', run: () => pickImages(), hint: 'Ctrl+V で貼り付け・ドロップでも可' },
];

const GROUPS: { id: Group; name: string }[] = [
  { id: 'shape', name: '図形' },
  { id: 'text', name: '文字' },
  { id: 'table', name: '表' },
  { id: 'media', name: '画像' },
];

const BASE_TOOLS: { t: Tool; key: string; icon: JSX.Element; name: string }[] = [
  { t: 'select', key: 'V', icon: <MousePointer2 size={17} />, name: '選択' },
  { t: 'pan', key: 'H', icon: <Hand size={17} />, name: '手のひら' },
  { t: 'edge', key: 'A', icon: <Spline size={17} />, name: '矢印' },
];

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries([
  ...BASE_TOOLS.map((t) => [t.key.toLowerCase(), t.t]),
  ...INSERTS.filter((x) => x.key && !x.run).map((x) => [x.key!.toLowerCase(), x.kind]),
]);

/** Starter content for shapes whose content is a block. */
export const STARTER_BODY: Partial<Record<ShapeKind, string>> = {
  table: '| 見出し | 見出し |\n|---|---|\n| a | b |',
  list: '- 項目\n- 項目',
};

const LS_LAST = 'charpie:lastTool';
function loadLast(): Partial<Record<Group, ShapeKind>> {
  try {
    return JSON.parse(localStorage.getItem(LS_LAST) ?? '{}');
  } catch {
    return {};
  }
}

const tipOf = (x: InsertItem) => `${SHAPE_NAMES[x.kind]}${x.key ? `  ${x.key}` : ''}${x.hint ? `\n${x.hint}` : x.run ? '' : '\n(Shift+クリックで連続配置)'}`;

function activate(x: InsertItem) {
  if (x.run) x.run();
  else useStore.getState().setTool(x.kind);
}

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const multi = useStore((s) => s.multiSelect);
  const mobile = useMobile();
  const [last, setLast] = useState(loadLast);
  const [open, setOpen] = useState<Group | null>(null);
  const [palette, setPalette] = usePalette();
  const ref = useRef<HTMLDivElement>(null);

  // the group remembers the kind picked last (also when picked by shortcut or palette)
  useEffect(() => {
    const x = INSERTS.find((i) => i.kind === tool);
    if (x && last[x.group] !== x.kind) {
      const next = { ...last, [x.group]: x.kind };
      setLast(next);
      try {
        localStorage.setItem(LS_LAST, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
    }
  }, [tool, last]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <>
      <div className="float toolbar" ref={ref} onPointerDown={(e) => e.stopPropagation()}>
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
        {BASE_TOOLS.filter((x) => !(mobile && x.t === 'pan')).map((x) => (
          <button key={x.t} className={'tool-btn tip' + (tool === x.t ? ' on' : '')} data-tip={`${x.name}  ${x.key}`} onClick={() => setTool(x.t)}>
            {x.icon}
          </button>
        ))}
        <div className="sep" />
        {GROUPS.map((g) => {
          const items = INSERTS.filter((x) => x.group === g.id);
          const cur = items.find((x) => x.kind === last[g.id]) ?? items[0];
          const active = items.some((x) => x.kind === tool);
          const shown = active ? items.find((x) => x.kind === tool)! : cur;
          return (
            <div key={g.id} className="tool-group">
              <button
                className={'tool-btn tip' + (active ? ' on' : '') + (items.length > 1 ? ' has-more' : '')}
                data-tip={items.length > 1 ? `${tipOf(shown)}\n右クリック・長押しで${g.name}を選ぶ` : tipOf(shown)}
                onClick={() => (active && items.length > 1 ? setOpen(open === g.id ? null : g.id) : (activate(shown), setOpen(null)))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (items.length > 1) setOpen(open === g.id ? null : g.id);
                }}
              >
                <ShapeIcon kind={shown.kind} />
                {items.length > 1 && (
                  <span
                    className="tool-more"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(open === g.id ? null : g.id);
                    }}
                  />
                )}
              </button>
              {open === g.id && (
                <div className="float tool-flyout">
                  <div className="tool-flyout-title">{g.name}</div>
                  {items.map((x) => (
                    <button
                      key={x.kind}
                      className={'flyout-item' + (tool === x.kind ? ' on' : '')}
                      onClick={() => {
                        activate(x);
                        setOpen(null);
                      }}
                    >
                      <ShapeIcon kind={x.kind} />
                      <span>{SHAPE_NAMES[x.kind]}</span>
                      {x.key && <kbd>{x.key}</kbd>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="sep" />
        <button className={'tool-btn tip' + (palette ? ' on' : '')} data-tip="挿入…  /" onClick={() => setPalette(!palette)}>
          <Plus size={18} />
        </button>
      </div>
      {palette && <InsertPalette onClose={() => setPalette(false)} />}
    </>
  );
}

// ───────────────────────────── palette ─────────────────────────────

let paletteListeners: ((v: boolean) => void)[] = [];
let paletteOpen = false;
/** Open / close the insert palette from anywhere (the `/` shortcut). */
export function setPaletteOpen(v: boolean) {
  paletteOpen = v;
  for (const l of paletteListeners) l(v);
}
function usePalette(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(paletteOpen);
  useEffect(() => {
    paletteListeners.push(setV);
    return () => {
      paletteListeners = paletteListeners.filter((l) => l !== setV);
    };
  }, []);
  return [v, setPaletteOpen];
}

interface Command {
  id: string;
  name: string;
  icon: JSX.Element;
  key?: string;
  words: string;
  hint?: string;
  run: () => void;
}

function commands(): Command[] {
  const items: Command[] = INSERTS.map((x) => ({ id: x.kind, name: SHAPE_NAMES[x.kind], icon: <ShapeIcon kind={x.kind} />, key: x.key, words: `${x.kind} ${x.words}`, hint: x.hint, run: () => activate(x) }));
  return items;
}

function InsertPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const all = useMemo(commands, []);
  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => words.every((w) => `${c.name} ${c.words}`.toLowerCase().includes(w)));
  }, [q, all]);
  const pick = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-backdrop" onPointerDown={onClose}>
      <div className="float palette" onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={15} />
          <input
            autoFocus
            value={q}
            placeholder="挿入するもの（表、list、楕円…）"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((i) => Math.min(hits.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                pick(hits[sel]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
        </div>
        <div className="palette-list">
          {hits.map((c, i) => (
            <button key={c.id} className={'palette-item' + (i === sel ? ' on' : '')} onMouseEnter={() => setSel(i)} onClick={() => pick(c)}>
              {c.icon}
              <span className="palette-name">{c.name}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
              {c.key && <kbd>{c.key}</kbd>}
            </button>
          ))}
          {!hits.length && <div className="palette-empty">見つかりません</div>}
        </div>
      </div>
    </div>
  );
}
