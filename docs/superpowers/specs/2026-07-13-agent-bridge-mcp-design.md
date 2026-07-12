# agent-bridge-mcp 設計ドキュメント

日付: 2026-07-13
ステータス: 承認済み

## 目的

Claude Code と Codex が互いにタスクを委譲し合えるようにする双方向ブリッジMCPサーバー。
両AIの得意分野は日々移り変わるため、どちらのセッションからでも「もう片方に実作業を委譲して結果を回収する」ことを恒常的に可能にする。

## 背景・前提

- 環境: macOS (darwin)。Claude Code CLI (`/opt/homebrew/bin/claude`) と Codex CLI(ChatGPT.app 同梱: `/Applications/ChatGPT.app/Contents/Resources/codex`、v0.144.0-alpha.4、認証済み)。Codex はデスクトップアプリでも利用する。
- `codex mcp-server` / `claude mcp serve` という既製のMCPサーバーモードは存在するが、いずれも同期呼び出しのみで「タスク丸ごと委譲+非同期回収」の要件を満たさないため、自作ブリッジを採用する(検討済みの代替案は末尾に記載)。

## 全体アーキテクチャ

TypeScript + 公式 `@modelcontextprotocol/sdk` によるstdio MCPサーバー1本。
配置: `/Users/nariiwa/Projects/agent-bridge-mcp`

同一サーバーを両クライアントに登録する:

- **Claude Code側**: `claude mcp add agent-bridge -- node <path>/dist/index.js`
- **Codex側**: `~/.codex/config.toml` の `[mcp_servers.agent-bridge]` に同じコマンドを登録(CLI・デスクトップアプリ共通で反映される)

委譲先に応じてヘッドレスCLIを叩き分ける:

- Codexへの委譲 → `codex exec --json -C <cwd> "<prompt>"`
- Claudeへの委譲 → `claude -p "<prompt>" --output-format json`(cwdで起動)

セットアップ時に ChatGPT.app 同梱の `codex` バイナリを `/opt/homebrew/bin/codex` へ symlink し、PATHから使えるようにする。

## ツールAPI(5ツール)

| ツール | 引数 | 動作 |
|---|---|---|
| `delegate_task` | `target` ("claude" \| "codex"), `prompt`, `cwd`, 任意: `model`, `timeout_minutes` | ジョブをdetached子プロセスとして起動し、即座に `job_id` を返す |
| `job_status` | `job_id` | running / succeeded / failed / cancelled / timed_out、経過時間、出力ログの末尾を返す |
| `job_result` | `job_id` | 完了ジョブの最終出力(エージェント最終メッセージ+終了コード)を返す。未完了ならその旨を返す |
| `job_cancel` | `job_id` | 実行中ジョブのプロセスをkillし cancelled にする |
| `list_jobs` | 任意: `limit` | 直近ジョブの一覧(id、target、状態、開始時刻、promptの先頭) |

## ジョブ管理

- ジョブは **detached な子プロセス**として起動する。MCPサーバー(stdio)がセッション終了で死んでもジョブは走り続ける。
- 状態はディスクに永続化する: `~/.agent-bridge/jobs/<job_id>/`
  - `meta.json` — target、prompt、cwd、pid、状態、開始/終了時刻
  - `output.log` — 子プロセスのstdout/stderr(追記)
  - `result.json` — 完了時の最終出力と終了コード
- 別セッション・別クライアントからでも `job_id` さえあれば回収できる。
- デフォルトタイムアウト30分(`timeout_minutes` で上書き可)。超過時はkillして `timed_out` にする。

## 権限と安全弁

- Codex側ジョブ: `--sandbox workspace-write`(cwd内のみ書き込み可)で起動。
- Claude側ジョブ: `--permission-mode acceptEdits` で起動。
- **無限ループ対策(必須)**: ブリッジが起動するジョブには環境変数 `AGENT_BRIDGE_DEPTH`(現在の深さ+1)を付与する。`delegate_task` は自プロセスの `AGENT_BRIDGE_DEPTH` を確認し、**2以上なら委譲をエラーで拒否**する。これにより「ClaudeがCodexに委譲 → そのCodexがClaudeに再委譲」の1段までは許容しつつ、それ以上の連鎖を遮断する。

## エラー処理

- CLIバイナリ不在・認証切れ・プロセス異常終了は `job_status` / `job_result` にstderr末尾を含めて返し、原因が分かるようにする。
- `job_id` 不明、未完了ジョブへの `job_result`、完了済みジョブへの `job_cancel` は明確なエラーメッセージを返す。

## テスト方針

- ジョブマネージャはfake CLI(即座に成功/失敗/一定時間スリープするスタブスクリプト)を注入して単体テストする。対象: 起動〜完了、失敗、タイムアウト、キャンセル、深さ制限、永続化の復元。
- 最後に実CLIで双方向のE2Eを各1本、手動確認する(Claude→Codex委譲、Codex→Claude委譲)。

## 検討して不採用にした代替案

- **既製機能のみ(codex mcp-server + claude mcp serve)**: 同期呼び出しのみで非同期ジョブ要件を満たさず、`claude mcp serve` は個別ツール公開でありタスク委譲にならない。
- **片方向のみ自作**: 方向によってUXが非対称になり、Claude→Codexが同期のままになる。
