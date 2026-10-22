# 記法（.charpie）

サーバー起動中は `curl -s localhost:5173/api` で同じ内容の英語版（API 一覧つき）が読めます。

## 図形と矢印

```
# コメント（# の後に空白）
set gap=12 grid=10 padding=8 fontmin=9 fontmax=18

style accent { fill: #eef2ff; stroke: #6366f1; text: #312e81; }

rect    api  "API Gateway"  at (120, 80) size 160x60 .accent
trap    db   "Database"     at (120, 240) size 160x70 fill=#fef3c7
round   grp  "グループ"      at (0, 0) size 400x300 valign=top
rect    c1   "子"           at (20, 40) size 100x50 in=grp
ellipse u    "改行は\nこう"  at (-200, 80) size 120x70
cross   s                   at (400, 80) size 60x60          # ⊗（plus で ⊕）
rect    eq   "更新則\n$\theta_{k+1} = \theta_k - \eta\nabla f$"  at (0, 400) size 260x80

u -> api "request"               # ->  <-  <->  --
api.s -> db.n route=ortho        # ポート n/e/s/w、route straight|curve|ortho
api -> cache route=curve bend=40 dash=dashed
api -> (400, 120) "out"          # 端を座標にできる
api.e -> +(80, 0)                # もう一方の端からの相対座標
```

- 図形: `rect round ellipse diamond trap para hex cross plus text image table list`
- 図形属性: `fill stroke text lw dash(solid|dashed|dotted) font(auto|px) family weight(bold|light) valign(top|middle|bottom) halign(left|center|right) in(親ID) overlap=allow skew radius opacity dir pad rotate src fit`
  - `dir=up|down|left|right` は台形（trap）の短い辺の向き。`pad=N` はその図形だけ文字の余白を変える。
  - `rotate=90|-90|180` は文字だけを回す（`-90` で縦軸ラベルのような下から上への縦書き）。
- 矢印属性: `route bend stroke lw dash text font family fromat toat`（`toat=0.3` で到着点を辺の 30% の位置へ）
- 座標は左上基準、y は下向き。文字は図形に合わせて `fontmin`〜`fontmax` で自動縮小します。
- `ignore=overlap,through` のように書くと、その図形・矢印に関する検査を意図的に黙らせられます（`ignore=all` も可）。

### 数式

ラベル・表・箇条書きの `$...$` はインライン TeX（MathJax）です。`$...$` の中はバックスラッシュ 1 つでそのまま書きます（`\frac` `\nabla` など）。`$` そのものは `\$`。組めない数式は原文のまま表示され、`check` が警告します。TikZ 書き出しでは `$...$` がそのまま LaTeX に渡ります。

### フォント

`set family=…`（ファイル全体）→ `style { family: … }` → 図形の `family=…` の順に上書きします。同梱: `M PLUS Rounded 1c` `M PLUS 1p` `Noto Sans JP` `Noto Serif JP` `BIZ UDPGothic` `BIZ UDPMincho` ほか。Calibri / Arial / Cambria / Times New Roman は幅が同じ互換フォントで描くので、PowerPoint と同じ位置で改行されます。`.charpie` の隣に `fonts/` を置けば任意のフォントも使えます。

### 画像

```
image p "代替テキスト" at (440, 80) size 160x120 src="assets/patch.png" fit=cover
```

`src` は .charpie からの相対パスか URL。`fit=contain|cover|fill`（既定 contain）。ブラウザでは **Ctrl+V で貼り付け / ファイルをドロップ / ツールバーの画像ボタン** で追加でき、`assets/` に保存されます。SVG / PNG には画像が埋め込まれ、TikZ では `\includegraphics` になります。

## 表・箇条書き・図の埋め込み

```
table res at (80, 160) size 700x220 align=l,r {
  | 手法     | 精度 (%) |
  |----------|--------:|     # 見出しの区切り（:--: で寄せ）
  | **提案** | **82.1** |     # セル全体を ** で囲むと太字。$...$ も使える
}                             # cols=2,1（列幅比）· header=N · rules=booktabs|grid|none

list pts at (40, 140) size 600x400 {
  - 項目                      # - * 1. で始める、2 文字下げで入れ子
    - 入れ子
}

image fig at (0, 0) size 600x300 src="overview.charpie"   # 別の図をそのまま描く（#ページID も可）
```

表と箇条書きは中身全体を 1 つの文字サイズで枠に合わせ、収まらなければ `check` がはみ出しとして報告します。

ブラウザではダブルクリックで、表示されている位置のまま編集できます。箇条書きは Enter で次の項目、Tab / Shift+Tab で入れ子、Ctrl+B で太字。表はセルを直接書き換え、Tab・Enter・矢印キーで移動し、スプレッドシートからの貼り付けで複数のセルを一度に埋められます。

## スライド（page / layout / slot）

`page` か `layout` ブロックがあるファイルはスライドになります（無ければ 1 枚の図）。

```
set canvas=1280x720                      # ページの大きさ（既定 1280x720）。はみ出しは check で検出

layout default {                         # 全ページ共通。layout= を書かないページに使われる
  rect band at (0, 0) size 1280x12 fill=#4f46e5 stroke=none
  text pageno "{page} / {pages}" at (1100, 680) size 140x36   # {page} {pages} {title} は埋められる
  slot title "タイトル" at (40, 30) size 1200x70 font=36        # slot = ページが中身を入れる枠
}

layout two extends default {             # 継承：default の図形と枠を引き継いで足す
  slot left  at (40, 120) size 580x540
  slot right list at (660, 120) size 580x540
}

page intro "はじめに" layout=two {
  title "研究背景"                        # 枠を埋める（at / size / 属性を書けばこのページだけ上書き）
  left "本文"
  right {
    - 箇条書きの枠は { } で
  }
  rect a "自由配置" at (100, 300) size 200x80   # 普通の図形・矢印も置ける
  hide pageno                            # このページだけレイアウトの図形を消す
}

page cover "表紙" number=skip { … }       # 番号に数えない（次のページが 1）
```

- ブロックの中は 2 文字下げ。図形 ID はページごとに独立しています。
- `set compat=pptx` を書くと、PowerPoint にあるフォント（Calibri / Arial / Cambria / Times New Roman / BIZ UDPGothic / BIZ UDPMincho）以外を `check` が警告します。これで .pptx でも charpie と同じ位置で改行されます。
- 見本: [diagrams/mae_talk.charpie](../diagrams/mae_talk.charpie)

## 検査される制約

| 検査 | 内容 |
|---|---|
| 重なり | 実際の輪郭（凸多角形, SAT）で判定。`gap` で最小間隔も |
| 文字のはみ出し | `fontmin` でも収まらない / 固定 `font` で収まらない |
| 親からのはみ出し | `in=` の子が親の外に出ている、親の文字が子に隠れる |
| 貫通 | 矢印が無関係な図形やグループの見出しを横切る、矢印ラベルが図形・他ラベルと重なる |
| ページ | スライドで図形がページの外に出ている |
| その他 | 組めない数式、見つからない画像・フォント、`compat=pptx` で使えないフォント |

`fix`（UI の「すべて解消」）は、最小移動での押し出し・親の拡張・図形の拡大・矢印の迂回（ortho / curve）を収束するまで繰り返します。
