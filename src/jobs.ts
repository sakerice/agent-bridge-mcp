import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildCommand,
  extractFinalMessage,
  extractSessionId,
  type Bins,
  type DelegateSpec,
} from "./commands.js";
import type { Target } from "./commands.js";
import { writeJsonAtomic } from "./storage.js";

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
  mode?: "task" | "review";
  followUpOf?: string;
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
const TAIL_BYTES = 16 * 1024;

function tail(file: string): string {
  if (!fs.existsSync(file)) return "";
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const bytes = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(bytes);
    fs.readSync(fd, buffer, 0, bytes, size - bytes);
    // Starting in the middle of a UTF-8 sequence can produce one replacement
    // character, but reading from the end and slicing by characters remains
    // bounded and preserves the newest log content.
    return buffer.toString("utf8").slice(-TAIL_CHARS);
  } finally {
    fs.closeSync(fd);
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STALE_GRACE_MS = 5 * 60_000;

export class JobManager {
  constructor(private opts: JobManagerOptions) {}

  delegate(
    spec: DelegateSpec & { timeoutMinutes?: number; followUpOf?: string },
  ): JobMeta {
    if (this.opts.depth >= 2) {
      throw new DepthLimitError(
        `再委譲の深さ制限(AGENT_BRIDGE_DEPTH=${this.opts.depth})に達しました。これ以上の連鎖委譲は禁止されています。`,
      );
    }
    if (!path.isAbsolute(spec.cwd)) {
      throw new Error(`cwd は絶対パスで指定してください: ${spec.cwd}`);
    }
    let cwdStat: fs.Stats;
    try {
      cwdStat = fs.statSync(spec.cwd);
    } catch {
      throw new Error(`cwd が存在しません: ${spec.cwd}`);
    }
    if (!cwdStat.isDirectory()) {
      throw new Error(`cwd はディレクトリではありません: ${spec.cwd}`);
    }

    // 継続委譲: 前ジョブのセッションIDを取り出し、同じワーカーセッションを再開する
    let resumeSessionId = spec.resumeSessionId;
    if (spec.followUpOf) {
      const parent = this.readMeta(spec.followUpOf);
      if (parent.target !== spec.target) {
        throw new Error(
          `follow_up_of のジョブは target が異なります(前: ${parent.target}, 今回: ${spec.target})`,
        );
      }
      const parentState = this.stateOf(spec.followUpOf).state;
      if (parentState === "running") {
        throw new Error(
          `前ジョブ(${spec.followUpOf})はまだ実行中です。完了後に follow_up_of を指定してください。`,
        );
      }
      resumeSessionId = extractSessionId(
        parent.target,
        this.jobDir(spec.followUpOf),
      );
      if (!resumeSessionId) {
        throw new Error(
          `前ジョブ(${spec.followUpOf})からセッションIDを取得できませんでした。新規委譲(follow_up_ofなし)で依頼してください。`,
        );
      }
    }

    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const jobDir = path.join(this.opts.jobsDir, id);
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });

    const cmd = buildCommand(
      { ...spec, resumeSessionId },
      jobDir,
      this.opts.bins,
      this.opts.depth + 1,
    );
    const timeoutMinutes = spec.timeoutMinutes ?? 30;
    writeJsonAtomic(path.join(jobDir, "job.json"), {
      bin: cmd.bin,
      args: cmd.args,
      cwd: spec.cwd,
      env: { AGENT_BRIDGE_DEPTH: String(this.opts.depth + 1) },
      timeoutMs: timeoutMinutes * 60_000,
    });

    const runner = spawn(process.execPath, [this.opts.runnerPath, jobDir], {
      detached: true,
      stdio: "ignore",
    });
    runner.unref();

    const runnerPid = runner.pid ?? -1;
    if (runnerPid <= 0) {
      // spawnがpidを取得できなかった(起動失敗)。runnerPid=-1は
      // process.kill(-1, ...)がプロセスグループ全体を対象にしてしまう危険な
      // センチネルなので、result.jsonを先に書いてstateOf()がresult.json優先で
      // failedを返すようにし、"running"のまま取り残されないようにする。
      writeJsonAtomic(path.join(jobDir, "result.json"), {
        state: "failed",
        exitCode: null,
        signal: null,
        endedAt: new Date().toISOString(),
      });
    }

    const meta: JobMeta = {
      id,
      target: spec.target,
      prompt: spec.prompt,
      cwd: spec.cwd,
      model: spec.model,
      runnerPid,
      startedAt: new Date().toISOString(),
      timeoutMinutes,
      mode: spec.mode,
      followUpOf: spec.followUpOf,
    };
    writeJsonAtomic(path.join(jobDir, "meta.json"), meta);
    return meta;
  }

  private jobDir(id: string): string {
    // Validate job ID format to prevent path traversal
    if (!/^[a-z0-9]+-[a-f0-9]{8}$/.test(id)) {
      throw new JobNotFoundError(`job_id が見つかりません: ${id}`);
    }
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
    if (pidAlive(meta.runnerPid)) {
      // ランナー自身がtimeoutMsを強制するため、正当なランナーはこの猶予期限を
      // 超えて生き残ることはない。超えていればOS再起動やPID再利用により
      // 無関係なプロセスを指している可能性が高いのでfailed扱いにする
      // (cancel()が無関係なプロセスにSIGTERMを送るのを防ぐ)。
      const deadline =
        new Date(meta.startedAt).getTime() +
        meta.timeoutMinutes * 60_000 +
        STALE_GRACE_MS;
      if (Date.now() > deadline) {
        return { state: "failed", exitCode: null };
      }
      return { state: "running", exitCode: null };
    }
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
    // 多重防御: runnerPidが不正(<=0)な場合は絶対にkillを呼ばない。
    // stateOf()がすでにこのケースをfailed扱いにするため実際には下のチェックで
    // 弾かれるはずだが、pid<=0でのkill呼び出し自体を明示的に禁止しておく。
    if (meta.runnerPid <= 0) {
      throw new Error("ジョブは実行中ではありません(state: failed)");
    }
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
