// detachedに起動されるジョブランナー。
// 使い方: node dist/runner.js <jobDir>
// <jobDir>/job.json を読んでCLIを実行し、完了時に result.json を書く。
// MCPサーバー本体が終了してもこのプロセスがジョブを完走させる。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./storage.js";

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

let spec: JobSpec;
try {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(jobDir, "job.json"), "utf8"),
  );
  if (!isJobSpec(parsed)) throw new Error("job.json の形式が不正です");
  spec = parsed;
} catch (e) {
  try {
    fs.writeFileSync(path.join(jobDir, "stderr.log"), String(e), {
      flag: "a",
      mode: 0o600,
    });
    writeJsonAtomic(path.join(jobDir, "result.json"), {
      state: "failed",
      exitCode: null,
      signal: null,
      endedAt: new Date().toISOString(),
    });
  } catch (writeErr) {
    console.error("Failed to write error result:", writeErr);
    process.exit(1);
  }
  process.exit(0);
}

function isJobSpec(value: unknown): value is JobSpec {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<JobSpec>;
  return (
    typeof v.bin === "string" &&
    v.bin.length > 0 &&
    Array.isArray(v.args) &&
    v.args.every((arg) => typeof arg === "string") &&
    typeof v.cwd === "string" &&
    v.cwd.length > 0 &&
    !!v.env &&
    typeof v.env === "object" &&
    Object.values(v.env).every((entry) => typeof entry === "string") &&
    typeof v.timeoutMs === "number" &&
    Number.isFinite(v.timeoutMs) &&
    v.timeoutMs > 0
  );
}

const out = fs.openSync(path.join(jobDir, "output.log"), "a", 0o600);
const err = fs.openSync(path.join(jobDir, "stderr.log"), "a", 0o600);

const child = spawn(spec.bin, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: ["ignore", out, err],
  // Put the CLI and any descendants in their own process group on POSIX so a
  // timeout/cancel does not leave tool subprocesses running in the background.
  detached: process.platform !== "win32",
});

let overrideState: "cancelled" | "timed_out" | undefined;

// setTimeoutの遅延はInt32(2^31-1ms、約24.8日)を超えるとオーバーフローして
// ほぼ即発火してしまうため、上流でのバリデーション漏れに備えてここでもclampする。
const timeoutMs = Math.min(spec.timeoutMs, 2 ** 31 - 1);

function killChildTree(signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

const timer = setTimeout(() => {
  if (overrideState === undefined) {
    overrideState = "timed_out";
  }
  killChildTree("SIGKILL");
}, timeoutMs);

process.on("SIGTERM", () => {
  clearTimeout(timer);
  // timeoutとcancelが競合した場合は、先に確定した終了理由を保持する。
  if (overrideState === undefined) overrideState = "cancelled";
  killChildTree("SIGTERM");
  // 猶予後も生きていたら強制kill
  setTimeout(() => killChildTree("SIGKILL"), 3_000).unref();
});

child.on("error", (e) => {
  clearTimeout(timer);
  fs.writeFileSync(path.join(jobDir, "stderr.log"), String(e), { flag: "a" });
  writeJsonAtomic(path.join(jobDir, "result.json"), {
    state: "failed",
    exitCode: null,
    signal: null,
    endedAt: new Date().toISOString(),
  });
  process.exit(0);
});

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const state =
    overrideState ?? (code === 0 ? "succeeded" : "failed");
  writeJsonAtomic(path.join(jobDir, "result.json"), {
    state,
    exitCode: code,
    signal,
    endedAt: new Date().toISOString(),
  });
  process.exit(0);
});
