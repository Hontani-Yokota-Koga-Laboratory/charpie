/**
 * Creating things: a new file (diagram or slide deck, optionally in the look of an existing deck)
 * and a new layout (blank, or imported from another deck).
 */
import { useEffect, useMemo, useState } from 'react';
import { FilePlus, LayoutTemplate, Presentation, Shapes } from 'lucide-react';
import { parse } from '../dsl/parse';
import { addLayout, importLayouts, isValidId, rebasePath } from '../dsl/patch';
import { createFile, openFile } from '../remote';
import { useStore } from '../store';
import { diagramTemplate, slideFromDeck, slideTemplate } from '../templates';
import { DialogButtons, AutoField, Modal, openDialog } from './Dialog';

export interface FileEntry {
  name: string;
  /** pages of a deck; null for a diagram */
  pages: number | null;
}

/** The workspace's files with their kind (from /api/files). */
export async function listFiles(): Promise<FileEntry[]> {
  try {
    const r = await fetch('/api/files');
    const d = (await r.json()) as { files: FileEntry[] };
    return d.files;
  } catch {
    return [];
  }
}

async function readFile(name: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/doc?file=${encodeURIComponent(name)}`);
    return r.ok ? ((await r.json()) as { src: string }).src : null;
  } catch {
    return null;
  }
}

const stem = (f: string) => f.replace(/\.charpie$/, '');

function useDecks(exclude?: string | null) {
  const [decks, setDecks] = useState<FileEntry[] | null>(null);
  useEffect(() => {
    listFiles().then((fs) => setDecks(fs.filter((f) => f.pages !== null && f.name !== exclude)));
  }, [exclude]);
  return decks;
}

type Kind = 'diagram' | 'slides';

/** Ask for a name and a kind, create the file and open it. `dir`: folder to create it in. False when cancelled. */
export async function newFileDialog(dir = '', kind?: Kind): Promise<boolean> {
  const ws = useStore.getState().workspace;
  if (!ws.on) {
    // no workspace: start over in this tab
    const k = kind ?? (await openDialog<Kind>((done) => <KindOnlyDialog done={done} />));
    if (!k) return false;
    const st = useStore.getState();
    st.setPage(undefined, { fit: false });
    st.apply(() => (k === 'slides' ? slideTemplate('新しいスライド') : diagramTemplate('新しい図')));
    st.setFileName(k === 'slides' ? 'slides.charpie' : 'untitled.charpie');
    window.dispatchEvent(new Event('charpie:fit'));
    return true;
  }
  const r = await openDialog<{ name: string; src: string }>((done) => <NewFileForm dir={dir} initialKind={kind} done={done} />);
  if (!r) return false;
  const f = await createFile(r.name, r.src);
  if (f) await openFile(f);
  return !!f;
}

function KindOnlyDialog({ done }: { done: (v: Kind | null) => void }) {
  const [kind, setKind] = useState<Kind>('diagram');
  return (
    <Modal title="新規作成" icon={<FilePlus size={16} />} onClose={() => done(null)} onSubmit={() => done(kind)} footer={<DialogButtons ok="作成" onCancel={() => done(null)} />}>
      <KindPicker kind={kind} setKind={setKind} />
      <div className="dlg-msg">今の内容は置き換わります（Ctrl+Z で戻せます）。</div>
    </Modal>
  );
}

function KindPicker({ kind, setKind }: { kind: Kind; setKind: (k: Kind) => void }) {
  return (
    <div className="kind-pick">
      <button type="button" className={'kind-card' + (kind === 'diagram' ? ' on' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => setKind('diagram')}>
        <Shapes size={26} />
        <b>図</b>
        <span>1 枚のキャンバスに図形と矢印</span>
      </button>
      <button type="button" className={'kind-card' + (kind === 'slides' ? ' on' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => setKind('slides')}>
        <Presentation size={26} />
        <b>スライド</b>
        <span>ページとレイアウト（共通部分）</span>
      </button>
    </div>
  );
}

function NewFileForm({ dir, initialKind, done }: { dir: string; initialKind?: Kind; done: (v: { name: string; src: string } | null) => void }) {
  const files = useStore((s) => s.workspace.files);
  const [kind, setKind] = useState<Kind>(initialKind ?? 'diagram');
  const [name, setName] = useState('untitled');
  const [base, setBase] = useState<string>(''); // '' = the standard template
  const [busy, setBusy] = useState(false);
  const decks = useDecks();
  const path = (dir ? dir + '/' : '') + name.trim().replace(/\.charpie$/, '');
  const err = !name.trim() ? null : /[\\:*?"<>|]/.test(name) || name.includes('..') ? '使えない文字が含まれています' : files.includes(path + '.charpie') ? '同じ名前のファイルがあります' : null;

  const submit = async () => {
    if (!name.trim() || err || busy) return;
    const title = name.trim().split('/').pop()!;
    if (kind === 'diagram') return done({ name: path, src: diagramTemplate(title) });
    if (!base) return done({ name: path, src: slideTemplate(title) });
    setBusy(true);
    const other = await readFile(base);
    setBusy(false);
    if (other === null) return;
    done({ name: path, src: slideFromDeck(title, other, base, path + '.charpie') });
  };

  return (
    <Modal title="新規作成" icon={<FilePlus size={16} />} width={500} onClose={() => done(null)} onSubmit={submit} footer={<DialogButtons ok="作成して開く" onCancel={() => done(null)} disabled={!name.trim() || !!err || busy} />}>
      <KindPicker kind={kind} setKind={setKind} />
      <label className="dlg-label">名前{dir && <span className="dlg-sub">（{dir}/ の中）</span>}</label>
      <AutoField value={name} onChange={setName} suffix=".charpie" />
      <div className="dlg-hint">「フォルダ/名前」でフォルダの中に作れます</div>
      {err && <div className="dlg-err">{err}</div>}
      {kind === 'slides' && (
        <>
          <label className="dlg-label">見た目（レイアウト）</label>
          <select className="field" value={base} onChange={(e) => setBase(e.target.value)}>
            <option value="">標準のひな形（タイトル枠・ページ番号・箇条書き）</option>
            {(decks ?? []).map((d) => (
              <option key={d.name} value={d.name}>
                {stem(d.name)} と同じレイアウト（{d.pages} ページのスライド）
              </option>
            ))}
          </select>
          <div className="dlg-hint">{base ? 'そのスライドの set 行・レイアウト・スタイルを取り込み、1 ページ目を用意します。' : '表紙と本文の 2 ページで始まります。'}</div>
        </>
      )}
    </Modal>
  );
}

// ───────────────────────────── layouts ─────────────────────────────

/** Add a layout to the open deck: a blank one, or layouts imported from another deck. Resolves with the layout to show. */
export function layoutDialog(): Promise<string | null> {
  return openDialog<string>((done) => <LayoutForm done={done} />);
}

function LayoutForm({ done }: { done: (v: string | null) => void }) {
  const deck = useStore((s) => s.doc.deck)!;
  const wsOn = useStore((s) => s.workspace.on);
  const current = useStore((s) => s.workspace.file);
  const [tab, setTab] = useState<'new' | 'import'>('new');
  const taken = new Set(deck.layouts.map((l) => l.name));
  const [name, setName] = useState(() => {
    if (!taken.has('default')) return 'default';
    for (let i = 2; ; i++) if (!taken.has(`layout${i}`)) return `layout${i}`;
  });
  const [parent, setParent] = useState<string>(taken.has('default') ? 'default' : '');
  const nameErr = !name ? null : !isValidId(name) ? '英数字と _ で始まる名前にしてください' : taken.has(name) ? '同じ名前のレイアウトがあります' : null;

  // import
  const decks = useDecks(current);
  const [from, setFrom] = useState('');
  const [other, setOther] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!from) return setOther(null);
    setOther(null);
    setPicked(new Set());
    readFile(from).then(setOther);
  }, [from]);
  useEffect(() => {
    if (!from && decks?.length) setFrom(decks[0].name);
  }, [decks, from]);
  const otherLayouts = useMemo(() => (other ? (parse(other).deck?.layouts ?? []) : []), [other]);

  const submit = () => {
    const st = useStore.getState();
    if (tab === 'new') {
      if (!name || nameErr) return;
      st.apply((src, doc) => addLayout(src, doc, name, parent || undefined, [`slot title "タイトル" at (40, 36) size 1200x72`].filter(() => !parent)));
      return done(name);
    }
    if (!other || !picked.size || !current) return;
    let result: ReturnType<typeof importLayouts> | undefined;
    st.apply((src, doc) => (result = importLayouts(src, doc, other, [...picked], (p) => rebasePath(p, from, current))).src);
    if (!result) return done(null);
    const added = result.layouts.filter((n) => !taken.has(n));
    const ren = Object.entries(result.renamed).map(([a, b]) => `${a} → ${b}`);
    if (!added.length) st.notify('同じレイアウトがすでにあります（取り込むものはありませんでした）');
    else st.notify(`レイアウト ${added.length} 個${result.styles.length ? `・スタイル ${result.styles.length} 個` : ''}を取り込みました${ren.length ? `（名前を変更: ${ren.join(', ')}）` : ''}`, 'ok');
    done(result.layouts[result.layouts.length - 1] ?? null);
  };

  const okDisabled = tab === 'new' ? !name || !!nameErr : !picked.size;
  return (
    <Modal title="レイアウトを追加" icon={<LayoutTemplate size={16} />} width={560} onClose={() => done(null)} onSubmit={submit} footer={<DialogButtons ok={tab === 'new' ? '作成' : '取り込む'} onCancel={() => done(null)} disabled={okDisabled} />}>
      <div className="seg dlg-tabs">
        <button type="button" className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>
          新しく作る
        </button>
        <button type="button" className={tab === 'import' ? 'on' : ''} onClick={() => setTab('import')} disabled={!wsOn}>
          他のスライドから取り込む
        </button>
      </div>
      {tab === 'new' ? (
        <>
          <label className="dlg-label">名前</label>
          <AutoField value={name} onChange={setName} mono />
          {nameErr && <div className="dlg-err">{nameErr}</div>}
          <div className="dlg-hint">default という名前のレイアウトは、layout= を書かないページすべてに使われます。</div>
          <label className="dlg-label">継承元</label>
          <select className="field" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">なし（空のレイアウト）</option>
            {deck.layouts.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name} の図形と枠を引き継ぐ
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <label className="dlg-label">取り込み元のスライド</label>
          {decks && !decks.length ? (
            <div className="dlg-msg">ほかにスライドのファイルがありません。</div>
          ) : (
            <select className="field" value={from} onChange={(e) => setFrom(e.target.value)}>
              {(decks ?? []).map((d) => (
                <option key={d.name} value={d.name}>
                  {stem(d.name)}（{d.pages} ページ）
                </option>
              ))}
            </select>
          )}
          {from && (
            <div className="layout-picks">
              {other === null && <div className="dlg-hint">読み込み中…</div>}
              {other !== null && !otherLayouts.length && <div className="dlg-msg">このスライドにはレイアウトがありません。</div>}
              {otherLayouts.map((l) => {
                const on = picked.has(l.name);
                return (
                  <button
                    type="button"
                    key={l.name}
                    className={'layout-pick' + (on ? ' on' : '')}
                    onClick={() => {
                      const next = new Set(picked);
                      if (on) next.delete(l.name);
                      else next.add(l.name);
                      setPicked(next);
                    }}
                  >
                    <img src={`/api/export?file=${encodeURIComponent(from)}&layout=${encodeURIComponent(l.name)}&format=svg`} alt="" />
                    <span className="layout-pick-name">
                      <input type="checkbox" readOnly checked={on} tabIndex={-1} /> {l.name}
                      {l.extends && <span className="dlg-sub"> ← {l.extends}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="dlg-hint">継承元のレイアウトと、使っているスタイルも一緒に取り込みます。同じ名前があるときは番号を付けます。</div>
        </>
      )}
    </Modal>
  );
}
