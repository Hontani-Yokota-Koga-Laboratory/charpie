# Charpie

**テキストが正本**の概念図エディタ。キャンバスでドラッグしても、右のテキストを書き換えても、同じ 1 つの `.charpie` テキストが更新されます。
重なり・文字のはみ出し・矢印の貫通を常時チェックし、ワンクリックで解消できます。

```bash
npm install
npm run build
npm run serve    # diagrams/ の *.charpie を同期しながら http://localhost:5173 で起動
# 任意のディレクトリ: node dist-server/cli.js serve path/to/dir

npm run dev      # 開発用（同じ API 付き。対象は $CHARPIE_DIR か ./diagrams）
npm test
```

`diagrams/` は各自の作業場で、見本の [diagrams/mae_example.charpie](diagrams/mae_example.charpie)（MAE の概要図）以外は git 管理しません（`.gitignore` 済み）。

## 人間が書いた説明
- AI エージェントで概念図を書くためのツールです。
    - 主にスライドに載せる用途で使えます。
    - 論文に載せるなどの用途は一応非推奨です。
- **How to use**
    - clone して、`xx/のディレクトリのモデルを、 sample図を参考に概念図におこして` だけで図ができます。
    - 検証環境は Claude Code, Opus 5.5, effort max です。
- **このアプリを使うメリットは？**
    - 特にありません。最近は、draw.io なんかも MCP サーバーで AI 連携ができるそうです。
    - この生成 AI 時代、同じようなツールを作っている人なんていくらでもいると思います。
    - このアプリの共有はあくまで、「こういうの便利だったよ！」の共有に過ぎません。
    - （強いて言えば、すでにサンプルが作られている分、AIへの指示が少し楽かもしれません）

## デモ

見本の [diagrams/mae_example.charpie](diagrams/mae_example.charpie)（MAE の概要図）。`npm run serve` で開くとこの図が出ます。

![MAE の概要図](docs/mae_example.png)

### UI

<img width="1920" height="936" alt="image" src="https://github.com/user-attachments/assets/6dbd8a4b-af58-49bc-9a81-94afaf692c4b" />


## Claude Code 連携

`charpie serve` 中はディスク上の `.charpie` とブラウザが双方向に同期され、`/api` から状態の取得・操作ができます。
Claude Code はファイルを直接編集しても、`curl localhost:5173/api/...` で操作してもよく、
PostToolUse hook（`charpie hook`）で編集のたびに重なり・はみ出しを検査させられます。→ [docs/claude-code.md](docs/claude-code.md)

CLI:

```
charpie serve [dir] [--port 5173] [--host]
charpie check <file...> [--json]      # エラーがあれば exit 1
charpie fix <file...>
charpie export <file> --format svg|tikz [-o out]
charpie hook                          # Claude Code PostToolUse hook
```

## DSL

```
# コメント
set gap=12 grid=10 padding=8 fontmin=9 fontmax=18

style accent { fill: #eef2ff; stroke: #6366f1; text: #312e81; }

rect    api  "API Gateway"  at (120, 80) size 160x60 .accent
trap    db   "Database"     at (120, 240) size 160x70 fill=#fef3c7
round   grp  "グループ"      at (0, 0) size 400x300 valign=top
rect    c1   "子"           at (20, 40) size 100x50 in=grp
image   p    "病理パッチ"    at (440, 80) size 160x120 src="assets/patch.png" fit=cover

user -> api "request"            # ->  <-  <->  --
api.s -> db.n route=ortho        # ポート n/e/s/w
api -> cache route=curve bend=40 dash=dashed
```

- 図形: `rect round ellipse diamond trap para hex text image`
- 画像: `image` は `src=`（.charpie からの相対パスか URL）の画像を枠に描きます。`fit=contain|cover|fill`（既定 contain）。ラベルは代替テキストで描かれません。枠線は `stroke=` を付けたときだけ。
  ブラウザでは **Ctrl+V で貼り付け / ファイルをドロップ / ツールバーの画像ボタン** で追加でき、画像は .charpie と同じフォルダの `assets/` に保存されます。SVG / PNG 書き出しには画像が埋め込まれ、TikZ は `\includegraphics`（graphicx）になります。
