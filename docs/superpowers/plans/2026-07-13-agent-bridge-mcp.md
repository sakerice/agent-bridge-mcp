# agent-bridge-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code と Codex が互いに非同期でタスクを委譲し合える双方向ブリッジMCPサーバーを作る。

**Architecture:** stdio MCPサーバー(TypeScript)が5ツールを公開する。`delegate_task` はdetachedなランナープロセス(`runner.js`)を起動して即job_idを返し、ランナーがヘッドレスCLI(`codex exec` / `claude -p`)を実行して結果を `~/.agent-bridge/jobs/<id>/` に永続化する。MCPサーバーが死んでもジョブは完走し、別セッションから回収できる。

**Tech Stack:** Node.js 18+ / TypeScript (strict, ESM) / `@modelcontextprotocol/sdk` ^1.12 / zod ^3 / vitest ^3

**スペック:** `docs/superpowers/specs/2026-07-13-agent-bridge-mcp-design.md`

## Global Constraints

- パッケージは ESM (`"type": "module"`)、TypeScript strict、`module: NodeNext`
- ジョブ保存先: `~/.agent-bridge/jobs/<job_id>/`(env `AGENT_BRIDGE_JOBS_DIR` で上書き可)
- CLIバイナリ解決: env `AGENT_BRIDGE_CLAUDE_BIN` / `AGENT_BRIDGE_CODEX_BIN` → `/opt/homebrew/bin/<name>` → フォールバック(`claude`: `/opt/homebrew/bin/claude`、`codex`: `/Applications/ChatGPT.app/Contents/Resources/codex`)
- 委譲深さ制限: env `AGENT_BRIDGE_DEPTH` が **2以上なら `delegate_task` は拒否**。起動するジョブには `AGENT_BRIDGE_DEPTH = 現在値+1` を渡す
- デフォルトタイムアウト30分、`timeout_minutes` で上書き可
- Codexジョブは `-s workspace-write`、Claudeジョブは `--permission-mode acceptEdits` で起動
- ジョブ状態: `running | succeeded | failed | cancelled | timed_out`
- テストコマンド: `npm test`(= `npm run build && vitest run`。runner/serverテストが `dist/` を使うため必ずbuildが先)
- コミットメッセージ末尾: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: プロジェクト雛形 + コマンド構築モジュール (`commands.ts`)

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/commands.ts`
- Test: `tests/commands.test.ts`

**Interfaces:**
- Produces:
  - `type Target = "claude" | "codex"`
  - `interface DelegateSpec { target: Target; prompt: string; cwd: string; model?: string }`
  - `interface Bins { claude: string; codex: string }`
  - `interface Command { bin: string; args: string[] }`
  - `const LAST_MESSAGE_FILE = "last-message.txt"`
  - `buildCommand(spec: DelegateSpec, jobDir: string, bins: Bins): Command`
  - `extractFinalMessage(target: Target, jobDir: string): string | undefined`

- [ ] **Step 1: 雛形ファイルを作成**

`package.json`:

```json
{
  "name": "agent-bridge-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agent-bridge-mcp": "dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "npm run build && vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`.gitignore`:

```
node_modules/
dist/
```

Run: `npm install`
Expected: 依存がインストールされ `package-lock.json` が生成される

- [ ] **Step 2: 失敗するテストを書く**

`tests/commands.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCommand,
  extractFinalMessage,
  LAST_MESSAGE_FILE,
} from "../src/commands.js";

const bins = { claude: "/bin/claude", codex: "/bin/codex" };

describe("buildCommand", () => {
  it("codex向けコマンドを構築する", () => {
    const cmd = buildCommand(
      { target: "codex", prompt: "fix bug", cwd: "/tmp/proj" },
      "/tmp/job1",
      bins,
    );
    expect(cmd.bin).toBe("/bin/codex");
    expect(cmd.args).toEqual([
      "exec",
      "--json",
      "-C", "/tmp/proj",
      "-s", "workspace-write",
      "--skip-git-repo-check",
      "-o", path.join("/tmp/job1", LAST_MESSAGE_FILE),
      "fix bug",
    ]);
  });

  it("codexでmodel指定を渡す", () => {
    const cmd = buildCommand(
      { target: "codex", prompt: "p", cwd: "/tmp", model: "gpt-5.6-sol" },
      "/tmp/job1",
      bins,
    );
    expect(cmd.args).toContain("-m");
    expect(cmd.args[cmd.args.indexOf("-m") + 1]).toBe("gpt-5.6-sol");
    expect(cmd.args[cmd.args.length - 1]).toBe("p");
  });

  it("claude向けコマンドを構築する", () => {
    const cmd = buildCommand(
      { target: "claude", prompt: "review this", cwd: "/tmp/proj" },
      "/tmp/job1",
      bins,
    );
    expect(cmd.bin).toBe("/bin/claude");
    expect(cmd.args).toEqual([
      "-p", "review this",
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
    ]);
  });

  it("claudeでmodel指定を渡す", () => {
    const cmd = buildCommand(
      { target: "claude", prompt: "p", cwd: "/tmp", model: "claude-sonnet-5" },
      "/tmp/job1",
      bins,
    );
    expect(cmd.args).toContain("--model");
    expect(cmd.args[cmd.args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });
});

describe("extractFinalMessage", () => {
  it("codexはlast-message.txtを読む", () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-"));
    fs.writeFileSync(path.join(jobDir, LAST_MESSAGE_FILE), "codex answer");
    expect(extractFinalMessage("codex", jobDir)).toBe("codex answer");
  });

  it("codexでファイルがなければundefined", () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-"));
    expect(extractFinalMessage("codex", jobDir)).toBeUndefined();
  });

  it("claudeはoutput.logの最後のJSON行からresultを取る", () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-"));
    fs.writeFileSync(
      path.join(jobDir, "output.log"),
      'noise\n{"type":"other"}\n{"result":"claude answer","cost":1}\n',
    );
    expect(extractFinalMessage("claude", jobDir)).toBe("claude answer");
  });

  it("claudeでresultが見つからなければundefined", () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-"));
    fs.writeFileSync(path.join(jobDir, "output.log"), "no json here\n");
    expect(extractFinalMessage("claude", jobDir)).toBeUndefined();
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/commands.test.ts`
Expected: FAIL(`src/commands.js` が存在しない)

- [ ] **Step 4: 実装を書く**

`src/commands.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";

export type Target = "claude" | "codex";

export interface DelegateSpec {
  target: Target;
  prompt: string;
  cwd: string;
  model?: string;
}

export interface Bins {
  claude: string;
  codex: string;
}

export interface Command {
  bin: string;
  args: string[];
}

export const LAST_MESSAGE_FILE = "last-message.txt";

export function buildCommand(
  spec: DelegateSpec,
  jobDir: string,
  bins: Bins,
): Command {
  if (spec.target === "codex") {
    const args = [
      "exec",
      "--json",
      "-C", spec.cwd,
      "-s", "workspace-write",
      "--skip-git-repo-check",
      "-o", path.join(jobDir, LAST_MESSAGE_FILE),
    ];
    if (spec.model) args.push("-m", spec.model);
    args.push(spec.prompt);
    return { bin: bins.codex, args };
  }
  const args = [
    "-p", spec.prompt,
    "--output-format", "json",
    "--permission-mode", "acceptEdits",
  ];
  if (spec.model) args.push("--model", spec.model);
  return { bin: bins.claude, args };
}

export function extractFinalMessage(
  target: Target,
  jobDir: string,
): string | undefined {
  if (target === "codex") {
    const p = path.join(jobDir, LAST_MESSAGE_FILE);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  }
  const logPath = path.join(jobDir, "output.log");
  if (!fs.existsSync(logPath)) return undefined;
  const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.result === "string") return obj.result;
    } catch {
      // JSONでない行は無視
    }
  }
  return undefined;
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run tests/commands.test.ts`
Expected: PASS(8テスト)

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/commands.ts tests/commands.test.ts
git commit -m "feat: プロジェクト雛形とヘッドレスCLIコマンド構築モジュール"
```

---

### Task 2: ジョブランナー (`runner.ts`) と fake CLI

**Files:**
- Create: `src/runner.ts`
- Create: `tests/fixtures/fake-cli.mjs`(実行可能ビット付き)
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: なし(単独プロセス)
- Produces:
  - 実行形態: `node dist/runner.js <jobDir>`
  - 入力: `<jobDir>/job.json` = `{ bin: string; args: string[]; cwd: string; env: Record<string,string>; timeoutMs: number }`
  - 出力: `<jobDir>/output.log`(子のstdout)、`<jobDir>/stderr.log`(子のstderr)、終了時に `<jobDir>/result.json` = `{ state: "succeeded"|"failed"|"cancelled"|"timed_out"; exitCode: number|null; signal: string|null; endedAt: string }`
  - SIGTERM受信で子をkillし `state: "cancelled"` を書く。timeoutMs超過で子をkillし `state: "timed_out"` を書く

- [ ] **Step 1: fake CLI を作成**

`tests/fixtures/fake-cli.mjs`:

```js
#!/usr/bin/env node
// テスト用の偽claude/codex CLI。FAKE_MODE で挙動を切り替える:
//   success (default) — claude風のJSON行を出力し、-o があればそのファイルにも書いて正常終了
//   fail  — stderrに出して exit 1
//   sleep — 60秒スリープ(タイムアウト/キャンセルのテスト用)
import * as fs from "node:fs";

const mode = process.env.FAKE_MODE ?? "success";

const oIdx = process.argv.indexOf("-o");
if (oIdx !== -1 && mode === "success") {
  fs.writeFileSync(process.argv[oIdx + 1], "fake codex done");
}

if (mode === "sleep") {
  setTimeout(() => process.exit(0), 60_000);
} else if (mode === "fail") {
  console.error("fake failure: auth expired");
  process.exit(1);
} else {
  console.log(JSON.stringify({ result: "fake done" }));
  process.exit(0);
}
```

Run: `chmod +x tests/fixtures/fake-cli.mjs`

- [ ] **Step 2: 失敗するテストを書く**

`tests/runner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUNNER = path.resolve("dist/runner.js");
const FAKE_CLI = path.resolve("tests/fixtures/fake-cli.mjs");

function makeJob(overrides: Partial<Record<string, unknown>> = {}) {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-run-"));
  const spec = {
    bin: FAKE_CLI,
    args: [],
    cwd: jobDir,
    env: {},
    timeoutMs: 30_000,
    ...overrides,
  };
  fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(spec));
  return jobDir;
}

