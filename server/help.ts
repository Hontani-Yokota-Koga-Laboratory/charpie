export function helpText(base: string, root: string): string {
  return `# Charpie API  (${base})

Charpie is a diagram editor whose source of truth is plain text (.charpie files in ${root}).
The browser UI, the files on disk and this API are kept in sync live.
You can EITHER edit the .charpie files directly (best for writing/restructuring diagrams)
OR call this API (best for reading live state and precise layout operations).

## Read
GET  /api/files                         list diagrams
GET  /api/doc?file=NAME                 nodes / edges (with ids, geometry, line numbers), settings, issues, src
GET  /api/issues?file=NAME              layout problems (overlap, text overflow, arrows through shapes, …)
GET  /api/measure?file=NAME             per shape: font size, text block vs box (slack), and "fit" = the smallest
                                        box that still holds the label as written (use it to tighten boxes)
GET  /api/selection                     what the user has selected in the browser right now
                                        (unsaved: true = the browser holds edits not yet saved to disk)
GET  /api/export?file=NAME&format=svg   or format=tikz (svg embeds the pictures of image shapes)
                                        decks: one page (&page=ID); format=tikz&all=1 = every page as one LaTeX document
GET  /api/export/pdf?file=NAME          PDF via headless Chromium: every page of a deck (or &page=ID), else the diagram
                                        (POST {file, src} renders text not yet saved)
GET  /api/asset?file=NAME&src=PATH      a picture referenced by an image shape (src relative to the .charpie)
GET  /api/fonts?file=NAME&family=F      @font-face CSS for family= fonts ({"css","missing"}); files at /api/font/<id>
GET  /api/fonts/list?file=NAME          family names family= can use ({"families"}: fonts/ next to the file + installed @fontsource packages)
\`file\` may be omitted: defaults to the file open in the browser (or the only file).
Decks (files with page / layout blocks): add \`&page=ID\` or \`&layout=NAME\` to doc / measure / export / ops
(default: the first page). /api/issues checks every page and layout; each issue has "view": "page ID".
/api/doc includes "deck": pages, layouts, the view and its empty slots; shapes from the layout are "locked".

## Write
PUT  /api/doc?file=NAME                 body = full .charpie text (creates the file if missing)
POST /api/ops?file=NAME                 body = one op or a JSON array of ops (applied atomically)
     add "?strict=1" to reject the change (409) if it introduces new errors
POST /api/asset?file=NAME&name=x.png   body = image bytes (Content-Type image/png|jpeg|gif|webp|svg+xml);
                                        saved as assets/x-<hash>.png next to the .charpie → {"src":"assets/…"}
POST /api/open    {"file":"NAME","page":"ID"}            show this file (and page / "layout") in the user's browser
POST /api/select  {"nodes":["id"],"edges":["a->b#0"],"page":"ID"}   highlight shapes for the user

Ops:
  {"op":"add","kind":"rect","id":"api","label":"API","x":0,"y":0,"w":140,"h":60}
  {"op":"add","label":"Cache","near":"api","dir":"right"}          # auto placement (dir: right|left|below|above)
  {"op":"add","label":"child","parent":"group1"}                   # in=group1
  {"op":"connect","from":"api","to":"db","label":"SQL","arrow":"->","attrs":{"route":"ortho"}}
  {"op":"set","id":"api","label":"API Gateway","attrs":{"fill":"#eef2ff","stroke":null}}  # null removes
  {"op":"set","ids":["a","b"],"w":160}
  {"op":"set-edge","from":"api","to":"db","attrs":{"dash":"dashed"},"label":"reads"}
  {"op":"move","id":"api","dx":20,"dy":0}   or  {"op":"move","id":"api","x":100,"y":40}
  {"op":"remove","ids":["api"],"edges":["a->b#0"]}
  {"op":"rename","id":"api","to":"gateway"}
  {"op":"align","ids":["a","b","c"],"mode":"top"}          # left|hcenter|right|top|vcenter|bottom
  {"op":"distribute","ids":["a","b","c"],"axis":"h"}
  {"op":"match-size","ids":["a","b"],"mode":"width"}       # width|height|both
  {"op":"stack","ids":["a","b","c"],"axis":"v","gap":24}
  {"op":"fix"}                                             # auto-resolve all layout problems
  {"op":"setting","key":"gap","value":12}
  decks:
  {"op":"add-page","id":"p4","label":"結果","layout":"two","after":"p3"}   # a plain diagram becomes page p1 + this
  {"op":"duplicate-page","id":"p3","to":"p3b"}   {"op":"move-page","id":"p3","index":0}   {"op":"remove-page","id":"p3"}
  {"op":"set-page","id":"p3","label":"新しい名前","layout":"two","rename":"intro"}     # layout null = none
  {"op":"add-layout","name":"wide","extends":"default"}
  shape ops apply to the page / layout given by ?page= / ?layout= ; a layout's shapes are read-only from a page

Every write responds with {"ok":true,"file","created":[ids],"issues":[…],"errors":N}.
After writing, check "errors" — fix overlaps/overflow with {"op":"fix"} or by adjusting geometry.

## .charpie syntax (cheat sheet)
  # comment
  set gap=12 grid=10 padding=8 fontmin=9 fontmax=18 family="M PLUS 1p"
  style accent { fill: #eef2ff; stroke: #6366f1; text: #312e81; family: M PLUS Rounded 1c; }
  rect   api "API Gateway" at (120, 80) size 160x60 .accent
  round  grp "Group" at (0, 0) size 400x300 valign=top
  rect   c1  "Child" at (20, 40) size 100x50 in=grp
  user -> api "request"          # -> <- <-> --
  api.s -> db.n route=ortho      # ports n/e/s/w ; route straight|curve|ortho ; bend=40
  api -> (400, 120) "out"        # an end can be a point: (x, y), or +(dx, dy) relative to the other end
  (0, 50) -> api                 #   (relative = from the other end's port, else its centre)
  rect m "Step $\\theta_{k+1} = \\theta_k - \\eta\\nabla f$" ...   # $...$ = inline TeX (MathJax); write backslashes once; \\$ = a literal $
  rect b "構造を**テキストで指定**する" ...   # **...** = bold span (labels, arrow labels, table cells, list items; wraps
                                             #   across lines; an unpaired ** is plain text; inside $...$ it is TeX)
  kinds: rect round ellipse diamond trap para hex cross plus text image   (cross = ⊗, plus = ⊕; aliases otimes / oplus)
  image p "alt text" at (0, 0) size 160x120 src="assets/patch.png" fit=cover
              # src = path relative to the .charpie file (or a URL); fit = contain (default) | cover | fill
              # the label is alt text only (not drawn); no frame unless stroke= is given
  family = font family: set family=… (whole file) → style family: … → family=… on a shape / arrow;
              family=default = the built-in font (Inter + Japanese fallback). Text is drawn and measured as written
              (no ligatures: "->" stays two characters). Found in: fonts/ next to the .charpie (.ttf/.otf/.woff2,
              the name inside the file), else an installed npm package @fontsource/<kebab-name>
              (bundled: "M PLUS Rounded 1c", "M PLUS 1p"). Missing → check warns (font) and the default is used.
              Browser, PNG/PDF export and check/measure use the same files; SVG export embeds the needed subsets;
              TikZ selects it with luatexja-fontspec (the font must be installed for lualatex).
  node attrs: fill stroke text lw dash(solid|dashed|dotted) font(auto|px) family weight(bold|light)
              valign(top|middle|bottom) in(parent id) overlap=allow skew radius opacity
              dir(up|down|left|right: short side of a trap) pad(text padding, overrides set padding)
              halign(left|center|right) rotate(90|-90|180: turn the label; the shape stays upright)
  edge attrs: route bend stroke lw dash text font family fromat toat (0..1: slide a port along its side)
  ignore=all | ignore=overlap,through,...   (shapes, arrows and styles) silence checks that involve this item;
              names: overlap gap text contain covered through label loop tex page font
  x,y = top-left corner, y grows downward. Text auto-shrinks to fit (fontmin..fontmax).

  table t at (80, 160) size 700x220 align=l,r,r {      # Markdown rows; |---| marks the header (and :--: alignment)
    | Method | Acc (%) | Params |                       # cols=2,1,1 relative widths · header=N · rules=booktabs|grid|none
    |--------|--------:|-------:|                       # **bold** (whole cell or part); $...$ works in cells
    | **VOLTA input** | crop 2x bbox {.note} || {.sec} # || = the cell before spans one more column (MultiMarkdown)
    | Ours   | 82.1    | 22M    | {indent=1}           # {…} after a cell: that cell; after the last |: the row
  }                                                     # keys: fill text(colour) weight(bold|normal|light) scale(0.85 =
                                                        #   smaller text) indent(em) align(l|c|r) .style (a style's
                                                        #   fill/text/weight/scale/indent/align). Row: fill paints the
                                                        #   row, indent indents its first cell, the rest apply to every cell
  list l at (40, 140) size 600x400 levelscale=1,1,0.85 {   # - / * / 1. items, nest with 2 more spaces;
    - first **bold part**                               # bullets ● ○ ■ by level (repeating); one font size fitted to
      - nested                                          #   the box; levelscale = relative size per level (default 1,0.9)
  }
  list spacing (em of the fitted size): lineheight=1.8 (line pitch, also between wrapped lines; default 1.25)
              itemgap=0 (extra space between items; default 0.55 / 0.3 nested) indent=2 (per level; default 1.5)
              markgap=1.3 (bullet's left edge to the text; default 1.1). table: lineheight= too.
  table / list: valign=top|middle|bottom and halign=left|center|right place the content in the box
              (without valign a table stretches its rows to the box height; a list sits at the top-left)
  image fig at (0, 0) size 600x300 src="other.charpie#page"   # another diagram drawn inline (fit=contain|cover)

## Slides: decks
  set canvas=1280x720                    # the page (default 1280x720); shapes must stay inside (check: page)
  layout default {                       # shared by every page (a page without layout= uses "default")
    text pageno "{page} / {pages}" at (1100, 680) size 140x30     # {page} {pages} {title} are filled in
    slot title "タイトル" at (40, 30) size 1200x70 .title           # slot NAME [kind] ["sample"] at … size …
  }
  layout two extends default {           # inherits default's shapes and slots
    slot left at (40, 120) size 580x540
    slot right list at (660, 120) size 580x540
  }
  page intro "はじめに" layout=two {       # page ID ["name"] [layout=NAME] { … }
    title "研究背景"                       # fill a slot: SLOT ["text"] [at …] [size …] [attrs]
    right {                              # a block slot (list / table) takes its lines in { }
      - 項目
    }
    rect a "自由配置" at (100, 200) size 200x80   # pages hold ordinary shapes and arrows too
    hide pageno                          # drop layout shapes on this page only
  }
  Shape ids are per page. CLI: check / fix / measure go page by page;
  export --page ID (svg/png/tikz) · export -o deck.pdf (all pages)

## Layout rules that are checked continuously
  - shapes must not overlap (except parent/child via in=, or overlap=allow); keep >= gap apart
  - text must fit inside its shape at >= fontmin (or the fixed font)
  - children must stay inside their parent; a parent's label must not be covered by children
  - arrows must not pass through unrelated shapes; arrow labels must not overlap shapes
`;
}
