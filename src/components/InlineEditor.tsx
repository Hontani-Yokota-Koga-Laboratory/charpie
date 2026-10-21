import { useEffect, useLayoutEffect, useRef } from 'react';
import { removeItems, setEdgeLabel, setNodeLabel } from '../dsl/patch';
import { useStore } from '../store';
import { FONT_FAMILY, LINE_HEIGHT } from '../text/fit';

/** contentEditable overlay used to edit node / edge labels in place. */
export function InlineEditor() {
  const editing = useStore((s) => s.editing)!;
  const view = useStore((s) => s.view);
  const layout = useStore((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const composing = useRef(false);

  const node = editing.type === 'node' ? layout.nodeMap.get(editing.id) : undefined;
  const edge = editing.type === 'edge' ? layout.edgeMap.get(editing.id) : undefined;
  const initial = (node && (node.def.labelSource ?? node.def.label)) ?? edge?.def.label ?? '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerText = initial;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    done.current = false;
    // typing updates the diagram live; the whole edit is one undo step
    useStore.getState().beginGesture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing.id, editing.type]);

  useEffect(() => {
    if (!node && !edge) useStore.getState().setEditing(null);
  }, [node, edge]);

  if (!node && !edge) return null;

  const current = () => (ref.current?.innerText ?? '').replace(/\n$/, '');
  const live = () => {
    const s = useStore.getState();
    if (s.gestureBase === null) return; // replaced from outside meanwhile
    const text = current();
    const next = editing.type === 'node' ? setNodeLabel(s.src, s.doc, editing.id, text) : setEdgeLabel(s.src, s.doc, editing.id, text);
    s.setSource(next, { history: 'none' });
  };
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const s = useStore.getState();
    if (save) live();
    else if (s.gestureBase !== null) s.setSource(s.gestureBase, { history: 'none' });
    // a slot left empty goes back to being a placeholder (drop the bare `slot ""` line)
    const st = useStore.getState();
    const d = editing.type === 'node' ? st.doc.nodeMap.get(editing.id) : undefined;
    if (d?.slot && !d.locked && !d.label && !d.attrList.length && !d.classes.length && !d.spans.at && !d.spans.size && !d.spans.kind && st.doc.deck && 'page' in st.doc.deck.view) {
      st.setSource(removeItems(st.src, st.doc, [d.id]), { history: 'none' });
    }
    s.endGesture();
    s.setEditing(null);
  };

  const z = view.zoom;
  let rect: { x: number; y: number; w: number; h: number };
  let fontSize: number;
  let color = '#0f172a';
  let weight = 500;
  if (node) {
    const tb = node.textBox;
    // rotated labels are edited horizontally, centred on the text area
    const sideways = node.style.rotate === 90 || node.style.rotate === 270;
    const w = sideways ? tb.h : tb.w,
      h = sideways ? tb.w : tb.h;
    rect = { x: view.x + (tb.x + tb.w / 2 - w / 2) * z, y: view.y + (tb.y + tb.h / 2 - h / 2) * z, w: w * z, h: h * z };
    fontSize = node.text.size * z;
    color = node.style.text;
    weight = node.style.weight;
  } else {
    const c = edge!.label?.center ?? edge!.pts[Math.floor(edge!.pts.length / 2)];
    const w = 240 * z;
    rect = { x: view.x + c.x * z - w / 2, y: view.y + c.y * z - 30 * z, w, h: 60 * z };
    fontSize = edge!.style.font * z;
  }

  return (
    <div className="inline-editor" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={{ fontSize, fontFamily: FONT_FAMILY, lineHeight: LINE_HEIGHT, color, fontWeight: weight }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit(true);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            commit(false);
          }
        }}
        onInput={() => {
          if (!composing.current) live();
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          live();
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onBlur={() => commit(true)}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}
