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

let spec: JobSpec;
try {
  spec = JSON.parse(
    fs.readFileSync(path.join(jobDir, "job.json"), "utf8"),
  );
} catch (e) {
  try {
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
  } catch (writeErr) {
    console.error("Failed to write error result:", writeErr);
    process.exit(1);
  }
  process.exit(0);
}

const out = fs.openSync(path.join(jobDir, "output.log"), "a");
const err = fs.openSync(path.join(jobDir, "stderr.log"), "a");

const child = spawn(spec.bin, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: ["ignore", out, err],
});

let overrideState: "cancelled" | "timed_out" | undefined;

const timer = setTimeout(() => {
  if (overrideState === undefined) {
    overrideState = "timed_out";
  }
  child.kill("SIGKILL");
}, spec.timeoutMs);

process.on("SIGTERM", () => {
  clearTimeout(timer);
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
