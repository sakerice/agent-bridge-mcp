import { describe, it, expect, vi } from "vitest";
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

  it("巨大なログでもstatusは末尾だけを有界に返す", async () => {
    const m = makeManager();
    const meta = m.delegate({
      target: "claude",
      prompt: "x",
      cwd: os.tmpdir(),
    });
    await waitForState(m, meta.id);
    const jobsDir = (m as unknown as { opts: { jobsDir: string } }).opts.jobsDir;
    fs.writeFileSync(
      path.join(jobsDir, meta.id, "output.log"),
      `${"古".repeat(100_000)}LATEST`,
    );
    const logTail = m.status(meta.id).logTail;
    expect(logTail.length).toBeLessThanOrEqual(2000);
    expect(logTail.endsWith("LATEST")).toBe(true);
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

  it("パストラバーサルはJobNotFoundErrorで拒否される", () => {
    const m = makeManager();
    // Various path traversal attempts
    expect(() => m.status("../../etc")).toThrow(JobNotFoundError);
    expect(() => m.result("../../../passwd")).toThrow(JobNotFoundError);
    expect(() => m.cancel("a/b")).toThrow(JobNotFoundError);
    expect(() => m.status("..\\..\\windows")).toThrow(JobNotFoundError);
    expect(() => m.status("./etc/passwd")).toThrow(JobNotFoundError);
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

  function writeRawJob(
    m: JobManager,
    overrides: Partial<{
      runnerPid: number;
      startedAt: string;
      timeoutMinutes: number;
    }>,
  ): string {
    const jobsDir = (m as unknown as { opts: { jobsDir: string } }).opts
      .jobsDir;
    const id = `${Date.now().toString(36)}-deadbeef`;
    const dir = path.join(jobsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id,
        target: "claude",
        prompt: "x",
        cwd: os.tmpdir(),
        runnerPid: -1,
        startedAt: new Date().toISOString(),
        timeoutMinutes: 30,
        ...overrides,
      }),
    );
    return id;
  }

  it("runnerPid=-1のジョブはstatus()でfailedになりcancel()はkillせず例外を投げる", () => {
    const m = makeManager();
    const id = writeRawJob(m, { runnerPid: -1 });
    expect(m.status(id).state).toBe("failed");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      expect(() => m.cancel(id)).toThrow();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("開始から(timeoutMinutes+猶予)を過ぎてpidが生きていてもfailed扱いになる(PID再利用対策)", () => {
    const m = makeManager();
    const staleStartedAt = new Date(
      Date.now() - 60 * 60_000, // 60分前
    ).toISOString();
    const id = writeRawJob(m, {
      runnerPid: process.pid, // 自プロセス=常にalive
      startedAt: staleStartedAt,
      timeoutMinutes: 1,
    });
    expect(m.status(id).state).toBe("failed");
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

  it("follow_up_ofで前ジョブのセッションを--resume継続する", async () => {
    const m = makeManager();
    const jobsDir = (m as unknown as { opts: { jobsDir: string } }).opts
      .jobsDir;
    const parent = m.delegate({
      target: "claude",
      prompt: "a",
      cwd: os.tmpdir(),
    });
    await waitForState(m, parent.id);
    const child = m.delegate({
      target: "claude",
      prompt: "続き",
      cwd: os.tmpdir(),
      followUpOf: parent.id,
    });
    await waitForState(m, child.id);
    const jobSpec = JSON.parse(
      fs.readFileSync(path.join(jobsDir, child.id, "job.json"), "utf8"),
    );
    expect(jobSpec.args).toContain("--resume");
    expect(jobSpec.args[jobSpec.args.indexOf("--resume") + 1]).toBe(
      "fake-sess-1",
    );
  });

  it("follow_up_ofのターゲット不一致はエラー", async () => {
    const m = makeManager();
    const parent = m.delegate({
      target: "claude",
      prompt: "a",
      cwd: os.tmpdir(),
    });
    await waitForState(m, parent.id);
    expect(() =>
      m.delegate({
        target: "codex",
        prompt: "x",
        cwd: os.tmpdir(),
        followUpOf: parent.id,
      }),
    ).toThrow(/target/);
  });

  it("実行中ジョブへのfollow_up_ofは競合防止のため拒否する", async () => {
    const m = makeManager();
    process.env.FAKE_MODE = "sleep";
    try {
      const parent = m.delegate({
        target: "claude",
        prompt: "a",
        cwd: os.tmpdir(),
      });
      expect(() =>
        m.delegate({
          target: "claude",
          prompt: "続き",
          cwd: os.tmpdir(),
          followUpOf: parent.id,
        }),
      ).toThrow(/実行中/);
      m.cancel(parent.id);
      await waitForState(m, parent.id);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  it("cwdは絶対パスのディレクトリだけを受け付ける", () => {
    const m = makeManager();
    const file = path.join(os.tmpdir(), `abm-file-${Date.now()}`);
    fs.writeFileSync(file, "x");
    expect(() =>
      m.delegate({ target: "claude", prompt: "x", cwd: "relative" }),
    ).toThrow(/絶対パス/);
    expect(() =>
      m.delegate({ target: "claude", prompt: "x", cwd: file }),
    ).toThrow(/ディレクトリ/);
  });

  it("ジョブディレクトリとJSONファイルを非公開権限で作る", async () => {
    if (process.platform === "win32") return;
    const m = makeManager();
    const meta = m.delegate({
      target: "claude",
      prompt: "secret",
      cwd: os.tmpdir(),
    });
    await waitForState(m, meta.id);
    const jobsDir = (m as unknown as { opts: { jobsDir: string } }).opts.jobsDir;
    const dir = path.join(jobsDir, meta.id);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "meta.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "job.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "result.json")).mode & 0o777).toBe(0o600);
  });

  it("follow_up_ofで前ジョブにセッションIDが無ければエラー", async () => {
    const m = makeManager();
    process.env.FAKE_MODE = "fail";
    try {
      const parent = m.delegate({
        target: "claude",
        prompt: "a",
        cwd: os.tmpdir(),
      });
      await waitForState(m, parent.id);
      expect(() =>
        m.delegate({
          target: "claude",
          prompt: "x",
          cwd: os.tmpdir(),
          followUpOf: parent.id,
        }),
      ).toThrow(/セッション/);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });
});
