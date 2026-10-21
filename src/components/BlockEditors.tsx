/**
 * Editing a table / list where it is drawn: every item / cell becomes an editable piece of text
 * over its place in the layout (same size, font and weight), so the canvas keeps looking like the
 * result. Each keystroke writes the body back to the source (smallest change), so the layout —
 * the fitted font size, column widths, row heights — follows as you type.
 */
import { memo, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Bold, Code2, IndentDecrease, IndentIncrease, List, ListOrdered, Plus, AlignLeft, AlignCenter, AlignRight, Trash2, Check } from 'lucide-react';
import { removeItems, setNodeBody, setNodesAttr } from '../dsl/patch';
import { reparse, useStore } from '../store';
import { fontStack } from '../text/fit';
import type { BlockSlot } from '../text/blocks';
import {
  cellAt,
  colCount,
  insertCol,
  insertRow,
  isNumber,
  itemShown,
  markupSegs,
  nextMarker,
  readList,
  readTable,
  removeCol,
  removeRow,
  renumber,
  rowsOf,
  segsMarkup,
  sepOf,
  setCell,
  setColAlign,
  shownLength,
  subtree,
  typedMarker,
  writeList,
  writeTable,
  type EditItem,
  type EditTable,
  type Seg,
} from '../text/blockEdit';
import { TEXT_FEATURES } from './Diagram';

// ───────────────────────────── contentEditable helpers ─────────────────────────────

/** The element's content as markup: <b> / <strong> / font-weight → `**`, <br> → `\n`. */
function domMarkup(el: Node): string {
  const out: Seg[] = [];
  const walk = (n: Node, bold: boolean) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push({ text: (n as Text).data.replace(/ /g, ' ').replace(/​/g, ''), bold });
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    if (n.tagName === 'BR') {
      out.push({ text: '\n', bold });
      return;
    }
    let b = bold;
    if (n.tagName === 'B' || n.tagName === 'STRONG') b = true;
    const fw = n.style.fontWeight;
    if (fw) b = fw === 'bold' || fw === 'bolder' || Number(fw) >= 600;
    if ((n.tagName === 'DIV' || n.tagName === 'P') && out.length) out.push({ text: '\n', bold: false });
    n.childNodes.forEach((c) => walk(c, b));
  };
  el.childNodes.forEach((c) => walk(c, false));
  // the <br> a browser keeps after the last line
  return segsMarkup(out).replace(/\n$/, '');
}

function renderMarkup(el: HTMLElement, markup: string) {
  el.replaceChildren();
  for (const g of markupSegs(markup)) {
    if (g.text === '\n') {
      el.appendChild(document.createElement('br'));
      continue;
    }
    const t = document.createTextNode(g.text);
    if (g.bold) {
      const b = document.createElement('b');
      b.appendChild(t);
      el.appendChild(b);
    } else el.appendChild(t);
  }
}

/** Characters (a <br> counts one) in a node. */
function shownChars(n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.replace(/\u200b/g, '').length;
  if (n instanceof HTMLElement && n.tagName === 'BR') return 1;
  let k = 0;
  n.childNodes.forEach((c) => (k += shownChars(c)));
  return k;
}

function selRange(el: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return el.contains(r.startContainer) ? r : null;
}

function caretOffset(el: HTMLElement): number {
  const r = selRange(el);
  if (!r) return 0;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return shownChars(pre.cloneContents());
}

