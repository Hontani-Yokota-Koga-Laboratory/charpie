import { useStore } from './store';
import { extractText, pasteText, removeItems, setEdgesAttr, setNodesAttr } from './dsl/patch';
import { IGNORE_NAME, type Issue } from './check/check';

export function deleteSelection() {
  const s = useStore.getState();
  const sel = s.selection;
  if (!sel.nodes.length && !sel.edges.length) return;
  s.apply((src, doc) => removeItems(src, doc, sel.nodes, sel.edges));
  s.clearSelection();
}

export function duplicateSelection() {
  const s = useStore.getState();
  if (!s.selection.nodes.length) return;
  const text = extractText(s.src, s.doc, s.selection.nodes, s.selection.edges);
  const r = pasteText(s.src, s.doc, text, 24, 24);
  s.setSource(r.src);
  s.select({ nodes: r.ids });
}

export function editSelection() {
  const s = useStore.getState();
  if (s.selection.nodes.length === 1) s.setEditing({ type: 'node', id: s.selection.nodes[0] });
  else if (s.selection.edges.length === 1 && !s.selection.nodes.length) s.setEditing({ type: 'edge', id: s.selection.edges[0] });
}

type Item = { kind: 'node'; id: string } | { kind: 'edge'; key: string };

function itemAttrs(item: Item): Record<string, string> | undefined {
  const doc = useStore.getState().doc;
  return item.kind === 'node' ? doc.nodeMap.get(item.id)?.attrs : doc.edges.find((e) => e.key === item.key)?.attrs;
}

export function ignoreList(attrs: Record<string, string> | undefined): string[] {
  return (attrs?.ignore ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

function writeIgnore(item: Item, names: string[]) {
  const v = names.length ? names.join(',') : undefined;
  useStore.getState().apply((src, doc) => (item.kind === 'node' ? setNodesAttr(src, doc, [item.id], 'ignore', v) : setEdgesAttr(src, doc, [item.key], 'ignore', v)));
}

/** Which item an issue's `ignore=` goes on: a selected one if involved, else the arrow, else the first shape. */
function ignoreTarget(issue: Issue): Item | undefined {
  const sel = useStore.getState().selection;
  const e = issue.edges.find((k) => sel.edges.includes(k)) ?? (sel.nodes.some((id) => issue.nodes.includes(id)) ? undefined : issue.edges[0]);
  if (e) return { kind: 'edge', key: e };
  const n = issue.nodes.find((id) => sel.nodes.includes(id)) ?? issue.nodes[0];
  return n ? { kind: 'node', id: n } : undefined;
}

/** Silence this kind of issue on one of the items involved (adds to its `ignore=` list). */
export function ignoreIssue(issue: Issue) {
  const item = ignoreTarget(issue);
  if (!item) return;
  const name = IGNORE_NAME[issue.code];
  const cur = ignoreList(itemAttrs(item));
  if (!cur.includes(name) && !cur.includes('all')) writeIgnore(item, [...cur, name]);
  const label = item.kind === 'node' ? `「${item.id}」` : 'この矢印';
  useStore.getState().notify(`${label}に ignore=${name} を付けました（Ctrl+Z で戻せます）`, 'ok');
}

/** Bring an ignored issue back: drop its kind (or `all`) from every involved item. */
export function unignoreIssue(issue: Issue) {
  const name = IGNORE_NAME[issue.code];
  const items: Item[] = [...issue.nodes.map((id) => ({ kind: 'node', id }) as Item), ...issue.edges.map((key) => ({ kind: 'edge', key }) as Item)];
  for (const it of items) {
    const cur = ignoreList(itemAttrs(it));
    if (cur.includes(name) || cur.includes('all')) writeIgnore(it, cur.filter((x) => x !== name && x !== 'all'));
  }
}

export function setIgnore(item: Item, names: string[]) {
  writeIgnore(item, names);
}