function runRunner(jobDir: string) {
  return spawn(process.execPath, [RUNNER, jobDir], { stdio: "ignore" });
}

async function waitForResult(jobDir: string, timeoutMs = 10_000) {
  const resultPath = path.join(jobDir, "result.json");
  const start = Date.now();
  while (!fs.existsSync(resultPath)) {
    if (Date.now() - start > timeoutMs) throw new Error("result.json timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
  return JSON.parse(fs.readFileSync(resultPath, "utf8"));
}

describe("runner", () => {
  it("成功したジョブは succeeded を記録し stdout を output.log に残す", async () => {
    const jobDir = makeJob();
    runRunner(jobDir);
    const result = await waitForResult(jobDir);
    expect(result.state).toBe("succeeded");
    expect(result.exitCode).toBe(0);
    const log = fs.readFileSync(path.join(jobDir, "output.log"), "utf8");
    expect(log).toContain('"result":"fake done"');
  });

  it("失敗したジョブは failed を記録し stderr を stderr.log に残す", async () => {
    const jobDir = makeJob({ env: { FAKE_MODE: "fail" } });
    runRunner(jobDir);
    const result = await waitForResult(jobDir);
    expect(result.state).toBe("failed");
    expect(result.exitCode).toBe(1);
    const err = fs.readFileSync(path.join(jobDir, "stderr.log"), "utf8");
    expect(err).toContain("auth expired");
  });

  it("timeoutMs 超過で timed_out を記録する", async () => {
    const jobDir = makeJob({ env: { FAKE_MODE: "sleep" }, timeoutMs: 500 });
    runRunner(jobDir);
    const result = await waitForResult(jobDir);
    expect(result.state).toBe("timed_out");
  });

  it("SIGTERM で cancelled を記録する", async () => {
    const jobDir = makeJob({ env: { FAKE_MODE: "sleep" } });
    const runner = runRunner(jobDir);
    await new Promise((r) => setTimeout(r, 500));
    runner.kill("SIGTERM");
    const result = await waitForResult(jobDir);
    expect(result.state).toBe("cancelled");
  });

  it("job.json の env が子プロセスに渡る(FAKE_MODEで検証済み)かつ既存envも継承される", async () => {
    const jobDir = makeJob({ env: { FAKE_MODE: "fail" } });
    runRunner(jobDir);
    const result = await waitForResult(jobDir);
    expect(result.state).toBe("failed");
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npm run build && npx vitest run tests/runner.test.ts`
Expected: build が `src/runner.ts` 不在でエラー、またはテストが `dist/runner.js` 不在でFAIL

- [ ] **Step 4: 実装を書く**

`src/runner.ts`:

```ts
// detachedに起動されるジョブランナー。
// 使い方: node dist/runner.js <jobDir>
// <jobDir>/job.json を読んでCLIを実行し、完了時に result.json を書く。
// MCPサーバー本体が終了してもこのプロセスがジョブを完走させる。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface JobSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

const jobDir = process.argv[2];
if (!jobDir) {
  console.error("usage: runner.js <jobDir>");
  process.exit(2);
}

const spec: JobSpec = JSON.parse(
  fs.readFileSync(path.join(jobDir, "job.json"), "utf8"),
);

const out = fs.openSync(path.join(jobDir, "output.log"), "a");
const err = fs.openSync(path.join(jobDir, "stderr.log"), "a");

const child = spawn(spec.bin, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: ["ignore", out, err],
});

let overrideState: "cancelled" | "timed_out" | undefined;

const timer = setTimeout(() => {
  overrideState = "timed_out";
  child.kill("SIGKILL");
}, spec.timeoutMs);

process.on("SIGTERM", () => {
  overrideState = "cancelled";
  child.kill("SIGTERM");
  // 猶予後も生きていたら強制kill
  setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
});

child.on("error", (e) => {
  clearTimeout(timer);
  fs.writeFileSync(path.join(jobDir, "stderr.log"), String(e), { flag: "a" });
  fs.writeFileSync(
    path.join(jobDir, "result.json"),
    JSON.stringify({
      state: "failed",
      exitCode: null,
      signal: null,
      endedAt: new Date().toISOString(),
    }),
  );
  process.exit(0);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const state =
    overrideState ?? (code === 0 ? "succeeded" : "failed");
  fs.writeFileSync(
    path.join(jobDir, "result.json"),
    JSON.stringify({
      state,
      exitCode: code,
      signal,
      endedAt: new Date().toISOString(),
    }),
  );
  process.exit(0);
});
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npm test`
Expected: PASS(commands 8 + runner 5)

- [ ] **Step 6: コミット**

```bash
git add src/runner.ts tests/fixtures/fake-cli.mjs tests/runner.test.ts
git commit -m "feat: detachedジョブランナーとテスト用fake CLI"
```

---

### Task 3: ジョブマネージャ (`jobs.ts`)

**Files:**
- Create: `src/jobs.ts`
- Test: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `buildCommand`, `extractFinalMessage`, `DelegateSpec`, `Bins`, `Target`(Task 1)、`dist/runner.js`(Task 2)
- Produces:
  - `type JobState = "running" | "succeeded" | "failed" | "cancelled" | "timed_out"`
  - `interface JobMeta { id: string; target: Target; prompt: string; cwd: string; model?: string; runnerPid: number; startedAt: string; timeoutMinutes: number }`
  - `class DepthLimitError extends Error`
  - `class JobNotFoundError extends Error`
  - `interface JobManagerOptions { jobsDir: string; bins: Bins; depth: number; runnerPath: string }`
  - `class JobManager`:
    - `delegate(spec: DelegateSpec & { timeoutMinutes?: number }): JobMeta`(depth>=2で`DepthLimitError`)
    - `status(id: string): { meta: JobMeta; state: JobState; exitCode: number | null; logTail: string; stderrTail: string }`
    - `result(id: string): { state: JobState; finalMessage?: string; exitCode?: number | null; stderrTail?: string }`
    - `cancel(id: string): void`(実行中でなければ`Error`)
    - `list(limit?: number): Array<{ meta: JobMeta; state: JobState }>`(startedAt降順、デフォルト20件)

- [ ] **Step 1: 失敗するテストを書く**

`tests/jobs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JobManager,
  DepthLimitError,
  JobNotFoundError,
} from "../src/jobs.js";

const RUNNER = path.resolve("dist/runner.js");
const FAKE_CLI = path.resolve("tests/fixtures/fake-cli.mjs");

function makeManager(depth = 0) {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-jobs-"));
  return new JobManager({
    jobsDir,
    bins: { claude: FAKE_CLI, codex: FAKE_CLI },
    depth,
    runnerPath: RUNNER,
  });
}

async function waitForState(
  manager: JobManager,
  id: string,
  timeoutMs = 10_000,
) {
  const start = Date.now();
  for (;;) {
    const { state } = manager.status(id);
    if (state !== "running") return state;
    if (Date.now() - start > timeoutMs) throw new Error("state timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("JobManager", () => {
  it("delegateは即JobMetaを返し、ジョブは完走してsucceededになる", async () => {
    const m = makeManager();
    const meta = m.delegate({
      target: "claude",
      prompt: "hello",
      cwd: os.tmpdir(),
    });
    expect(meta.id).toBeTruthy();
    expect(meta.runnerPid).toBeGreaterThan(0);
    const state = await waitForState(m, meta.id);
    expect(state).toBe("succeeded");
    const res = m.result(meta.id);
    expect(res.finalMessage).toBe("fake done");
    expect(res.exitCode).toBe(0);
  });

  it("codexターゲットはlast-message.txt経由で結果を返す", async () => {
    const m = makeManager();
    const meta = m.delegate({
      target: "codex",
      prompt: "hello",
      cwd: os.tmpdir(),
    });
    await waitForState(m, meta.id);
    expect(m.result(meta.id).finalMessage).toBe("fake codex done");
  });

  it("失敗ジョブはfailedになりstderrTailに原因を含む", async () => {
    const m = makeManager();
    process.env.FAKE_MODE = "fail";
    try {
      const meta = m.delegate({
        target: "claude",
        prompt: "x",
        cwd: os.tmpdir(),
      });
      const state = await waitForState(m, meta.id);
      expect(state).toBe("failed");
      expect(m.result(meta.id).stderrTail).toContain("auth expired");
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  it("cancelで実行中ジョブがcancelledになる", async () => {
    const m = makeManager();
    process.env.FAKE_MODE = "sleep";
    try {
      const meta = m.delegate({
        target: "claude",
        prompt: "x",
        cwd: os.tmpdir(),
      });
      await new Promise((r) => setTimeout(r, 500));
      m.cancel(meta.id);
      const state = await waitForState(m, meta.id);
      expect(state).toBe("cancelled");
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  it("depth>=2ではDepthLimitErrorを投げる", () => {
    const m = makeManager(2);
    expect(() =>
      m.delegate({ target: "claude", prompt: "x", cwd: os.tmpdir() }),
    ).toThrow(DepthLimitError);
  });

  it("depth=1は許容され、ジョブにはAGENT_BRIDGE_DEPTH=2が渡る", async () => {
    const m = makeManager(1);
    const meta = m.delegate({
      target: "claude",
      prompt: "x",
      cwd: os.tmpdir(),
    });
    await waitForState(m, meta.id);
    const jobSpec = JSON.parse(
      fs.readFileSync(
        path.join(
          (m as unknown as { opts: { jobsDir: string } }).opts.jobsDir,
          meta.id,
          "job.json",
        ),
        "utf8",
      ),
    );
    expect(jobSpec.env.AGENT_BRIDGE_DEPTH).toBe("2");
  });

  it("不明なjob_idはJobNotFoundError", () => {
    const m = makeManager();
    expect(() => m.status("nope")).toThrow(JobNotFoundError);
    expect(() => m.result("nope")).toThrow(JobNotFoundError);
    expect(() => m.cancel("nope")).toThrow(JobNotFoundError);
  });

  it("未完了ジョブのresultはstate: runningを返す", async () => {
    const m = makeManager();
    process.env.FAKE_MODE = "sleep";
    try {
      const meta = m.delegate({
        target: "claude",
        prompt: "x",
        cwd: os.tmpdir(),
      });
      await new Promise((r) => setTimeout(r, 300));
      const res = m.result(meta.id);
      expect(res.state).toBe("running");
      expect(res.finalMessage).toBeUndefined();
      m.cancel(meta.id);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  it("listはstartedAt降順で返す", async () => {
    const m = makeManager();
    const a = m.delegate({ target: "claude", prompt: "a", cwd: os.tmpdir() });
    await new Promise((r) => setTimeout(r, 50));
    const b = m.delegate({ target: "claude", prompt: "b", cwd: os.tmpdir() });
    await waitForState(m, a.id);
    await waitForState(m, b.id);
    const jobs = m.list();
    expect(jobs[0].meta.id).toBe(b.id);
    expect(jobs[1].meta.id).toBe(a.id);
    expect(m.list(1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run build 2>&1 | head -5; npx vitest run tests/jobs.test.ts`
Expected: FAIL(`src/jobs.js` が存在しない)

- [ ] **Step 3: 実装を書く**

`src/jobs.ts`:

```ts
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildCommand,
  extractFinalMessage,
  type Bins,
  type DelegateSpec,
} from "./commands.js";
import type { Target } from "./commands.js";

export type JobState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface JobMeta {
  id: string;
  target: Target;
  prompt: string;
  cwd: string;
  model?: string;
  runnerPid: number;
  startedAt: string;
  timeoutMinutes: number;
}

interface JobResultFile {
  state: Exclude<JobState, "running">;
  exitCode: number | null;
  signal: string | null;
  endedAt: string;
}

export class DepthLimitError extends Error {}
export class JobNotFoundError extends Error {}

export interface JobManagerOptions {
  jobsDir: string;
  bins: Bins;
  depth: number;
  runnerPath: string;
}

const TAIL_CHARS = 2000;

function tail(file: string): string {
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  return text.slice(-TAIL_CHARS);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class JobManager {
  constructor(private opts: JobManagerOptions) {}

  delegate(spec: DelegateSpec & { timeoutMinutes?: number }): JobMeta {
    if (this.opts.depth >= 2) {
      throw new DepthLimitError(
        `再委譲の深さ制限(AGENT_BRIDGE_DEPTH=${this.opts.depth})に達しました。これ以上の連鎖委譲は禁止されています。`,
      );
    }
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const jobDir = path.join(this.opts.jobsDir, id);
    fs.mkdirSync(jobDir, { recursive: true });

    const cmd = buildCommand(spec, jobDir, this.opts.bins);
    const timeoutMinutes = spec.timeoutMinutes ?? 30;
    fs.writeFileSync(
      path.join(jobDir, "job.json"),
      JSON.stringify(
        {
          bin: cmd.bin,
          args: cmd.args,
          cwd: spec.cwd,
          env: { AGENT_BRIDGE_DEPTH: String(this.opts.depth + 1) },
          timeoutMs: timeoutMinutes * 60_000,
        },
        null,
        2,
      ),
    );

    const runner = spawn(process.execPath, [this.opts.runnerPath, jobDir], {
      detached: true,
      stdio: "ignore",
    });
    runner.unref();

    const meta: JobMeta = {
      id,
      target: spec.target,
      prompt: spec.prompt,
      cwd: spec.cwd,
      model: spec.model,
      runnerPid: runner.pid ?? -1,
      startedAt: new Date().toISOString(),
      timeoutMinutes,
    };
    fs.writeFileSync(
      path.join(jobDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
    return meta;
  }

  private jobDir(id: string): string {
    const dir = path.join(this.opts.jobsDir, id);
    if (!fs.existsSync(path.join(dir, "meta.json"))) {
      throw new JobNotFoundError(`job_id が見つかりません: ${id}`);
    }
    return dir;
  }

  private readMeta(id: string): JobMeta {
    return JSON.parse(
      fs.readFileSync(path.join(this.jobDir(id), "meta.json"), "utf8"),
    );
  }

  private readResult(id: string): JobResultFile | undefined {
    const p = path.join(this.jobDir(id), "result.json");
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  private stateOf(id: string): { state: JobState; exitCode: number | null } {
    const result = this.readResult(id);
    if (result) return { state: result.state, exitCode: result.exitCode };
    const meta = this.readMeta(id);
    if (pidAlive(meta.runnerPid)) return { state: "running", exitCode: null };
    // ランナーがresult.jsonを書かずに死んだ(クラッシュ等)
    return { state: "failed", exitCode: null };
  }

  status(id: string) {
    const meta = this.readMeta(id);
    const { state, exitCode } = this.stateOf(id);
    const dir = this.jobDir(id);
    return {
      meta,
      state,
      exitCode,
      logTail: tail(path.join(dir, "output.log")),
      stderrTail: tail(path.join(dir, "stderr.log")),
    };
  }

  result(id: string) {
    const meta = this.readMeta(id);
    const { state, exitCode } = this.stateOf(id);
    if (state === "running") {
      return { state } as const;
    }
    const dir = this.jobDir(id);
    return {
      state,
      exitCode,
      finalMessage: extractFinalMessage(meta.target, dir),
      stderrTail: tail(path.join(dir, "stderr.log")),
    };
  }

  cancel(id: string): void {
    const meta = this.readMeta(id);
    const { state } = this.stateOf(id);
    if (state !== "running") {
      throw new Error(`ジョブは実行中ではありません(state: ${state})`);
    }
    process.kill(meta.runnerPid, "SIGTERM");
  }

  list(limit = 20) {
    if (!fs.existsSync(this.opts.jobsDir)) return [];
    const ids = fs
      .readdirSync(this.opts.jobsDir)
      .filter((d) =>
        fs.existsSync(path.join(this.opts.jobsDir, d, "meta.json")),
      );
    const jobs = ids.map((id) => ({
      meta: this.readMeta(id),
      state: this.stateOf(id).state,
    }));
    jobs.sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
    return jobs.slice(0, limit);
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS(commands 8 + runner 5 + jobs 9)

- [ ] **Step 5: コミット**

```bash
git add src/jobs.ts tests/jobs.test.ts
git commit -m "feat: 非同期ジョブマネージャ(委譲・状態・結果・キャンセル・深さ制限)"
```

---

### Task 4: MCPサーバー本体 (`index.ts`)

**Files:**
- Create: `src/index.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `JobManager`, `DepthLimitError`, `JobNotFoundError`(Task 3)
- Produces: stdio MCPサーバー `dist/index.js`。ツール: `delegate_task`, `job_status`, `job_result`, `job_cancel`, `list_jobs`。env: `AGENT_BRIDGE_JOBS_DIR`, `AGENT_BRIDGE_CLAUDE_BIN`, `AGENT_BRIDGE_CODEX_BIN`, `AGENT_BRIDGE_DEPTH` を解釈

- [ ] **Step 1: 失敗するテストを書く**

`tests/server.test.ts`(MCPクライアントSDKで実サーバーをstdio起動して叩くスモークテスト):

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FAKE_CLI = path.resolve("tests/fixtures/fake-cli.mjs");

let client: Client;

function textOf(res: unknown): string {
  const r = res as { content: Array<{ type: string; text: string }> };
  return r.content[0].text;
}

beforeAll(async () => {
  const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-srv-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/index.js")],
    env: {
      ...(process.env as Record<string, string>),
      AGENT_BRIDGE_JOBS_DIR: jobsDir,
      AGENT_BRIDGE_CLAUDE_BIN: FAKE_CLI,
      AGENT_BRIDGE_CODEX_BIN: FAKE_CLI,
      AGENT_BRIDGE_DEPTH: "0",
    },
  });
  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

describe("agent-bridge MCP server", () => {
  it("5つのツールを公開する", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "delegate_task",
      "job_cancel",
      "job_result",
      "job_status",
      "list_jobs",
    ]);
  });

  it("delegate→status→resultの一連が動く", async () => {
    const delegated = await client.callTool({
      name: "delegate_task",
      arguments: { target: "claude", prompt: "hi", cwd: os.tmpdir() },
    });
    const { job_id } = JSON.parse(textOf(delegated));
    expect(job_id).toBeTruthy();

    let state = "running";
    const start = Date.now();
    while (state === "running") {
      if (Date.now() - start > 10_000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 200));
      const st = await client.callTool({
        name: "job_status",
        arguments: { job_id },
      });
      state = JSON.parse(textOf(st)).state;
    }
    expect(state).toBe("succeeded");

    const result = await client.callTool({
      name: "job_result",
      arguments: { job_id },
    });
    expect(JSON.parse(textOf(result)).finalMessage).toBe("fake done");

    const listed = await client.callTool({ name: "list_jobs", arguments: {} });
    expect(JSON.parse(textOf(listed)).length).toBeGreaterThan(0);
  });

  it("存在しないcwdはisErrorで拒否する", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: { target: "claude", prompt: "x", cwd: "/no/such/dir" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it("不明なjob_idはisErrorを返す", async () => {
    const res = await client.callTool({
      name: "job_status",
      arguments: { job_id: "nope" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npm run build 2>&1 | head -5; npx vitest run tests/server.test.ts`
Expected: FAIL(`dist/index.js` が存在しない)

- [ ] **Step 3: 実装を書く**

`src/index.ts`:

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JobManager,
  DepthLimitError,
  JobNotFoundError,
} from "./jobs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_FALLBACK = "/opt/homebrew/bin/claude";
const CODEX_FALLBACK = "/Applications/ChatGPT.app/Contents/Resources/codex";

function resolveBin(envVar: string, name: string, fallback: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const brewPath = `/opt/homebrew/bin/${name}`;
  if (fs.existsSync(brewPath)) return brewPath;
  return fallback;
}

const manager = new JobManager({
  jobsDir:
    process.env.AGENT_BRIDGE_JOBS_DIR ??
    path.join(os.homedir(), ".agent-bridge", "jobs"),
  bins: {
    claude: resolveBin("AGENT_BRIDGE_CLAUDE_BIN", "claude", CLAUDE_FALLBACK),
    codex: resolveBin("AGENT_BRIDGE_CODEX_BIN", "codex", CODEX_FALLBACK),
  },
  depth: Number.parseInt(process.env.AGENT_BRIDGE_DEPTH ?? "0", 10) || 0,
  runnerPath: path.join(__dirname, "runner.js"),
});

const server = new McpServer({ name: "agent-bridge", version: "0.1.0" });

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function withJobErrors<A, R>(fn: (args: A) => R) {
  return async (args: A) => {
    try {
      return ok(fn(args));
    } catch (e) {
      if (e instanceof JobNotFoundError || e instanceof Error) {
        return fail(e.message);
      }
      throw e;
    }
  };
}

server.registerTool(
  "delegate_task",
  {
    description:
      "タスクをもう一方のAIエージェント(claude/codex)に非同期で委譲する。即座にjob_idを返す。進捗はjob_status、結果はjob_resultで回収する。",
    inputSchema: {
      target: z.enum(["claude", "codex"]).describe("委譲先エージェント"),
      prompt: z.string().min(1).describe("委譲するタスクの指示文"),
      cwd: z.string().describe("タスクの作業ディレクトリ(絶対パス)"),
      model: z.string().optional().describe("使用モデルの上書き(任意)"),
      timeout_minutes: z
        .number()
        .positive()
        .optional()
        .describe("タイムアウト(分)。デフォルト30"),
    },
  },
  async ({ target, prompt, cwd, model, timeout_minutes }) => {
    if (!fs.existsSync(cwd)) return fail(`cwd が存在しません: ${cwd}`);
    try {
      const meta = manager.delegate({
        target,
        prompt,
        cwd,
        model,
        timeoutMinutes: timeout_minutes,
      });
      return ok({
        job_id: meta.id,
        state: "running",
        hint: "job_status で進捗、完了後に job_result で結果を取得",
      });
    } catch (e) {
      if (e instanceof DepthLimitError) return fail(e.message);
      throw e;
    }
  },
);

server.registerTool(
  "job_status",
  {
    description: "委譲ジョブの状態(running/succeeded/failed/cancelled/timed_out)と出力ログ末尾を返す。",
    inputSchema: { job_id: z.string() },
  },
  withJobErrors(({ job_id }: { job_id: string }) => {
    const s = manager.status(job_id);
    return {
      job_id,
      state: s.state,
      target: s.meta.target,
      started_at: s.meta.startedAt,
      exit_code: s.exitCode,
      log_tail: s.logTail,
      stderr_tail: s.stderrTail,
    };
  }),
);

server.registerTool(
  "job_result",
  {
    description: "完了した委譲ジョブの最終出力を返す。未完了ならstate: runningを返す。",
    inputSchema: { job_id: z.string() },
  },
  withJobErrors(({ job_id }: { job_id: string }) => {
    const r = manager.result(job_id);
    return { job_id, ...r };
  }),
);

server.registerTool(
  "job_cancel",
  {
    description: "実行中の委譲ジョブをキャンセルする。",
    inputSchema: { job_id: z.string() },
  },
  withJobErrors(({ job_id }: { job_id: string }) => {
    manager.cancel(job_id);
    return { job_id, state: "cancelling" };
  }),
);

server.registerTool(
  "list_jobs",
  {
    description: "直近の委譲ジョブ一覧を返す(新しい順)。",
    inputSchema: {
      limit: z.number().int().positive().optional().describe("最大件数。デフォルト20"),
    },
  },
  withJobErrors(({ limit }: { limit?: number }) => {
    return manager.list(limit).map(({ meta, state }) => ({
      job_id: meta.id,
      state,
      target: meta.target,
      started_at: meta.startedAt,
      prompt_head: meta.prompt.slice(0, 80),
    }));
  }),
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm test`
Expected: PASS(全26テスト: commands 8 + runner 5 + jobs 9 + server 4)

- [ ] **Step 5: コミット**

```bash
git add src/index.ts tests/server.test.ts
git commit -m "feat: agent-bridge MCPサーバー本体(5ツール公開)"
```

---

### Task 5: セットアップ・両クライアント登録・E2E・README

**Files:**
- Create: `README.md`
- Modify: `~/.codex/config.toml`(`[mcp_servers.agent-bridge]` 追記)
- 登録: `claude mcp add`(ユーザースコープ)
- Symlink: `/opt/homebrew/bin/codex`

**Interfaces:**
- Consumes: `dist/index.js`(Task 4)
- Produces: 両クライアントから使える稼働状態のブリッジ

- [ ] **Step 1: codex CLIをPATHに通す**

```bash
ln -sf "/Applications/ChatGPT.app/Contents/Resources/codex" /opt/homebrew/bin/codex
codex --version
```

Expected: `codex-cli 0.144.0-alpha.4` 等が表示される

- [ ] **Step 2: ビルドしてClaude Codeに登録**

```bash
cd /Users/nariiwa/Projects/agent-bridge-mcp && npm run build
claude mcp add --scope user agent-bridge -- node /Users/nariiwa/Projects/agent-bridge-mcp/dist/index.js
claude mcp list
```

Expected: `agent-bridge` が一覧に表示される

- [ ] **Step 3: Codexに登録**

`~/.codex/config.toml` の末尾に追記(既存内容は変更しない):

```toml
[mcp_servers.agent-bridge]
command = "node"
args = ["/Users/nariiwa/Projects/agent-bridge-mcp/dist/index.js"]
```

Run: `codex mcp list`
Expected: `agent-bridge` が表示される

- [ ] **Step 4: E2E — Claude→Codex委譲**

```bash
cd /Users/nariiwa/Projects/agent-bridge-mcp
claude -p 'agent-bridgeのdelegate_taskツールでcodexに「1+1を計算して答えだけ返して」というタスクを委譲し(cwdはカレントディレクトリ)、job_statusをポーリングして完了したらjob_resultの内容を報告して' --permission-mode acceptEdits
```

Expected: job_idが発行され、最終的にCodexの回答(「2」を含む)が報告される。`~/.agent-bridge/jobs/<id>/result.json` に `"state":"succeeded"` がある

- [ ] **Step 5: E2E — Codex→Claude委譲**

```bash
cd /Users/nariiwa/Projects/agent-bridge-mcp
codex exec --skip-git-repo-check 'Use the agent-bridge delegate_task tool to delegate this task to claude: "1+1を計算して答えだけ返して" (cwd: current directory). Poll job_status until done, then report the job_result content.'
```

Expected: 同様にjob_idが発行され、Claudeの回答が報告される

- [ ] **Step 6: 深さ制限の動作確認**

```bash
AGENT_BRIDGE_DEPTH=2 claude -p 'agent-bridgeのdelegate_taskでcodexに「テスト」を委譲してみて。エラーになったらそのエラーメッセージをそのまま報告して' --permission-mode acceptEdits
```

Expected: 「再委譲の深さ制限」を含むエラーが報告され、ジョブは起動されない

- [ ] **Step 7: READMEを書く**

`README.md`(概要・アーキテクチャ図・5ツールの説明・セットアップ手順(Step 1〜3の内容)・env一覧・深さ制限の説明・トラブルシュート(認証切れ/バイナリ不在時は `job_status` の `stderr_tail` を見る)を記載。本計画のStep 1〜3のコマンドをそのまま転記する)

- [ ] **Step 8: コミット**

```bash
git add README.md
git commit -m "docs: README(セットアップ・使い方・E2E手順)"
```

---

## Self-Review 結果

- スペック網羅: 5ツール(Task 4)、非同期ジョブ+永続化+セッション跨ぎ回収(Task 2/3)、深さ制限(Task 3/4、E2E Task 5 Step 6)、サンドボックス/権限フラグ(Task 1 buildCommand)、タイムアウト(Task 2)、エラー処理(Task 3/4)、両クライアント登録+symlink(Task 5)、fake CLIによる単体テスト+実CLI E2E(全Task) — 全て対応
- 型整合: `DelegateSpec`/`Bins`/`JobMeta`/`JobState` の名前と形はTask 1→3→4で一貫
- 注記: スペックの「output.log(stdout/stderr)」は、Claude結果のJSONパースをstderr混入から守るため stdout→`output.log` / stderr→`stderr.log` に分離した(スペックの意図は維持)