function setCaret(el: HTMLElement, off: number | 'end' | 'all') {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  if (off === 'all') r.selectNodeContents(el);
  else {
    let left = off === 'end' ? Infinity : off;
    let placed = false;
    const walk = (n: Node): void => {
      if (placed) return;
      if (n.nodeType === Node.TEXT_NODE) {
        // a text node may start with the zero-width space that keeps the caret out of a bold span
        const skip = (n as Text).data.startsWith('\u200b') ? 1 : 0;
        const len = (n as Text).data.length - skip;
        if (left <= len) {
          r.setStart(n, left + skip);
          placed = true;
        } else left -= len;
        return;
      }
      if (n instanceof HTMLElement && n.tagName === 'BR') {
        if (left === 0) {
          r.setStartBefore(n);
          placed = true;
        } else left -= 1;
        return;
      }
      n.childNodes.forEach(walk);
    };
    walk(el);
    if (!placed) {
      r.selectNodeContents(el);
      r.collapse(false);
    } else r.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

const collapsed = (el: HTMLElement) => !!selRange(el)?.collapsed;
const atStart = (el: HTMLElement) => collapsed(el) && caretOffset(el) === 0;
const atEnd = (el: HTMLElement) => collapsed(el) && caretOffset(el) >= shownChars(el) - (el.lastChild instanceof HTMLBRElement ? 1 : 0);

/** Whether the caret is on the element's first / last line on screen. */
function onEdgeLine(el: HTMLElement, which: 'first' | 'last'): boolean {
  const r = selRange(el);
  if (!r) return true;
  const rc = r.getClientRects()[0] ?? r.getBoundingClientRect();
  if (!rc || (!rc.height && !rc.top)) return true;
  const box = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || rc.height;
  return which === 'first' ? rc.top - box.top < lh * 0.8 : box.bottom - rc.bottom < lh * 0.8;
}

/** Put the caret in `el` at the screen x of the old caret, on its first / last line. */
function caretAtX(el: HTMLElement, x: number | undefined, which: 'first' | 'last') {
  el.focus();
  if (x !== undefined) {
    const box = el.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    const y = which === 'first' ? box.top + lh / 2 : box.bottom - lh / 2;
    const r = document.caretRangeFromPoint?.(x, y);
    if (r && el.contains(r.startContainer)) {
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
  }
  setCaret(el, which === 'first' ? 0 : 'end');
}

const caretX = (el: HTMLElement) => selRange(el)?.getClientRects()[0]?.left;

/** Split the content at the caret: the part after it is taken out (as markup). */
function cutAfterCaret(el: HTMLElement): string {
  const r = selRange(el);
  if (!r) return '';
  r.deleteContents();
  const after = document.createRange();
  after.selectNodeContents(el);
  after.setStart(r.startContainer, r.startOffset);
  const box = document.createElement('div');
  box.appendChild(after.extractContents());
  return domMarkup(box);
}

/**
 * Typed `**bold**` turns bold at once: when the markup shows fewer characters than the element
 * holds, the element is drawn again from it. Returns the markup.
 */
function readTyped(el: HTMLElement): string {
  const markup = domMarkup(el);
  const lost = shownChars(el) - (el.lastChild instanceof HTMLBRElement ? 1 : 0) - shownLength(markup);
  if (lost > 0) {
    const at = caretOffset(el);
    renderMarkup(el, markup);
    setCaret(el, Math.max(0, at - lost));
    // the caret right after the new bold span: what is typed next is not bold
    const r = selRange(el);
    const b = r?.startContainer.parentElement;
    if (r && b?.tagName === 'B' && r.startOffset === (r.startContainer as Text).length && !b.nextSibling?.textContent) {
      const t = document.createTextNode('\u200b');
      b.after(t);
      r.setStart(t, 1);
      r.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    }
  }
  return markup;
}

/** A piece of editable text whose content belongs to the browser while typing; `rev` draws it again from `markup`. */
const Editable = memo(function Editable({ markup, rev, style, className, onReady, ...rest }: {
  markup: string;
  rev: number;
  style: CSSProperties;
  className?: string;
  onReady: (el: HTMLDivElement | null) => void;
  onInput: (el: HTMLDivElement) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    if (ref.current) renderMarkup(ref.current, markup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);
  useLayoutEffect(() => {
    onReady(ref.current);
    return () => onReady(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      className={className}
      style={style}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={rest.placeholder}
      onInput={() => {
        if (!composing.current) rest.onInput(ref.current!);
      }}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => {
        composing.current = false;
        rest.onInput(ref.current!);
      }}
      onKeyDown={(e) => {
        // (the frame around stops the keys from reaching the canvas, and takes Esc / Ctrl+Enter)
        if (e.nativeEvent.isComposing || composing.current) return;
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          document.execCommand('bold');
          return;
        }
        rest.onKeyDown(e);
      }}
      onPaste={rest.onPaste}
      onFocus={rest.onFocus}
    />
  );
});

// ───────────────────────────── shared frame ─────────────────────────────

/** An attribute of the shape to change along with the body (undefined = remove it). */
type Attr = [string, string | undefined];

/** Writes the body (and attributes of the shape) as one live step of the editing gesture. */
function useLive(id: string) {
  return (body: string, attrs: Attr[] = []) => {
    const s = useStore.getState();
    if (s.gestureBase === null) return; // replaced from outside meanwhile
    let src = setNodeBody(s.src, s.doc, id, body);
    for (const [k, v] of attrs) src = setNodesAttr(src, reparse(src), [id], k, v);
    if (src !== s.src) s.setSource(src, { history: 'none' });
  };
}

/** A slot of the page's layout filled with nothing goes back to being a placeholder (its bare line is dropped). */
export function dropEmptySlot(id: string) {
  const st = useStore.getState();
  const d = st.doc.nodeMap.get(id);
  if (d?.slot && !d.locked && !d.label && !d.body?.text.trim() && !d.attrList.length && !d.classes.length && !d.spans.at && !d.spans.size && !d.spans.kind && st.doc.deck && 'page' in st.doc.deck.view) {
    st.setSource(removeItems(st.src, st.doc, [d.id]), { history: 'none' });
  }
}

/** Start / finish of the edit: one undo step; leaving the editor (focus elsewhere) saves. */
function useSession(id: string, onSave?: () => void) {
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const s = useStore.getState();
    if (save) {
      onSave?.();
      dropEmptySlot(id);
    } else if (s.gestureBase !== null) s.setSource(s.gestureBase, { history: 'none' });
    useStore.getState().endGesture();
    useStore.getState().setEditing(null);
  };
  useLayoutEffect(() => {
    // the label editor may have started the gesture already (text turned into a list)
    if (useStore.getState().gestureBase === null) useStore.getState().beginGesture();
  }, []);
  return { done, finish };
}

function Frame({ box, finish, done, toolbar, children, onBackdrop }: {
  box: { x: number; y: number; w: number; h: number };
  finish: (save: boolean) => void;
  done: React.MutableRefObject<boolean>;
  toolbar: ReactNode;
  children: ReactNode;
  onBackdrop: (e: React.PointerEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const view = useStore((s) => s.view);
  const z = view.zoom;
  const left = view.x + box.x * z,
    top = view.y + box.y * z;
  const above = top > 44;
  return (
    <div
      ref={ref}
      className="block-live"
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={() => {
        // focus moving between the pieces (or to the toolbar) is not leaving
        setTimeout(() => {
          if (!done.current && !ref.current?.contains(document.activeElement)) finish(true);
        }, 0);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
      }}
    >
      <div className="block-live-backdrop" style={{ left, top, width: box.w * z, height: box.h * z }} onPointerDown={onBackdrop} />
      {children}
      <div className="block-live-bar" style={{ left, top: above ? top - 40 : top + box.h * z + 8 }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
        {toolbar}
      </div>
    </div>
  );
}

function Btn({ title, onClick, children, on, danger }: { title: string; onClick: () => void; children: ReactNode; on?: boolean; danger?: boolean }) {
  return (
    <button type="button" className={'block-live-btn' + (on ? ' on' : '') + (danger ? ' danger' : '')} title={title} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
}

const textStyle = (slot: Pick<BlockSlot, 'size' | 'weight' | 'lh' | 'color'>, z: number, family: string | undefined, fallback: string): CSSProperties => ({
  ...TEXT_FEATURES,
  fontSize: slot.size * z,
  lineHeight: slot.lh,
  fontWeight: slot.weight,
  fontFamily: fontStack(family),
  color: slot.color ?? fallback,
});

// ───────────────────────────── list ─────────────────────────────

type Item = EditItem & { uid: number; rev: number };
let uidSeq = 1;
const withUid = (it: EditItem): Item => ({ ...it, uid: uidSeq++, rev: 0 });

export function ListEditor({ id, onSource }: { id: string; onSource: () => void }) {
  const node = useStore((s) => s.layout.nodeMap.get(id));
  const view = useStore((s) => s.view);
  const live = useLive(id);
  const model = useRef<{ items: Item[]; after: string[] } | null>(null);
  if (!model.current) {
    const l = readList(useStore.getState().doc.nodeMap.get(id)?.body?.text ?? '');
    model.current = { items: l.items.map(withUid), after: l.after };
  }
  const els = useRef(new Map<number, HTMLDivElement>());
  const focus = useRef<{ uid: number; at: number | 'end' | 'all' | { x: number | undefined; line: 'first' | 'last' } } | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [, redraw] = useReducer((x: number) => x + 1, 0);

  const items = () => model.current!.items;
  const write = () => {
    renumber(items());
    live(writeList(model.current!));
  };
  const { done, finish } = useSession(id, () => {
    // empty items left at the end were never filled in
    const its = items();
    while (its.length && !its[its.length - 1].text.trim()) its.pop();
    write();
  });

  // first focus: where the user double-clicked, else the whole first item
  useLayoutEffect(() => {
    const at = useStore.getState().editing?.at;
    const s = useStore.getState().layout.nodeMap.get(id)?.blocks?.slots ?? [];
    const its = items();
    if (!its.length) {
      model.current!.items.push(withUid({ level: 0, marker: '-', text: '', before: [] }));
      redraw();
      focus.current = { uid: model.current!.items[0].uid, at: 0 };
      return;
    }
    if (at) {
      const k = Math.max(0, s.findIndex((t) => at.y < t.y + t.h));
      const shown = its.filter(itemShown);
      const it = shown[k < 0 ? shown.length - 1 : k] ?? its[0];
      const el = els.current.get(it.uid);
      if (el) {
        el.focus();
        const z = useStore.getState().view;
        const r = document.caretRangeFromPoint?.(z.x + at.x * z.zoom + el.offsetParent!.getBoundingClientRect().left, z.y + at.y * z.zoom + el.offsetParent!.getBoundingClientRect().top);
        if (r && el.contains(r.startContainer)) {
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(r);
        } else setCaret(el, 'end');
        return;
      }
    }
    focus.current = { uid: its[0].uid, at: 'all' };
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const f = focus.current;
    if (!f) return;
    const el = els.current.get(f.uid);
    if (!el) return;
    focus.current = null;
    if (typeof f.at === 'object') caretAtX(el, f.at.x, f.at.line);
    else {
      el.focus();
      setCaret(el, f.at);
    }
  });

  useEffect(() => {
    if (!node) useStore.getState().setEditing(null);
  }, [node]);
  if (!node?.blocks) return null;

  const z = view.zoom;
  const slots = node.blocks.slots;
  const family = node.style.family;
  const color = node.style.text;
  const idx = (uid: number) => items().findIndex((it) => it.uid === uid);
  const touch = (it: Item) => {
    it.raw = undefined;
  };
  const redrawItem = (it: Item) => {
    it.rev++;
  };
  /** after a change of structure: write, draw, put the caret */
  const restructure = (uid: number, at: NonNullable<typeof focus.current>['at']) => {
    write();
    focus.current = { uid, at };
    redraw();
  };

  const onInput = (it: Item, el: HTMLDivElement) => {
    let text = readTyped(el);
    // `- ` / `1. ` typed at the start makes the line an item (a number turns a bullet into a numbered one)
    const typed = typedMarker(text);
    if (typed && (!it.marker || (isNumber(typed.marker) && !isNumber(it.marker)))) {
      const at = caretOffset(el);
      it.marker = typed.marker;
      text = typed.rest;
      it.text = text;
      touch(it);
      redrawItem(it);
      restructure(it.uid, Math.max(0, at - typed.marker.length - 1));
      return;
    }
    if (text === it.text) return;
    it.text = text;
    touch(it);
    write();
  };

  const indent = (k: number, by: 1 | -1) => {
    const its = items();
    const it = its[k];
    if (by > 0 && (k === 0 || it.level > its[k - 1].level)) return false;
    if (by < 0 && it.level === 0) return false;
    const end = subtree(its, k);
    for (let i = k; i < end; i++) {
      its[i].level += by;
      touch(its[i]);
    }
    // a line without a marker can only be nested as an item
    if (by > 0 && !it.marker) it.marker = '-';
    return true;
  };

  const onKeyDown = (it: Item, e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const its = items();
    const k = idx(it.uid);
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.shiftKey) {
        // a line break inside the item
        document.execCommand('insertLineBreak');
        return;
      }
      if (!it.text.trim() && it.marker) {
        if (it.level > 0) {
          indent(k, -1);
          return restructure(it.uid, 0);
        }
        if (k === its.length - 1) {
          // Enter on an empty last item: done
          return finish(true);
        }
      }
      const tail = cutAfterCaret(el);
      it.text = domMarkup(el);
      touch(it);
      redrawItem(it);
      const fresh = withUid({ level: it.level, marker: it.marker ? nextMarker(it) : null, text: tail, before: [] });
      its.splice(k + 1, 0, fresh);
      return restructure(fresh.uid, 0);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const at = caretOffset(el);
      if (indent(k, e.shiftKey ? -1 : 1)) restructure(it.uid, at);
      return;
    }
    if (e.key === 'Backspace' && atStart(el)) {
      if (it.level > 0) {
        e.preventDefault();
        indent(k, -1);
        return restructure(it.uid, 0);
      }
      if (it.marker) {
        e.preventDefault();
        if (!it.text && k > 0) {
          its.splice(k, 1);
          return restructure(its[k - 1].uid, 'end');
        }
        if (!it.text) return;
        // first Backspace takes the bullet away, the next one joins the line to the one above
        it.marker = null;
        touch(it);
        return restructure(it.uid, 0);
      }
      if (k > 0) {
        e.preventDefault();
        const prev = its[k - 1];
        const at = shownLength(prev.text);
        prev.text = prev.text + it.text;
        touch(prev);
        redrawItem(prev);
        its.splice(k, 1);
        return restructure(prev.uid, at);
      }
      return;
    }
    if (e.key === 'Delete' && atEnd(el) && k < its.length - 1) {
      e.preventDefault();
      const next = its[k + 1];
      const at = shownLength(it.text);
      it.text += next.text;
      touch(it);
      redrawItem(it);
      its.splice(k + 1, 1);
      return restructure(it.uid, at);
    }
    if (e.key === 'ArrowUp' && k > 0 && onEdgeLine(el, 'first')) {
      e.preventDefault();
      focus.current = { uid: its[k - 1].uid, at: { x: caretX(el), line: 'last' } };
      return redraw();
    }
    if (e.key === 'ArrowDown' && k < its.length - 1 && onEdgeLine(el, 'last')) {
      e.preventDefault();
      focus.current = { uid: its[k + 1].uid, at: { x: caretX(el), line: 'first' } };
      return redraw();
    }
  };

  const onPaste = (it: Item, e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const lines = e.clipboardData
      .getData('text/plain')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    if (lines.length <= 1) {
      document.execCommand('insertText', false, lines[0]?.trim() ?? '');
      return;
    }
    // several lines: the first goes where the caret is, the rest become items below (keeping their own markers)
    const el = e.currentTarget;
    const tail = cutAfterCaret(el);
    const its = items();
    const k = idx(it.uid);
    const pasted = readList(lines.join('\n')).items;
    const first = pasted.shift()!;
    it.text = domMarkup(el) + first.text;
    if (!it.marker && first.marker) it.marker = first.marker;
    touch(it);
    redrawItem(it);
    const fresh = pasted.map((p) => withUid({ ...p, level: it.level + p.level, marker: p.marker ?? (it.marker ? nextMarker(it) : null), raw: undefined }));
    if (fresh.length) fresh[fresh.length - 1].text += tail;
    else it.text += tail;
    its.splice(k + 1, 0, ...fresh);
    restructure((fresh[fresh.length - 1] ?? it).uid, 'end');
  };

  // toolbar actions on the item with the caret
  const cur = items().find((it) => it.uid === current);
  const act = (f: (it: Item, k: number) => void) => () => {
    const it = cur ?? items()[0];
    if (!it) return;
    const el = els.current.get(it.uid);
    const at = el && document.activeElement === el ? caretOffset(el) : 'end';
    f(it, idx(it.uid));
    restructure(it.uid, at);
  };
  const setMarker = (m: string | null) =>
    act((it) => {
      it.marker = m;
      touch(it);
    });

  // positions: the layout's slots, in item order (an empty line without a marker is not laid out: it sits below the one before)
  let k = 0;
  let prev: BlockSlot | undefined;
  const placed = items().map((it) => {
    const s = itemShown(it) ? slots[k++] : undefined;
    const slot: BlockSlot = s ?? { ...(prev ?? { row: 0, col: 0, span: 1, x: node.textBox.x, y: node.textBox.y, w: node.textBox.w, h: 0, align: 'left', size: node.blocks!.size, weight: node.style.weight, lh: 1.25 }), y: (prev ? prev.y + prev.h : node.textBox.y), marker: undefined };
    if (!s) slot.h = slot.size * slot.lh;
    prev = slot;
    return { it, slot };
  });

  return (
    <Frame
      box={node.box}
      finish={finish}
      done={done}
      onBackdrop={(e) => {
        // a click beside the items: the caret goes to the end of the nearest one
        e.preventDefault();
        e.stopPropagation();
        const y = (e.clientY - ((e.currentTarget as HTMLElement).offsetParent as HTMLElement).getBoundingClientRect().top - view.y) / z;
        const hit = placed.find((p) => y < p.slot.y + p.slot.h) ?? placed[placed.length - 1];
        if (hit) {
          focus.current = { uid: hit.it.uid, at: 'end' };
          redraw();
        }
      }}
      toolbar={
        <>
          <Btn title="箇条書き（行頭で - を打っても同じ）" on={!!cur?.marker && !isNumber(cur.marker)} onClick={setMarker('-')}>
            <List size={15} />
          </Btn>
          <Btn title="番号付き（行頭で 1. を打っても同じ）" on={isNumber(cur?.marker ?? null)} onClick={setMarker('1.')}>
            <ListOrdered size={15} />
          </Btn>
          <Btn title="字下げを戻す（Shift+Tab）" onClick={act((_, k) => indent(k, -1))}>
            <IndentDecrease size={15} />
          </Btn>
          <Btn title="字下げ（Tab）" onClick={act((_, k) => indent(k, 1))}>
            <IndentIncrease size={15} />
          </Btn>
          <Btn title="太字（Ctrl+B）" onClick={() => document.execCommand('bold')}>
            <Bold size={15} />
          </Btn>
          <span className="block-live-sep" />
          <Btn
            title="Markdown のまま編集"
            onClick={() => {
              done.current = true;
              write();
              onSource();
            }}
          >
            <Code2 size={15} />
          </Btn>
          <Btn title="確定（Ctrl+Enter / 外をクリック）" onClick={() => finish(true)}>
            <Check size={15} />
          </Btn>
        </>
      }
    >
      {placed.map(({ it, slot }) => (
        <ListLine key={it.uid} it={it} slot={slot} z={z} view={view} family={family} color={color} placeholder={it.marker ? 'リスト' : '「- 」で箇条書き'}
          onReady={(el) => (el ? els.current.set(it.uid, el) : els.current.delete(it.uid))}
          onInput={(el) => onInput(it, el)}
          onKeyDown={(e) => onKeyDown(it, e)}
          onPaste={(e) => onPaste(it, e)}
          onFocus={() => setCurrent(it.uid)}
        />
      ))}
    </Frame>
  );
}

function ListLine({ it, slot, z, view, family, color, placeholder, ...h }: {
  it: Item;
  slot: BlockSlot;
  z: number;
  view: { x: number; y: number };
  family: string | undefined;
  color: string;
  placeholder: string;
  onReady: (el: HTMLDivElement | null) => void;
  onInput: (el: HTMLDivElement) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
}) {
  const ts = textStyle(slot, z, family, color);
  const top = view.y + slot.y * z;
  return (
    <>
      {slot.marker && (
        <div className="block-live-marker" style={{ ...ts, left: view.x + slot.marker.x * z, top }}>
          {slot.marker.text}
        </div>
      )}
      <Editable
        markup={it.text}
        rev={it.rev}
        className="block-live-text"
        style={{ ...ts, left: view.x + slot.x * z, top, width: slot.w * z, minHeight: slot.h * z }}
        placeholder={placeholder}
        {...h}
      />
    </>
  );
}

// ───────────────────────────── table ─────────────────────────────

export function TableEditor({ id, onSource }: { id: string; onSource: () => void }) {
  const node = useStore((s) => s.layout.nodeMap.get(id));
  const view = useStore((s) => s.view);
  const live = useLive(id);
  const model = useRef<EditTable | null>(null);
  if (!model.current) model.current = readTable(useStore.getState().doc.nodeMap.get(id)?.body?.text ?? '');
  const els = useRef(new Map<string, HTMLDivElement>());
  const focus = useRef<{ row: number; col: number; at: number | 'end' | 'all' } | null>(null);
  const [cur, setCur] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  /** bumped on a change of structure: every cell is drawn again from the model */
  const [ver, bump] = useReducer((x: number) => x + 1, 0);
  const t = () => model.current!;
  const write = (attrs?: Attr[]) => live(writeTable(t()), attrs);
  const { done, finish } = useSession(id, () => write());

  // first focus: the double-clicked cell, else the whole first cell (applied by the effect below)
  useLayoutEffect(() => {
    if (!rowsOf(t()).length) {
      insertRow(t(), 0);
      write();
      focus.current = { row: 0, col: 0, at: 0 };
      bump();
      return;
    }
    const at = useStore.getState().editing?.at;
    const slots = useStore.getState().layout.nodeMap.get(id)?.blocks?.slots ?? [];
    const hit = at && slots.find((s) => s.cell && at.x >= s.cell.x && at.x < s.cell.x + s.cell.w && at.y >= s.cell.y && at.y < s.cell.y + s.cell.h);
    focus.current = hit ? { row: hit.row, col: hit.col, at: 'end' } : { row: 0, col: 0, at: 'all' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const f = focus.current;
    if (!f) return;
    const el = els.current.get(`${f.row}:${f.col}`);
    if (!el) return;
    focus.current = null;
    el.focus();
    setCaret(el, f.at);
  });

  useEffect(() => {
    if (!node) useStore.getState().setEditing(null);
  }, [node]);
  if (!node?.blocks) return null;

  const z = view.zoom;
  const slots = [...node.blocks.slots].sort((a, b) => a.row - b.row || a.col - b.col);
  const nrow = rowsOf(t()).length;
  const ncol = colCount(t());
  const family = node.style.family;
  const color = node.style.text;
  const restructure = (row: number, col: number, at: number | 'end' | 'all' = 'end', attrs?: Attr[]) => {
    write(attrs);
    focus.current = { row: Math.max(0, row), col: Math.max(0, col), at };
    bump();
  };
  const go = (row: number, col: number, at: number | 'end' | 'all') => {
    // the cell covering that column
    const s = slots.find((x) => x.row === row && x.col <= col && col < x.col + x.span);
    if (!s) return;
    const el = els.current.get(`${s.row}:${s.col}`);
    if (!el) return;
    el.focus();
    setCaret(el, at);
  };
  const order = (s: BlockSlot) => slots.indexOf(s);

  const onKeyDown = (s: BlockSlot, e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const k = order(s);
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        if (k > 0) go(slots[k - 1].row, slots[k - 1].col, 'all');
      } else if (k < slots.length - 1) go(slots[k + 1].row, slots[k + 1].col, 'all');
      else {
        insertRow(t(), nrow);
        restructure(nrow, 0, 0);
      }
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (e.shiftKey) return go(s.row - 1, s.col, 'end');
      if (s.row < nrow - 1) return go(s.row + 1, s.col, 'end');
      insertRow(t(), nrow);
      return restructure(nrow, s.col, 0);
    }
    if (e.key === 'ArrowUp' && onEdgeLine(el, 'first')) {
      e.preventDefault();
      return go(s.row - 1, s.col, 'end');
    }
    if (e.key === 'ArrowDown' && onEdgeLine(el, 'last')) {
      e.preventDefault();
      return go(s.row + 1, s.col, 'end');
    }
    if (e.key === 'ArrowLeft' && atStart(el) && k > 0) {
      e.preventDefault();
      return go(slots[k - 1].row, slots[k - 1].col, 'end');
    }
    if (e.key === 'ArrowRight' && atEnd(el) && k < slots.length - 1) {
      e.preventDefault();
      return go(slots[k + 1].row, slots[k + 1].col, 0);
    }
  };

  const onPaste = (s: BlockSlot, e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain').replace(/\r?\n$/, '');
    if (!/[\t\n]/.test(text)) {
      document.execCommand('insertText', false, text);
      return;
    }
    // a block copied from a spreadsheet: fills the cells from here (adding rows / columns)
    const grid = text.split(/\r?\n/).map((l) => l.split('\t'));
    for (let i = 0; i < grid.length; i++) {
      while (rowsOf(t()).length <= s.row + i) insertRow(t(), rowsOf(t()).length);
      for (let j = 0; j < grid[i].length; j++) {
        while (colCount(t()) <= s.col + j) insertCol(t(), colCount(t()));
        setCell(t(), s.row + i, s.col + j, grid[i][j].trim());
      }
    }
    restructure(s.row + grid.length - 1, s.col + grid[grid.length - 1].length - 1);
  };

  // column alignment: `align=` on the shape wins over the `|:--:|` line, so change whichever decides
  const attrAlign = useStore.getState().doc.nodeMap.get(id)?.attrs.align;
  const alignOf = (col: number) => {
    const sl = slots.find((x) => x.col === col && x.row >= (sepOf(t()) ? 1 : 0)) ?? slots.find((x) => x.col === col);
    return sl?.align === 'left' ? 'l' : sl?.align === 'right' ? 'r' : 'c';
  };
  const setAlign = (a: 'l' | 'c' | 'r') => {
    const col = cur.col;
    if (attrAlign !== undefined) {
      const list = Array.from({ length: ncol }, (_, j) => alignOf(j));
      list[col] = a;
      return restructure(cur.row, col, 'end', [['align', list.join(',')]]);
    }
    setColAlign(t(), col, a);
    restructure(cur.row, col);
  };
  /** `cols=` / `align=` list one value per column: a column added (copying its neighbour) or removed there too */
  const colAttrs = (op: 'insert' | 'remove', at: number): Attr[] => {
    const attrs = useStore.getState().doc.nodeMap.get(id)?.attrs ?? {};
    const out: Attr[] = [];
    for (const key of ['cols', 'align'] as const) {
      if (attrs[key] === undefined) continue;
      const list = key === 'align' ? Array.from({ length: ncol }, (_, j) => alignOf(j) as string) : attrs[key].split(',').map((x) => x.trim());
      while (list.length < ncol) list.push(list[list.length - 1] ?? '1');
      if (op === 'insert') list.splice(at, 0, list[Math.max(0, Math.min(at, list.length) - 1)] ?? list[0] ?? '1');
      else list.splice(at, 1);
      out.push([key, list.length ? list.join(',') : undefined]);
    }
    return out;
  };
  const addCol = (at: number) => {
    const a = colAttrs('insert', at);
    insertCol(t(), at);
    restructure(cur.row, at, 0, a);
  };

  const tb = node.blocks;
  const right = Math.max(tb.x + tb.width, ...slots.map((s) => (s.cell ? s.cell.x + s.cell.w : 0)));
  const bottom = Math.max(tb.y + tb.height, ...slots.map((s) => (s.cell ? s.cell.y + s.cell.h : 0)));
  const curAlign = alignOf(cur.col);

  return (
    <Frame
      box={node.box}
      finish={finish}
      done={done}
      onBackdrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      toolbar={
        <>
          <Btn title="上に行を追加" onClick={() => (insertRow(t(), cur.row), restructure(cur.row, cur.col, 0))}>
            <Plus size={12} />行↑
          </Btn>
          <Btn title="下に行を追加" onClick={() => (insertRow(t(), cur.row + 1), restructure(cur.row + 1, cur.col, 0))}>
            <Plus size={12} />行↓
          </Btn>
          <Btn title="左に列を追加" onClick={() => addCol(cur.col)}>
            <Plus size={12} />列←
          </Btn>
          <Btn title="右に列を追加" onClick={() => addCol(cur.col + 1)}>
            <Plus size={12} />列→
          </Btn>
          <span className="block-live-sep" />
          <Btn title="この行を削除" danger onClick={() => {
            if (nrow <= 1) return;
            removeRow(t(), cur.row);
            restructure(Math.min(cur.row, nrow - 2), cur.col);
          }}>
            <Trash2 size={13} />行
          </Btn>
          <Btn title="この列を削除" danger onClick={() => {
            if (ncol <= 1) return;
            const a = colAttrs('remove', cur.col);
            removeCol(t(), cur.col);
            restructure(cur.row, Math.min(cur.col, ncol - 2), 'end', a);
          }}>
            <Trash2 size={13} />列
          </Btn>
          <span className="block-live-sep" />
          <Btn title="列を左寄せ" on={curAlign === 'l'} onClick={() => setAlign('l')}>
            <AlignLeft size={15} />
          </Btn>
          <Btn title="列を中央寄せ" on={curAlign === 'c'} onClick={() => setAlign('c')}>
            <AlignCenter size={15} />
          </Btn>
          <Btn title="列を右寄せ" on={curAlign === 'r'} onClick={() => setAlign('r')}>
            <AlignRight size={15} />
          </Btn>
          <Btn title="太字（Ctrl+B）" onClick={() => document.execCommand('bold')}>
            <Bold size={15} />
          </Btn>
          <span className="block-live-sep" />
          <Btn title="Markdown のまま編集" onClick={() => {
            done.current = true;
            write();
            onSource();
          }}>
            <Code2 size={15} />
          </Btn>
          <Btn title="確定（Ctrl+Enter / 外をクリック）" onClick={() => finish(true)}>
            <Check size={15} />
          </Btn>
        </>
      }
    >
      {slots.map((s) => {
        const c = s.cell!;
        const ts = textStyle(s, z, family, color);
        const key = `${s.row}:${s.col}`;
        const on = cur.row === s.row && cur.col === s.col;
        return (
          <div
            key={`${ver}:${key}`}
            className={'block-live-cell' + (on ? ' on' : '')}
            style={{ left: view.x + c.x * z, top: view.y + c.y * z, width: c.w * z, height: c.h * z, paddingLeft: (s.x - c.x) * z, paddingRight: (c.x + c.w - s.x - s.w) * z }}
            onPointerDown={(e) => {
              // a click on the cell's padding: caret at the end of its text
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              go(s.row, s.col, 'end');
            }}
          >
            <Editable
              markup={cellAt(t(), s.row, s.col)?.text ?? ''}
              rev={ver}
              className="block-live-text in-cell"
              style={{ ...ts, textAlign: s.align }}
              onReady={(el) => (el ? els.current.set(key, el) : els.current.delete(key))}
              onInput={(el) => {
                setCell(t(), s.row, s.col, readTyped(el).replace(/\n/g, ' '));
                write();
              }}
              onKeyDown={(e) => onKeyDown(s, e)}
              onPaste={(e) => onPaste(s, e)}
              onFocus={() => setCur({ row: s.row, col: s.col })}
            />
          </div>
        );
      })}
      <button
        type="button"
        className="block-live-add row"
        title="行を追加"
        tabIndex={-1}
        style={{ left: view.x + tb.x * z, top: view.y + bottom * z + 2, width: (right - tb.x) * z }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (insertRow(t(), nrow), restructure(nrow, cur.col, 0))}
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        className="block-live-add col"
        title="列を追加"
        tabIndex={-1}
        style={{ left: view.x + right * z + 2, top: view.y + tb.y * z, height: (bottom - tb.y) * z }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => addCol(ncol)}
      >
        <Plus size={12} />
      </button>
    </Frame>
  );
}
