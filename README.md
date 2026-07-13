# agent-bridge-mcp

Claude Code と Codex CLI が、互いに非同期でタスクを委譲し合うための stdio MCP サーバー。
どちらのクライアントに登録しても、`delegate_task` で相手のCLIをバックグラウンド起動し、
`job_status` / `job_result` でポーリング、`job_cancel` でキャンセル、`list_jobs` で一覧できる。

## 概要

- Claude Code のセッション内から「このタスクは Codex にやらせたい」、あるいは Codex のセッション内から
  「このタスクは Claude にやらせたい」というときに、`delegate_task` ツールで相手のCLIを子プロセスとして
  非同期起動する。
- ジョブは即座に `job_id` を返して制御を戻す(同期待ちしない)。進捗確認・結果回収は別ツール呼び出しで行う。
- ジョブの状態は `~/.agent-bridge/jobs/<job_id>/` 以下にファイルとして永続化されるため、
  委譲元セッションが終了・再起動してもジョブ結果を後から回収できる。
- 無限に委譲し合う("Claude→Codex→Claude→Codex→…")事故を防ぐため、再委譲の深さ制限(`AGENT_BRIDGE_DEPTH`)を持つ。

## アーキテクチャ

```
                          ┌─────────────────────────┐
                          │   agent-bridge-mcp       │
                          │   (dist/index.js, stdio) │
                          └─────────────────────────┘
                             ▲                    ▲
                 MCP (stdio) │                    │ MCP (stdio)
                             │                    │
                    ┌────────┴───────┐   ┌────────┴────────┐
                    │  Claude Code    │   │  Codex CLI      │
                    │  (claude -p /   │   │  (codex exec)   │
                    │   interactive)  │   │                 │
                    └────────┬────────┘   └────────┬────────┘
                             │                       │
                delegate_task│                       │delegate_task
                             ▼                       ▼
                    ┌────────────────────────────────────────┐
                    │  JobManager (src/jobs.ts)               │
                    │  - job_id 発行、深さ制限チェック          │
                    │  - runner.js を detached spawn          │
                    └────────────────┬─────────────────────┘
                                     │ spawn (detached, unref)
                                     ▼
                    ┌────────────────────────────────────────┐
                    │  runner.js                              │
                    │  - job.json の bin/args/env/timeout で   │
                    │    claude または codex を実際に起動       │
                    │  - stdout→output.log / stderr→stderr.log │
                    │  - 完了後 result.json を書く              │
                    └────────────────┬─────────────────────┘
                                     ▼
                    ~/.agent-bridge/jobs/<job_id>/
                      ├─ meta.json        (target, prompt, cwd, startedAt...)
                      ├─ job.json         (実行コマンド、env、timeoutMs)
                      ├─ output.log       (stdout)
                      ├─ stderr.log       (stderr)
                      ├─ last-message.txt (codex -o の最終メッセージ)
                      └─ result.json      (state/exitCode/signal/endedAt)
```

同じ agent-bridge サーバーを Claude Code・Codex 双方に登録することで、どちらの方向にも
委譲できる(Claude→Codex, Codex→Claude)。委譲先の実行は `runner.js` が別プロセスとして
detached 起動するため、委譲元のMCPサーバープロセスやセッションが終了してもジョブは動き続ける。

## 5つのツール

| ツール | 説明 |
|---|---|
| `delegate_task` | タスクをもう一方のAIエージェント(`claude`/`codex`)に非同期で委譲する。引数: `target`(`claude`\|`codex`)、`prompt`(委譲する指示文)、`cwd`(作業ディレクトリ、絶対パス)、`model`(任意、モデル上書き)、`timeout_minutes`(任意、デフォルト30分)。即座に `job_id` を返す。 |
| `job_status` | `job_id` を渡すと、状態(`running`/`succeeded`/`failed`/`cancelled`/`timed_out`)・`exit_code`・`log_tail`(stdout末尾)・`stderr_tail`(stderr末尾)を返す。 |
| `job_result` | 完了したジョブの最終出力(`finalMessage`)と `stderrTail` を返す。未完了なら `state: "running"` のみ返す。 |
| `job_cancel` | 実行中のジョブに `SIGTERM` を送ってキャンセルする。 |
| `list_jobs` | 直近のジョブ一覧を新しい順で返す(`limit` 任意、デフォルト20件)。 |

内部的には、`target: "codex"` の場合は `codex exec --json -C <cwd> -s workspace-write --skip-git-repo-check -o <jobDir>/last-message.txt <prompt>` を、
`target: "claude"` の場合は `claude -p <prompt> --output-format json --permission-mode acceptEdits` を、それぞれ子プロセスとして起動する
(`src/commands.ts` の `buildCommand`)。

## セットアップ手順

以下は実際にセットアップ時に実行したコマンド(このリポジトリの環境: macOS, Homebrew, `/opt/homebrew/bin`)。

