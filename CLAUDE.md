# Charpie

テキスト（`.charpie`）が正本の概念図エディタ。ブラウザ UI・ディスク上のファイル・HTTP API が常に同期する。

## 図を編集するとき

図は `diagrams/*.charpie`。ユーザーは `npm run serve`（= `node dist-server/cli.js serve diagrams`）でブラウザを開いていることが多い。

- **図を書く・大きく直す** → `.charpie` を直接編集してよい。ブラウザに即反映される。
- **編集したら必ず検査** → `node dist-server/cli.js check diagrams/<file>.charpie`。エラーが 0 になるまで直す。
- **見た目は PNG で目視** → `node dist-server/cli.js export diagrams/<file>.charpie -o $TMPDIR/x.png --scale 1` を書き出して Read で確認する（ヘッドレス Chromium。`check` は通っても余白や詰まり具合は画像でしか分からない）。
  - 自動解消: `node dist-server/cli.js fix diagrams/<file>.charpie`（最小移動で押し出し・親を拡張・矢印を迂回）
- **箱の大きさを文字に合わせる** → `node dist-server/cli.js measure diagrams/<file>.charpie`。図形ごとに使われているフォントサイズ、文字の実寸と余り（`slack`、負なら溢れ）、そのラベルが書いたとおりの改行で収まる最小サイズ（`fit`）が出る。`fit` より 1px でも小さいと `check` で収まらなくなる。箱を詰めるときは `fit` に少し足した値で揃える（API は `GET /api/measure`）。
- **ユーザーが「この図形」「選んでるやつ」と言ったら** → `curl -s localhost:5173/api/selection`
- ブラウザは既定で「保存ボタンを押したときだけ書き込む」。`/api/selection` の `unsaved: true` はユーザーが未保存の編集を持っている状態で、ディスク（とファイル編集）の内容はまだそれを含まない。その間にファイルを書き換えると、ユーザーの保存時に上書き確認が出る。
- サーバーが起動中なら `curl -s localhost:5173/api` に API と記法の全説明がある。
  - 状態: `GET /api/doc`（図形・座標・行番号）, `GET /api/issues`, `GET /api/measure`（文字の実寸と `fit`）
  - 操作: `POST /api/ops`（`add` `connect` `set` `move` `align` `match-size` `distribute` `stack` `fix` …、`?strict=1` でエラー増加を拒否）
  - ユーザーに見せる: `POST /api/open {"file":"x.charpie"}`, `POST /api/select {"nodes":["id"]}`
  - curl が localhost に届かない（サンドボックス）場合はファイル編集 + `check` で十分。
- `dist-server/cli.js` が無ければ先に `npm run build`。

### 記法

```
# コメント（# の後に空白）
set gap=12 grid=10 padding=8 fontmin=9 fontmax=18

style accent { fill: #eef2ff; stroke: #6366f1; text: #312e81; }

rect    api  "API Gateway"   at (120, 80) size 160x60 .accent
round   grp  "グループ"       at (0, 0) size 400x300 valign=top
rect    c1   "子"            at (20, 40) size 100x50 in=grp
ellipse u    "改行は\nこう"   at (-200, 80) size 120x70

u -> api "request"               # -> <- <-> --
api.s -> db.n route=ortho        # ポート n/e/s/w, route straight|curve|ortho, bend=40
api -> (400, 120) "out"          # 端を座標にできる（何もない所への矢印）
api.e -> +(80, 0)                # もう一方の端（ポート指定ならポート、無ければ中心）からの相対
rect    eq   "更新則\n$\theta_{k+1} = \theta_k - \eta\nabla f$"  at (0, 400) size 260x80   # $...$ は TeX（MathJax）
```

- ラベル（図形・矢印）の `$...$` はインライン TeX。`$...$` の中ではバックスラッシュは 1 つでそのまま書く（`\frac` `\nabla` など。`\n` も改行ではなく TeX）。外側で `$` そのものを出すときは `\$`。数式は折り返されない。組めない数式は原文のまま表示され、`check` が `tex` 警告を出す。TikZ 書き出しでは `$...$` がそのまま渡る。

