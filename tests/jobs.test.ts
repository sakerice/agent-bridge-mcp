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
