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
        .max(10080)
        .optional()
        .describe(
          "タイムアウト(分)。デフォルト30。上限10080分(7日)。" +
            "これを超えると内部のsetTimeout遅延がInt32範囲(約24.8日)をオーバーフローし、" +
            "意図せず即time_outする恐れがあるため上限を設けている",
        ),
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
