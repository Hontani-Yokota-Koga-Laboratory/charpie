export const SAMPLE = `# Charpie — テキストが正本の概念図エディタ
# キャンバスでドラッグしても、このテキストを書き換えても同じ図になります。
set gap=12 grid=10

style io    { fill: #ecfeff; stroke: #0891b2; text: #164e63; }
style core  { fill: #eef2ff; stroke: #6366f1; text: #312e81; }
style guard { fill: #fff1f2; stroke: #e11d48; text: #881337; weight: 600; }
style group { fill: #f8fafc; stroke: #94a3b8; dash: dashed; text: #475569; valign: top; }

ellipse you "あなた" at (0, 200) size 120x70 fill=#fefce8 stroke=#ca8a04
round dsl "テキスト（正本）\\n.charpie" at (220, 40) size 180x64 .io
round canvas "キャンバス UI" at (220, 330) size 180x64 .io

round engine "エンジン" at (480, 0) size 300x440 .group font=13
rect parser "Parser" at (520, 50) size 220x56 .core in=engine
rect layout "Layout\\nフォント自動調整" at (520, 140) size 220x64 .core in=engine
diamond checker "制約チェッカー" at (520, 240) size 220x90 .guard in=engine
para export "SVG / PNG / TikZ" at (520, 360) size 220x56 fill=#ecfdf5 stroke=#059669 in=engine

you -> dsl "直接編集"
you -> canvas "ドラッグ"
dsl -> parser
parser -> layout
layout -> checker
checker -> canvas "警告"
canvas -> dsl "差分パッチ" dash=dashed
layout.e -> export.e route=ortho
`;
