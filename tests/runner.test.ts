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
