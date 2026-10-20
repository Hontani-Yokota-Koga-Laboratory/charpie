# Claude Code 連携

## 1. サーバーを起動する

```bash
cd /path/to/charpie && npm run build      # 初回とアップデート時のみ
node /path/to/charpie/dist-server/cli.js serve <図を置くディレクトリ>
#   → http://localhost:5173 を開く。API は http://localhost:5173/api
```

`npm link` しておけば、どこからでも `charpie serve docs/diagrams` で起動できます。

起動したディレクトリの `*.charpie` がブラウザと双方向に同期されます。
Claude Code がファイルを書き換えるとブラウザに即反映され、ブラウザでの操作はファイルに書き込まれます。

## 2. Claude に教える

ブラウザの「ファイル」メニュー →「Claude Code への指示をコピー」で、Claude に貼る説明文をコピーできます。
プロジェクトの `CLAUDE.md` に常設する場合は以下を書いておきます。

```markdown
## 図（Charpie）
- 図は docs/diagrams/*.charpie（テキストが正本）。`charpie serve docs/diagrams` 起動中はブラウザと同期される。
- 記法と API の説明: `curl -s localhost:5173/api`
- 図を書いたら必ず `charpie check <file>`（または `curl -s localhost:5173/api/issues`）でエラー 0 を確認する。
- ユーザーが「この図形」と言ったら `curl -s localhost:5173/api/selection` で選択中の図形を確認する。
```

## 3. hook で自動検査（おすすめ）

`.claude/settings.json`（プロジェクト）または `~/.claude/settings.json` に追加:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "node /path/to/charpie/dist-server/cli.js hook" }
        ]
      }
    ]
  }
}
```

Claude が `.charpie` を編集するたびに検査が走り、重なり・はみ出し・貫通があれば
`auth.charpie:12: error: 「api」と「db」が重なっています（28px）` のような形で Claude に返されます（exit 2）。
警告だけの場合は追加コンテキストとして渡されます。

## API 早見表

| | |
|---|---|
| `GET /api` | Claude 向けの説明（記法・操作一覧） |
| `GET /api/doc?file=` | 図形・矢印・座標・行番号・問題一覧 |
| `GET /api/issues` | 問題一覧（ブラウザで開いていればブラウザの実測値を使用） |
| `GET /api/selection` | ユーザーが選択中の図形 |
| `PUT /api/doc?file=` | テキスト全体を書き込み（無ければ作成） |
| `POST /api/ops` | `add` `connect` `set` `move` `align` `match-size` `fix` など。`?strict=1` でエラーが増える変更を拒否 |
| `POST /api/open` / `POST /api/select` | ユーザーのブラウザでファイルを開く / 図形を指し示す |
| `GET /api/export?format=svg\|tikz` | 書き出し |

`file` を省略すると、ブラウザで開いているファイルが対象になります。

## 注意: サンドボックス
Claude Code のサンドボックスが有効だと、`curl localhost:5173` が届かないことがあります。
その場合もファイル直接編集 + `charpie check` / hook は動きます。API も使いたい場合はサンドボックスの
ネットワーク設定で localhost を許可してください。
