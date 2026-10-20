import { useEffect, useState } from 'react';
import { ChevronUp, CopyPlus, Pencil, Trash, X } from 'lucide-react';
import { useStore } from '../store';
import { deleteSelection, duplicateSelection, editSelection } from '../actions';
import { Inspector } from './Inspector';

/** Bottom sheet that hosts the inspector on small screens. Collapsed = quick actions only. */
export function MobileSheet() {
  const selection = useStore((s) => s.selection);
  const docSheet = useStore((s) => s.docSheet);
  const [open, setOpen] = useState(false);
  const has = selection.nodes.length + selection.edges.length > 0;
  const key = selection.nodes.join(',') + '|' + selection.edges.join(',');

  // a new selection starts collapsed so the canvas stays usable
  useEffect(() => {
    if (has) setOpen(false);
  }, [key, has]);

  if (!has && !docSheet) return null;
  const expanded = open || !has;
  const s = useStore.getState();
  const title = !has ? 'ドキュメント設定' : selection.nodes.length ? `${selection.nodes.length === 1 ? selection.nodes[0] : selection.nodes.length + ' 個の図形'}` : selection.edges.length === 1 ? selection.edges[0] : `${selection.edges.length} 本の矢印`;
  const canEdit = selection.nodes.length === 1 || (selection.edges.length === 1 && !selection.nodes.length);

  return (
    <div className={'sheet' + (expanded ? ' open' : '')} onPointerDown={(e) => e.stopPropagation()}>
      <div className="sheet-bar">
        <button className="sheet-grip" aria-label="展開" onClick={() => has && setOpen(!open)}>
          <span />
        </button>
        <div className="sheet-title" onClick={() => has && setOpen(!open)}>
          {title}
        </div>
        {has && (
          <>
            {canEdit && (
              <button className="sheet-act" onClick={editSelection}>
                <Pencil size={17} />
                <span>文字</span>
              </button>
            )}
            {selection.nodes.length > 0 && (
              <button className="sheet-act" onClick={duplicateSelection}>
                <CopyPlus size={17} />
                <span>複製</span>
              </button>
            )}
            <button className="sheet-act danger" onClick={deleteSelection}>
              <Trash size={17} />
              <span>削除</span>
            </button>
            <button className="sheet-act" onClick={() => setOpen(!open)}>
              <ChevronUp size={17} style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .2s' }} />
              <span>{open ? '閉じる' : '詳細'}</span>
            </button>
          </>
        )}
        <button
          className="icon-btn"
          aria-label="閉じる"
          onClick={() => {
            s.clearSelection();
            s.setDocSheet(false);
          }}
        >
          <X size={18} />
        </button>
      </div>
      {expanded && (
        <div className="sheet-body">
          <Inspector />
        </div>
      )}
    </div>
  );
}