### Step 1: codex CLI を PATH に通す

ChatGPT.app にバンドルされた codex バイナリを Homebrew の bin にシンボリックリンクする。

```bash
ln -sf "/Applications/ChatGPT.app/Contents/Resources/codex" /opt/homebrew/bin/codex
codex --version
```

> 補足: 環境によっては codex の内部ツール実行に使う相棒バイナリ `codex-code-mode-host` も
> 同じディレクトリに解決しようとする(`codex` シンボリックリンクと同じディレクトリを探す)。
> `codex exec` 実行時に `failed to spawn code-mode host ...: No such file or directory` が出た場合は、
> 同様にシンボリックリンクする。
>
> ```bash
> ln -sf "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host" /opt/homebrew/bin/codex-code-mode-host
> ```

### Step 2: ビルドして Claude Code に登録

```bash
cd <クローン先>/agent-bridge-mcp && npm run build
claude mcp add --scope user agent-bridge -- node <クローン先>/agent-bridge-mcp/dist/index.js
claude mcp list
```

`agent-bridge` が一覧に `✔ Connected` で表示されれば成功。

### Step 3: Codex に登録

`~/.codex/config.toml` の末尾に以下を追記する(既存内容は変更しない)。

```toml
[mcp_servers.agent-bridge]
command = "node"
args = ["<クローン先>/agent-bridge-mcp/dist/index.js"]
```

手で編集する代わりに、CLI が対応していれば以下でも同じ結果になる(既存の `config.toml` は
バックアップしてから実行することを推奨):

```bash
cp ~/.codex/config.toml ~/.codex/config.toml.bak-agent-bridge
codex mcp add agent-bridge -- node <クローン先>/agent-bridge-mcp/dist/index.js
codex mcp list
```

`agent-bridge` が一覧に表示されれば成功。

> 注意: `codex mcp add` はコマンドとして `~/.codex/config.toml` 全体を書き戻すため、
> 手編集した場合と比べて数値のフォーマット(`60` → `60.0`)やテーブルの並び順など
> 見た目上の差分が出ることがある(値そのものは変わらない)。既存設定を厳密に触りたくない場合は、
> 上記TOMLブロックの手動追記(末尾へのappendのみ)を選ぶこと。

## 環境変数一覧

| 変数 | 説明 | デフォルト |
|---|---|---|
| `AGENT_BRIDGE_JOBS_DIR` | ジョブの永続化ディレクトリ | `~/.agent-bridge/jobs` |
| `AGENT_BRIDGE_CLAUDE_BIN` | `claude` バイナリのパス | 環境変数が未設定なら `/opt/homebrew/bin/claude` の存在を確認して使用し、それも無ければ同じ `/opt/homebrew/bin/claude` をハードコードされた最終フォールバックとして使う(結果的に常にこのパスになる) |
| `AGENT_BRIDGE_CODEX_BIN` | `codex` バイナリのパス | `/opt/homebrew/bin/codex` があればそれ、なければ `/Applications/ChatGPT.app/Contents/Resources/codex`(フォールバック) |
| `AGENT_BRIDGE_DEPTH` | 現在の委譲の深さ(通常は自分で設定しない。委譲時にサーバーが `+1` して子プロセスに渡す) | `0` |
| `AGENT_BRIDGE_MODEL_GUIDE_FILE` | モデル選定ガイドのファイルパス | `~/.agent-bridge/model-guide.md`(無ければ内蔵デフォルト) |

## モデル運用

`delegate_task` のツール説明には**モデル選定ガイド**が埋め込まれており、委譲する側のAI(オーケストレータ)は委譲前にこれを読む。ポリシーは次の通り:

- **model未指定 = 各CLIの既定(最高位モデル)で実行**。これは意図的な仕様(既定は安全側=能力優先)。
- ただしオーケストレータには「ワーカー仕事なら下位/専用モデルで十分か検討し、**どのモデルを使うかユーザーに確認**してから委譲せよ」と指示している。無駄な高位モデル消費を確認一回で防ぐ。
- ガイドの内容(2026-07-13時点: claude-fable-5/opus-4-8/sonnet-5/haiku-4-5、gpt-5.6-sol/5.6-terra/gpt-image-2)は陳腐化しうるため、オーケストレータは自身の知識と乖離があればユーザーにガイド更新を提案する。
- ガイドを差し替えるには `~/.agent-bridge/model-guide.md` を置く(または `AGENT_BRIDGE_MODEL_GUIDE_FILE` でパス指定)。サーバー起動時(=セッション開始時)に読み込まれる。

## 深さ制限の説明

`delegate_task` は呼び出し時点の `AGENT_BRIDGE_DEPTH` が **2以上** の場合、ジョブを起動せずに
エラーを返す(`再委譲の深さ制限(AGENT_BRIDGE_DEPTH=N)に達しました。これ以上の連鎖委譲は禁止されています。`)。

