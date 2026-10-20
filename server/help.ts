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
GET  /api/export?file=NAME&format=svg   or format=tikz
\`file\` may be omitted: defaults to the file open in the browser (or the only file).

## Write
PUT  /api/doc?file=NAME                 body = full .charpie text (creates the file if missing)
POST /api/ops?file=NAME                 body = one op or a JSON array of ops (applied atomically)
     add "?strict=1" to reject the change (409) if it introduces new errors
POST /api/open    {"file":"NAME"}       show this file in the user's browser
POST /api/select  {"nodes":["id"],"edges":["a->b#0"]}   highlight shapes for the user

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

Every write responds with {"ok":true,"file","created":[ids],"issues":[…],"errors":N}.
After writing, check "errors" — fix overlaps/overflow with {"op":"fix"} or by adjusting geometry.

## .charpie syntax (cheat sheet)
  # comment
  set gap=12 grid=10 padding=8 fontmin=9 fontmax=18
  style accent { fill: #eef2ff; stroke: #6366f1; text: #312e81; }
  rect   api "API Gateway" at (120, 80) size 160x60 .accent
  round  grp "Group" at (0, 0) size 400x300 valign=top
  rect   c1  "Child" at (20, 40) size 100x50 in=grp
  user -> api "request"          # -> <- <-> --
  api.s -> db.n route=ortho      # ports n/e/s/w ; route straight|curve|ortho ; bend=40
  api -> (400, 120) "out"        # an end can be a point: (x, y), or +(dx, dy) relative to the other end
  (0, 50) -> api                 #   (relative = from the other end's port, else its centre)
  rect m "Step $\\theta_{k+1} = \\theta_k - \\eta\\nabla f$" ...   # $...$ = inline TeX (MathJax); write backslashes once; \\$ = a literal $
  kinds: rect round ellipse diamond trap para hex cross plus text   (cross = ⊗, plus = ⊕; aliases otimes / oplus)
  node attrs: fill stroke text lw dash(solid|dashed|dotted) font(auto|px) weight(bold|light)
              valign(top|middle|bottom) in(parent id) overlap=allow skew radius opacity
              dir(up|down|left|right: short side of a trap) pad(text padding, overrides set padding)
              halign(left|center|right) rotate(90|-90|180: turn the label; the shape stays upright)
  edge attrs: route bend stroke lw dash text font fromat toat (0..1: slide a port along its side)
  ignore=all | ignore=overlap,through,...   (shapes, arrows and styles) silence checks that involve this item;
              names: overlap gap text contain covered through label loop tex
  x,y = top-left corner, y grows downward. Text auto-shrinks to fit (fontmin..fontmax).

## Layout rules that are checked continuously
  - shapes must not overlap (except parent/child via in=, or overlap=allow); keep >= gap apart
  - text must fit inside its shape at >= fontmin (or the fixed font)
  - children must stay inside their parent; a parent's label must not be covered by children
  - arrows must not pass through unrelated shapes; arrow labels must not overlap shapes
`;
}
