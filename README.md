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
- How to use
    - clone して、`xx/のディレクトリのモデルを、 sample図を参考に概念図におこして` だけで図ができます。
    - 検証環境は Claude Code, Opus 5.5, effort max です。
- このアプリを使うメリットは？
    - 特にありません。最近は、draw.io なんかも MCP サーバーで AI 連携ができるそうです。
    - この生成 AI 時代、同じようなツールを作っている人なんていくらでもいると思います。
    - このアプリの共有はあくまで、「こういうの便利だったよ！」の共有に過ぎません。
    - （強いて言えば、すでにサンプルが作られている分、AIへの指示が少し楽かもしれません）

## デモ

見本の [diagrams/mae_example.charpie](diagrams/mae_example.charpie)（MAE の概要図）。`npm run serve` で開くとこの図が出ます。

![MAE の概要図](docs/mae_example.png)

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

user -> api "request"            # ->  <-  <->  --
api.s -> db.n route=ortho        # ポート n/e/s/w
api -> cache route=curve bend=40 dash=dashed
```

- 図形: `rect round ellipse diamond trap para hex text`
- 図形属性: `fill stroke text lw dash font(auto|px) weight valign in overlap=allow skew radius opacity`
- 矢印属性: `route(straight|curve|ortho) bend stroke lw dash text font`

UI からの編集は該当箇所だけを書き換えるので、コメント・行順・桁揃えが保たれ、`git diff` が小さく保てます。

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
src/text/      計測・折り返し（日本語禁則）・フォントサイズ二分探索
src/layout.ts  スタイル解決・矢印ルーティング
src/check/     check.ts（検査）, resolve.ts（自動解消）
src/ops/       整列・等幅・等間隔
src/export.ts  SVG / PNG / TikZ
src/components Canvas / CodePanel (CodeMirror 6) / Inspector / Chrome
src/remote.ts  サーバーとのライブ同期（SSE + 楽観ロック）
server/        workspace（監視・読み書き）, api, core（操作）, measure（Inter 実測）, cli
```
