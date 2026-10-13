# Local FM Chat

Macの **Apple Foundation Models**（オンデバイスモデル）と、VS Codeのサイドバーで会話する拡張機能です。APIキー・外部通信は不要です。個人開発の拡張であり、Apple公式ではありません。

## 必要な環境

- Apple Silicon搭載Mac、macOS 26以降（画像入力はmacOS 27以降）
- Apple Intelligenceが有効で、オンデバイスモデルのダウンロードが完了していること
- VS Code 1.95以降のデスクトップ版

## インストール

1. [GitHub Releasesの最新版](https://github.com/handism/apple-fm-chatui/releases/latest) から `apple-fm-chatui-darwin-arm64-<バージョン>.vsix` をダウンロードします。
2. VS Codeの拡張機能画面で「…」→「VSIXからのインストール」を選びます。
3. アクティビティバーの吹き出しアイコン、またはコマンド `Local FM: チャットを開く` で開きます。

## 機能

### チャット

Enterで送信、Shift+Enterで改行（日本語変換中のEnterは送信しません）。回答はストリーミング表示され、見出し・リスト・コードブロックなどの簡易Markdownを表示します。「停止」で中断、「新しい会話」で履歴を消去できます。

エディタの選択部分は右クリックの `Local FM: 選択テキストをチャットに添付` で質問に添えられます。

### 画像について質問する（macOS 27以降）

PNG/JPEGを1枚添付できます。添付方法は次のいずれかです。

- 「＋ 画像」ボタン
- Finderからのドラッグ＆ドロップ
- チャット欄で⌘V（スクリーンショットなど）
- エクスプローラーで画像を右クリック →`Local FM: 画像をチャットに添付`

上限は1枚10 MB・4000万画素・各辺16384px以下です。履歴を含め1リクエスト3枚までで、超えた分は古いやり取りから省きます。画像はメモリ内のみで扱い、ディスクへは保存しません。

### 選択テキストの定型アクション

エディタで文章を選択し、右クリックから `要約` / `読みやすくする` / `英訳` / `箇条書きにする` を実行します。サイドバーの「差分を見る」で変更を確認し、「選択範囲に適用」で置き換えます（自動保存なし、⌘Zで元に戻せます）。

- 選択は1か所・8,000文字以内です。
- 生成開始後に元の文書が変更された場合は適用できません。選択し直して再実行してください。

### コミットメッセージ生成

ソース管理ビューのタイトルバーにある杖アイコン（`Local FM: コミットメッセージを生成`）を押すと、差分からConventional Commits形式のメッセージを入力欄に書き込みます。自動コミットはしません。

- 対象はステージ済みの変更です。ステージ済みの変更がない場合は未ステージの変更を使います。未追跡ファイルは対象外です。
- 既定は英語です。設定 `localFM.commitMessage.language` を `ja` にすると日本語になります。
- 大きな差分は約6,000文字に要約して渡すため、細部が省かれることがあります。

### 比較モード（Ollama）

[Ollama](https://ollama.com/) をインストール済みの場合、チャット上部の `⇄` ボタン（設定 `localFM.compare.enabled`）で比較モードをオンにできます。比較モードでは、1回の送信に対してLocal FMとOllamaの両方が回答し、2つの回答を並べて表示します。

- Local FMが先に回答し、そのあとでOllamaが回答します。同時に動かすとGPUを取り合い、Local FMの応答が数倍遅くなるためです。
- 会話の履歴はモデルごとに別々に保持します。どちらのモデルも、自分の過去の回答を文脈にして会話を続けます。
- Ollamaに接続できない場合やエラーになった場合は、Ollama側の回答欄に理由を表示します。Local FMの回答には影響しません。
- 使うモデルは `localFM.ollama.model` で指定します。空欄の場合は、インストール済みの最初のモデルを使います。接続先は `localFM.ollama.endpoint`（既定 `http://localhost:11434`）です。
- 選択テキストの定型アクションとコミットメッセージ生成は、比較モードでもLocal FMだけで処理します。

### モデルの状態・診断

利用可否と最後の応答成功日時を表示します。エラー時は原因（モデル準備中、Apple Intelligence無効、会話長の上限など）に応じた対処を案内します。「診断情報をコピー」はバージョンやエラー分類のみをコピーし、会話本文やファイルパスは含めません。

## データの扱いと制約

- 推論はすべてこのMac上で行います。外部API・テレメトリ・会話ログはありません。比較モードをオンにした場合だけ、会話の内容を `localFM.ollama.endpoint` のOllamaに送ります。
- 会話履歴はメモリ内のみで、VS Codeの再起動やウィンドウの再読み込みで消えます。
- 会話長の上限に達すると、古いやり取りを自動で省いて再試行します。入力は添付を含め12,000文字まで、回答は最大1,024トークンです。
- オンデバイスモデルは要約・編集・分類が得意な一方、コード生成・数学・複雑な推論は苦手です。
- ブラウザー版VS Codeには対応しません。Remote SSHでの動作は未検証です。

## 開発

Node.js 22以降と、macOS 26以降のSDKを含むXcodeまたはCommand Line Toolsが必要です。画像入力を有効にするにはSDK 27以降が必要です（SDK 26ではテキスト専用ビルドになります）。

```sh
npm install
npm run build:native   # Swiftヘルパー（bin/local-fm）をビルド
npm test
npm run package        # VSIXを生成
```

F5で拡張機能開発ホストを起動します。別のツールチェーンを使う場合は `DEVELOPER_DIR` を指定してください。ヘルパー単体での動作確認は次のとおりです。

```sh
./bin/local-fm --status
printf '%s' '{"prompt":"こんにちは","history":[]}' | ./bin/local-fm
```

### リリース

`package.json` の `version` を上げてmainへpushすると、CIのテストが通り、かつSDK 27以降で画像対応ビルドができた場合に限り、`v<version>` のGitHub Releaseを作成してVSIXを添付します。配布物はad-hoc署名で、公証やMarketplaceへの公開はしていません。

## 参照

- [Apple: Foundation Models](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models)
- [Apple: コンテキストウィンドウの管理](https://developer.apple.com/documentation/foundationmodels/managing-the-context-window)

## License

MIT
