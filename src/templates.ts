/** Text a new file starts from: a diagram, a slide deck, or a deck that takes another deck's look. */
import { parse } from './dsl/parse';
import { addPage, importLayouts, quote, rebasePath } from './dsl/patch';

export function diagramTemplate(title: string): string {
  return `# ${title}\nset gap=12 grid=10\n\n`;
}

/** A deck with a shared look (title, page number), a body layout, a cover and one content page. */
export function slideTemplate(title: string): string {
  return `# ${title}
set canvas=1280x720 gap=12 grid=10 fontmin=12 fontmax=32

style title { font: 36; weight: bold; halign: left; text: #0f172a; stroke: none; fill: none; }
style muted { font: 14; text: #64748b; stroke: none; fill: none; }
style body  { halign: left; valign: top; stroke: none; fill: none; }

# 全ページ共通：タイトル枠とページ番号
layout default {
  slot  title  "タイトル"         at (40, 36) size 1200x72 .title
  text  pageno "{page} / {pages}" at (1100, 672) size 140x36 .muted halign=right
}

# 本文が箇条書き 1 枚
layout content extends default {
  slot  body list at (40, 132) size 1200x520 .body
}

page cover "表紙" {
  title ${quote(title)} at (40, 280) size 1200x96 font=48 halign=center
  hide  pageno
}

page p2 layout=content {
  title "見出し"
  body {
    - 項目
  }
}
`;
}

/**
 * A new deck that looks like `other`: its \`set\` line, all its layouts and the styles they use,
 * and one page on its default (or first) layout. Picture paths are rebased from `otherFile` to `file`.
 */
export function slideFromDeck(title: string, other: string, otherFile: string, file: string): string {
  const od = parse(other);
  const set = od.settingsSpan ? other.slice(od.settingsSpan.from, od.settingsSpan.to) : 'set canvas=1280x720';
  let src = `# ${title}\n${set}\n\n`;
  const layouts = od.deck?.layouts.map((l) => l.name) ?? [];
  src = importLayouts(src, parse(src), other, layouts, (p) => rebasePath(p, otherFile, file)).src;
  const d = parse(src);
  const lay = d.deck?.layouts ?? [];
  const def = lay.find((l) => l.name === 'default') ?? lay[0];
  const titleSlot = def && parse(src, { layout: def.name }).nodes.some((n) => n.slot === 'title');
  return addPage(src.replace(/\s*$/, '\n'), d, { id: 'p1', layout: def && def.name !== 'default' ? def.name : undefined, lines: titleSlot ? [`title ${quote(title)}`] : [] });
}