- 図形: `rect round ellipse diamond trap para hex cross plus text image`（`cross` = ⊗ / `plus` = ⊕、別名 `otimes` `oplus`。ラベル無しで `cross s at (x, y) size 60x60` のように書く）
- 画像: `image p "代替テキスト" at (x, y) size 160x120 src="assets/x.png" fit=cover`。`src` は .charpie からの相対パス（か URL）、`fit=contain|cover|fill`（既定 contain）。ラベルは描かれない（文字の検査対象外）。枠線は `stroke=` を付けたときだけ。ブラウザでは Ctrl+V / ドロップ / ツールバーで追加でき、`assets/<名前>-<hash>.png` に保存される（API: `POST /api/asset`）。`check` は画像ファイルが無いと警告する。外部の画像を使うときは `assets/` にコピーしてから参照する。
- 図形属性: `fill stroke text lw dash(solid|dashed|dotted) font(auto|px) weight(bold|light) valign(top|middle|bottom) in(親ID) overlap=allow skew radius opacity dir pad halign rotate src fit`
  - `rotate=90|-90|180` は文字だけを回す（図形は回らない）。`-90` は下から上に読む縦書き（縦軸ラベルなど）、`90` は上から下。`halign`/`valign` は回転後も画面上の左右上下の意味。
  - `dir=up|down|left|right` は trap の短い辺の向き（`trap enc "Encoder" ... dir=right` で右すぼまりの横向き台形）。`pad=N` はその図形だけ文字の余白を変える（グループ見出しを枠線から離すなど）。`halign=left|right` で文字を左右に寄せる（グループ見出しを左上に置くと矢印と干渉しにくい）。
- 矢印属性: `route bend stroke lw dash text font fromat toat ignore`（`toat=0.3` で到着ポートを辺の 30% の位置へずらす。大きな枠の上辺の好きな位置に矢印を落とすときに使う）
- 座標は左上基準、y は下向き。文字は図形に合わせて自動縮小（fontmin〜fontmax）。
- 矢印のキーは `from->to#n`（例 `api->db#0`）。座標の端は `*` になる（例 `api->*#0`）。`connect` op の from/to にも `"(400, 120)"` を渡せる。
- `ignore=` で警告を意図的に黙らせられる（図形・矢印・style に書ける）。`ignore=all` か `ignore=overlap,through` のように種類を列挙（overlap gap text contain covered through label loop tex）。その警告は `check` から消え、件数だけ `(N ignored)` と出る。**自分で警告を消す目的では使わない**（直せるものは直す）。ユーザーが付けたものは尊重する。

### 検査される制約（守ること）

- 図形同士が重ならない（`in=` の親子と `overlap=allow` は除く）。`set gap=N` があれば N px 以上離す。
- 文字が fontmin 以上で図形に収まる（`font=` 固定ならそのサイズで）。長いラベルは図形を大きくするか `\n` で改行。
- 子（`in=`）は親の内側。グループのラベルは `valign=top` にして子で隠さない。
- 矢印が無関係な図形を横切らない（`route=ortho` や `bend=` で迂回）。グループの見出し文字も横切らない。矢印ラベルが図形に重ならない。

### レイアウトのコツ

- 横並びの間隔は 60〜80px（矢印ラベルを付けるなら ラベル幅+20px 以上）。
- グループ内は上に 40px 程度ラベル用の余白、左右下は 20px。
- 書き方のスタイル: 1 行 1 図形、図形をまとめて書いてから空行を挟んで矢印。既存ファイルの書式（桁揃え・コメント）を崩さない。

## アプリ自体を開発するとき

```bash
npm run dev        # Vite + 同じ API（対象: $CHARPIE_DIR か ./diagrams）
npm test           # vitest（src/core.test.ts, server/core.test.ts）
npm run typecheck
npm run build      # dist/（UI）+ dist-server/cli.js（CLI/サーバー）
```

- `src/dsl/parse.ts` 位置情報付き・耐エラーのパーサ / `src/dsl/patch.ts` 最小差分の書き換え（UI の変更はすべてここ経由。全文再生成はしない）
- `src/layout.ts` スタイル解決・テキストフィット・矢印ルーティング / `src/check/` 検査と自動解消
- `src/remote.ts` ブラウザ⇄サーバー同期（SSE + ハッシュによる楽観ロック）
- `server/` workspace（監視・書き込み）, api, core（ops）, measure（fontkit で Inter を実測し、ブラウザと判定を揃える）, cli
- 変更したら `npm test` と `npm run typecheck` を通す。UI の挙動はヘッドレス Chromium（playwright-core）で確認してきた。
