# Kanzaki

ステージされた変更を、Markdownで書いたチェックリストに照らしてLLMがレビューするCLIツールです。

## 概要

`kanzaki check` を実行すると、`git diff --staged` の内容を `.kanzaki/rules.md` に書かれたルールと照合し、LLM（OpenAIまたはAnthropic）に判定させます。違反が見つかった場合、重要度に応じてコミットをブロックするか警告を出します。

チェック対象はコードに限りません。ドキュメント、リサーチノート、設定ファイルなど、テキストベースの差分であれば利用できます。ルールは自然言語で記述するため、フォーマッターや構文チェッカーでは検出できない「意味的な問題」を拾うことを目的としています。

ただし、LLMの判定は100%正確ではありません。誤判定を前提に、重要度を使い分けて運用することを推奨します。

## しくみ

`kanzaki check` は次の手順で動作します。

1. **ステージの確認** — `git diff --staged --name-only` で変更ファイルを取得します。変更がなければ終了します。
2. **認証情報のロード** — CLIフラグ → 環境変数 → `~/.config/kanzaki/credentials.json` の優先順位で解決します。
3. **ルール解析** — `.kanzaki/rules.md` から次の3要素を抽出します。
   - `- [ ]` で始まる行 → ルール（重要度とテキスト）
   - `## ヘッダー (*.ts)` の形式 → グループ名とファイルスコープ
   - それ以外のテキスト → LLMに渡す補足コンテキスト
4. **Git情報の取得** — `git diff --staged` の出力と、変更ファイルの全文（バイナリや100KB超は除外）を取得します。
5. **ルールのフィルタリング** — 変更ファイルにマッチしないスコープのルールを除外します。
6. **プロンプト構築** — コンテキスト、ルール一覧、diff（最大50KB）、ファイル全文（各最大20KB）を1つのプロンプトにまとめます。
7. **LLM呼び出し** — OpenAIはJSON mode、AnthropicはテキストレスポンスからJSONを抽出します。各ルールについて `{ rule, passed, reason }` が返されます。
8. **結果出力** — `!error` ルールが1件でも失敗した場合は `exit(1)` でコミットをブロックします。`!warn` のみの失敗なら警告を表示して `exit(0)` します。

pre-commitフック（Husky等）で実行することを想定していますが、CI/CDや手動実行でも同じように使えます。

---

## インストール

```bash
npm install -g kanzaki
```

Node.js 18以上が必要です。

## セットアップ

### 1. 認証

認証方式は4種類あります。

```bash
# APIキーを対話入力（入力は ****** でマスク表示）
kanzaki login                          # OpenAIのAPIキー
kanzaki login --provider anthropic     # AnthropicのAPIキー

# ChatGPT PlusサブスクリプションでOAuthログイン
kanzaki login --use-chatgpt

# ローカルのClaude Code CLIをサブプロセスとして利用
kanzaki login --use-claude
```

認証情報は `~/.config/kanzaki/credentials.json` に保存されます。一度ログインすれば全プロジェクトで使えます。

#### `--use-chatgpt` について

OpenAI公式の Codex CLI と同じOAuthフロー（Authorization Code + PKCE）でChatGPTサブスクリプションに紐づくトークンを取得し、`https://chatgpt.com/backend-api/codex/responses` に対してレビューリクエストを送ります。ChatGPT Plus/Proの利用上限が適用されます。

#### `--use-claude` について

ローカルにインストールされた `claude` コマンドをサブプロセスとして起動する方式です。Claude Code CLI が既にログイン済みである必要があります。kanzakiは `claude -p` にプロンプトをstdin経由で渡し、標準出力をJSONとして解釈します。認証・セッション管理はすべてClaude CLI側が担当します。

### 2. プロジェクトの初期化

```bash
cd your-project
npx kanzaki init
```

`.kanzaki/rules.md` のテンプレートが作成されます。

### 3. Gitフックへの組み込み（任意）

コミット時に自動実行したい場合は、Husky等で `kanzaki check` を pre-commit フックに登録します。

```bash
npm install --save-dev husky
npx husky init
echo "npx kanzaki check" > .husky/pre-commit
```

手動実行やCI/CDでの利用も可能です。

### 4. ルールのカスタマイズ

`.kanzaki/rules.md` をプロジェクトに合わせて編集します（詳細は後述）。

---

## ルールの書き方

`.kanzaki/rules.md` はMarkdownのチェックリスト形式です。

### 基本構文

```markdown
# プロジェクトのレビュールール

## グループ名
- [ ] ルールの内容（デフォルトで !error 扱い）
- [ ] !error 明示的にエラーとして定義
- [ ] !warn  警告のみ（コミットはブロックしない）
```

### 重要度

| 記法 | 動作 |
|------|------|
| `!error`（デフォルト） | 違反時に `exit(1)` でコミットをブロック |
| `!warn` | 警告表示のみ、コミットは続行 |

### 補足コンテキスト