委譲が成立するたびに、agent-bridge は起動する子プロセス(`claude`/`codex`)の環境変数
`AGENT_BRIDGE_DEPTH` を「現在の深さ+1」に設定して渡す(`src/jobs.ts` の `delegate()`)。
これにより、Claude→Codex→Claude→… のように委譲が連鎖しても、一定回数(深さ2)を超えると
自動的に打ち切られ、無限委譲ループによるリソース枯渇を防ぐ。

**codex向けの深さ伝播はenvだけに頼らない**: Codex CLI は内蔵MCPサーバー(agent-bridgeを含む)を
起動する際、渡す環境変数をサニタイズしている可能性があり、その場合子プロセスのenvに設定した
`AGENT_BRIDGE_DEPTH` が握りつぶされ、委譲先のagent-bridgeが深さ0から再スタートしてしまう
(=深さ制限が効かず無限委譲ループになり得る)。これを防ぐため、`target: "codex"` のコマンド構築時
(`src/commands.ts` の `buildCommand()`)には envに加えて `-c
mcp_servers.agent-bridge.env.AGENT_BRIDGE_DEPTH="<次の深さ>"` というCodex CLIの設定オーバーライド
引数(`-c` の値はTOMLとしてパースされる)も明示的に渡し、env経由の伝播が効かない環境でも深さが
確実に伝わるようにしている。`claude` 側には同等のオーバーライド機構が無いため、従来通りenv経由の
伝播のみとなる(claude CLIでのenv伝播は動作確認済み)。

> **注意(検証未了)**: 上記の `-c` オーバーライドがCodex CLI側で実際にMCPサーバーへのenv値として
> 反映されるかどうかは、対話モードでの実機検証がまだ完了していない。`codex exec`(非対話実行)は
> MCPツール呼び出しの承認フローが構造的にサポートされていないため(下記トラブルシュート参照)、
> `codex exec` 経由では本項目を検証できない。対話セッションでの確認手順は以下の通り:
>
> ```bash
> AGENT_BRIDGE_DEPTH=2 codex
> # 対話セッション内で delegate_task を呼び出してもらい、
> # 「再委譲の深さ制限(AGENT_BRIDGE_DEPTH=2)に達しました」エラーになることを確認する
> ```

手動で深さ制限を早めに発動させたい場合(動作確認など)は、以下のように環境変数を明示して
呼び出し元セッションを起動する。

```bash
AGENT_BRIDGE_DEPTH=2 claude -p '...delegate_taskで委譲してみて...'
```

## トラブルシュート

- **委譲先で認証切れ・バイナリ不在などが起きた場合**: まず `job_status` で該当 `job_id` の
  `stderr_tail`(または `job_result` の `stderrTail`)を確認する。認証エラーやバイナリ未検出は
  通常ここに出力される。
- **`job_status`/`job_result` が `job_id が見つかりません` を返す**: `job_id` の書き間違い、
  もしくは `AGENT_BRIDGE_JOBS_DIR` を変えて別ディレクトリを見ている可能性がある。
  `~/.agent-bridge/jobs/<job_id>/` が実際に存在するか確認する。
- **`state` が `failed`・`exitCode` が非0**: `output.log`(stdout)と `stderr.log`(stderr)を
  直接見て、委譲先CLI自体のエラー(認証切れ、権限プロンプトでの停止、モデル指定ミスなど)を切り分ける。
- **Claude Code 側で `delegate_task` などが権限未許可でブロックされる(非対話セッション)**:
  `claude -p` は非対話実行のため、ツール利用の許可プロンプトを出せない。
  `--allowedTools "mcp__agent-bridge__delegate_task mcp__agent-bridge__job_status mcp__agent-bridge__job_result mcp__agent-bridge__list_jobs mcp__agent-bridge__job_cancel"`
  を明示するか、`.claude/settings.local.json` の `permissions.allow` に追加する。
- **Codex 側で `codex exec` から呼ぶと `user cancelled MCP tool call` になる**:
  このリポジトリの検証環境では、`codex exec`(非対話実行)は agent-bridge に限らずどのカスタム
  MCPサーバーのツール呼び出しに対しても、承認(elicitation)フローが `request_user_input is not
  supported in exec mode` で失敗し、ツール呼び出し自体がキャンセルされることを確認している
  (Codex CLI 側の制約であり、agent-bridge のバグではない)。対話セッション(`codex` の通常起動)
  であれば承認プロンプトに応答できるため問題なく動作する。

## テスト

```bash
npm test
```

fakeバイナリ(テスト用のダミー `claude`/`codex` スクリプト)を使ったユニットテストで、
ジョブのライフサイクル・深さ制限・タイムアウト・エラー処理などを検証している(35/35 pass)。