- 図形属性: `fill stroke text lw dash font(auto|px) weight valign in overlap=allow skew radius opacity`
- 矢印属性: `route(straight|curve|ortho) bend stroke lw dash text font`

UI からの編集は該当箇所だけを書き換えるので、コメント・行順・桁揃えが保たれ、`git diff` が小さく保てます。

### 表・箇条書き・図の埋め込み

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

## スライド（ベータ）

`page` / `layout` ブロックを書いたファイルはスライドになります（書かなければ今まで通りの 1 枚の図）。

```
set canvas=1280x720                      # ページの大きさ（既定 1280x720）。はみ出しは check で検出

layout default {                         # 全ページ共通。layout= を書かないページに使われる
  rect band at (0, 0) size 1280x12 fill=#4f46e5 stroke=none
  text pageno "{page} / {pages}" at (1100, 680) size 140x30   # {page} {pages} {title} は埋められる
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
```

- 共通部分はレイアウトに 1 回だけ書きます。ページではレイアウト由来の図形は薄く表示され、触れません。左の「レイアウト」から編集モードに入ると、そのレイアウトを使う全ページに反映されます。
- 左のページ一覧で追加・複製・並べ替え（ドラッグ）・削除・レイアウト変更。空の枠はダブルクリックで埋められます。
- **F5** で発表。PDF はエクスポートメニュー（印刷から保存）か `charpie export deck.charpie -o deck.pdf`。
- SVG / PNG / TikZ は表示中のページ単位。TikZ は「全ページ」で 1 つの LaTeX 文書（`lualatex` でコンパイル、日本語は `luatexja`）にもでき、各ページはスライドの大きさで切り取られます。埋め込んだ図も入ります。
- 新規作成で「図」か「スライド」を選びます。スライドは標準のひな形か、既存のスライドと同じレイアウトで始められます。レイアウトは他のスライドから取り込めます（継承元とスタイルも一緒に、同じものは重複させません）。
- CLI / API はページごとに検査します（`check` は全ページ、`--page ID` / `?page=ID` で 1 ページ）。

## 整合性チェック

| 検査 | 内容 |
|---|---|
| 重なり | 実際の輪郭（凸多角形, SAT）で判定。`gap` で最小間隔も |
| 文字のはみ出し | `fontmin` でも収まらない / 固定 `font` で収まらない |
| 親からのはみ出し | `in=` の子が親の外に出ている、親の文字が子に隠れる |
| 貫通 | 矢印が無関係な図形を横切る、矢印ラベルが図形・他ラベルと重なる |

「すべて解消」は、最小移動での押し出し・親の拡張・図形の拡大・矢印の迂回（ortho / curve）を収束するまで繰り返します。

## 構成

```
src/dsl/       parse.ts（耐エラー・位置情報付き）, patch.ts（最小差分の書き換え）
src/geom/      輪郭・SAT・クリッピング・レイキャスト
src/text/      計測・折り返し（日本語禁則）・フォントサイズ二分探索, blocks.ts（表・箇条書き）
src/layout.ts  スタイル解決・矢印ルーティング
src/check/     check.ts（検査）, resolve.ts（自動解消）
src/ops/       整列・等幅・等間隔
src/export.ts  SVG / PNG / TikZ
src/components Canvas / CodePanel (CodeMirror 6) / Inspector / Chrome / Pages（ページ一覧・発表）/ Tools（ツールバー・挿入パレット）
src/remote.ts  サーバーとのライブ同期（SSE + 楽観ロック）
server/        workspace（監視・読み書き）, api, core（操作）, measure（Inter 実測）, cli
```