チェックリスト以外のテキスト（段落など）はLLMへの補足情報として送信されます。プロジェクトの前提や背景をここに書くことで、判定の精度が変わることがあります。

```markdown
# レビュールール

このプロジェクトは医療機器の規制文書を管理しています。
すべての変更は FDA 21 CFR Part 11 に準拠する必要があります。

## コンプライアンス
- [ ] !error 規制要件への参照が正確であること
- [ ] !error 変更履歴が適切に記録されていること
```

### ファイルスコープ

ヘッダー名に続けて括弧で glob パターンを書くと、そのグループのルールは該当ファイルに変更があった場合のみ適用されます。

```markdown
## ドキュメント (*.md, *.txt)
- [ ] !error リンク切れがないこと
- [ ] !warn 見出しの階層構造が正しいこと

## コード (*.ts, *.js)
- [ ] !error console.log が本番コードに残っていないこと
- [ ] !error ハードコードされた秘密情報がないこと

## 全ファイル
- [ ] !warn TODO コメントが残っていないこと
```

パターン未指定のグループは全ファイルに適用されます。

### ルール例

<details>
<summary>リサーチ・論文</summary>

```markdown
# リサーチレビュールール

再生可能エネルギーに関する調査レポート。
データに基づいた客観的な分析が求められる。

## 正確性
- [ ] !error 統計データには出典が明記されていること
- [ ] !error 事実誤認や誤解を招く主張がないこと
- [ ] !warn 数値の単位が明確に記載されていること

## 構成
- [ ] !error 各セクションに適切な見出しがあること
- [ ] !warn 論理的な流れが維持されていること

## 文体
- [ ] !warn 用語が文書全体で統一されていること
- [ ] !warn 受動態の過剰使用を避けていること
```
</details>

<details>
<summary>ソフトウェア開発</summary>

```markdown
# コードレビュールール

Next.js + TypeScript のフルスタックアプリケーション。
REST API は全エンドポイントに認証が必要。

## セキュリティ (*.ts, *.js)
- [ ] !error ハードコードされたAPIキー・パスワードがないこと
- [ ] !error 新しいAPIルートに認証ミドルウェアが適用されていること
- [ ] !error ユーザー入力のバリデーションがあること

## コード品質 (*.ts, *.js)
- [ ] !error console.log がプロダクションコードに残っていないこと
- [ ] !error 適切なエラーハンドリングがあること
- [ ] !warn 変数名・関数名が説明的であること

## ドキュメント (*.md)
- [ ] !warn API変更に伴うドキュメント更新が含まれていること
```
</details>

<details>
<summary>プレゼン・レポート</summary>

```markdown
# プレゼンレビュールール

Q4 決算報告プレゼンテーション。
経営陣向け、データドリブンな内容が求められる。

## 内容
- [ ] !error すべてのグラフ・チャートにデータソースが記載されていること
- [ ] !error 前四半期との比較データが含まれていること
- [ ] !warn 結論がデータに基づいていること

## スタイル
- [ ] !warn 箇条書きが簡潔であること
- [ ] !warn フォーマットが全スライドで統一されていること
```
</details>

---

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `kanzaki init` | `.kanzaki/rules.md` テンプレートを作成 |
| `kanzaki check` | ステージ済みの変更をレビュー |
| `kanzaki login` | 認証情報を保存 |
| `kanzaki logout` | 保存済み認証情報を削除 |
| `kanzaki status` | 現在の認証状態を表示 |

### `kanzaki login` のオプション

| オプション | 説明 |
|-----------|------|
| `-p, --provider <名前>` | `openai` または `anthropic`（デフォルト: `openai`） |
| `--use-chatgpt` | OpenAIのOAuthフロー（ChatGPT Plus/Pro） |
| `--use-claude` | ローカルのClaude CLIをサブプロセスとして利用 |

### `kanzaki check` のオプション

| オプション | 説明 |
|-----------|------|
| `-p, --provider <名前>` | LLMプロバイダー（`openai` / `anthropic`） |
| `-m, --model <名前>` | 使用モデル |
| `-r, --rules <パス>` | ルールファイルのパス（デフォルト: `.kanzaki/rules.md`） |
| `--api-key <キー>` | APIキーを直接指定（`kanzaki login` の利用を推奨） |
| `--no-block` | エラーでも `exit(1)` せず、警告のみ |
| `-v, --verbose` | 詳細出力 |

---

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `KANZAKI_API_KEY` | LLM APIキー | — |
| `KANZAKI_PROVIDER` | `openai` / `anthropic` | `openai` |
| `KANZAKI_MODEL` | モデル名 | `gpt-5.4`（OpenAI）/ `claude-sonnet-4-20250514`（Anthropic） |
| `KANZAKI_RULES_PATH` | ルールファイルのパス | `.kanzaki/rules.md` |

プロジェクトルートに `.env` があれば自動で読み込まれます。

---

## ライセンス

MIT
