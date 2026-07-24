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

async function spawnClient(
  extraEnv: Record<string, string>,
): Promise<{ client: Client; jobsDir: string }> {
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
      ...extraEnv,
    },
  });
  const c = new Client({ name: "test-client-extra", version: "0.0.1" });
  await c.connect(transport);
  return { client: c, jobsDir };
}

describe("agent-bridge MCP server", () => {
  it("7つのツールを公開する", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "bridge_doctor",
      "delegate_task",
      "get_artifact",
      "job_cancel",
      "job_result",
      "job_status",
      "list_jobs",
    ]);
  });

  it("レビュー用プロンプトを公開する", async () => {
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((p) => p.name).sort();
    expect(names).toContain("codex-review");
    expect(names).toContain("claude-review");
    const got = await client.getPrompt({
      name: "codex-review",
      arguments: {},
    });
    const text = (got.messages[0].content as { text: string }).text;
    expect(text).toContain("delegate_task");
    expect(text).toContain("review");
  });

  it("bridge_doctorが診断結果を返す", async () => {
    const res = await client.callTool({ name: "bridge_doctor", arguments: {} });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.claude_bin.exists).toBe(true);
    expect(parsed.codex_bin.exists).toBe(true);
    expect(parsed.jobs_dir.writable).toBe(true);
    expect(parsed.depth).toBe(0);
    expect(parsed.transport).toEqual({
      active: "stdio",
      http_sse_allowed: false,
    });
  });

  it("job_statusが進捗要約(progress)を返し、follow_up_ofで継続委譲できる", async () => {
    const delegated = await client.callTool({
      name: "delegate_task",
      arguments: { target: "claude", prompt: "hi", cwd: os.tmpdir() },
    });
    const { job_id } = JSON.parse(textOf(delegated));

    let state = "running";
    let progress: string[] = [];
    const start = Date.now();
    while (state === "running") {
      if (Date.now() - start > 10_000) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 200));
      const st = await client.callTool({
        name: "job_status",
        arguments: { job_id },
      });
      const parsed = JSON.parse(textOf(st));
      state = parsed.state;
      progress = parsed.progress;
    }
    expect(progress.some((l) => l.includes("working on it"))).toBe(true);

    const followUp = await client.callTool({
      name: "delegate_task",
      arguments: {
        target: "claude",
        prompt: "続き",
        cwd: os.tmpdir(),
        follow_up_of: job_id,
      },
    });
    const followParsed = JSON.parse(textOf(followUp));
    expect(followParsed.job_id).toBeTruthy();
  });

  it("mode: reviewの委譲を受け付ける", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        target: "codex",
        prompt: "review the repo",
        cwd: os.tmpdir(),
        mode: "review",
      },
    });
    const { job_id } = JSON.parse(textOf(res));
    expect(job_id).toBeTruthy();
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

  it("timeout_minutesが上限(10080分)を超えるとisErrorで拒否する", async () => {
    const res = await client.callTool({
      name: "delegate_task",
      arguments: {
        target: "claude",
        prompt: "x",
        cwd: os.tmpdir(),
        timeout_minutes: 999999999,
      },
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

  it("再委譲の深さ制限を超えるとisErrorで拒否する", async () => {
    const { client: deepClient } = await spawnClient({
      AGENT_BRIDGE_DEPTH: "2",
    });
    try {
      const res = await deepClient.callTool({
        name: "delegate_task",
        arguments: { target: "claude", prompt: "hi", cwd: os.tmpdir() },
      });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(textOf(res)).toContain("再委譲の深さ制限");
    } finally {
      await deepClient.close();
    }
  });

  it("job_cancelで実行中ジョブをcancelledに遷移できる", async () => {
    const { client: sleepClient } = await spawnClient({
      FAKE_MODE: "sleep",
    });
    try {
      const delegated = await sleepClient.callTool({
        name: "delegate_task",
        arguments: { target: "claude", prompt: "hi", cwd: os.tmpdir() },
      });
      const { job_id } = JSON.parse(textOf(delegated));
      expect(job_id).toBeTruthy();

      await new Promise((r) => setTimeout(r, 300));

      const cancelRes = await sleepClient.callTool({
        name: "job_cancel",
        arguments: { job_id },
      });
      expect(JSON.parse(textOf(cancelRes)).state).toBe("cancelling");

      let state = "running";
      const start = Date.now();
      while (state === "running") {
        if (Date.now() - start > 10_000) throw new Error("timeout");
        await new Promise((r) => setTimeout(r, 200));
        const st = await sleepClient.callTool({
          name: "job_status",
          arguments: { job_id },
        });
        state = JSON.parse(textOf(st)).state;
      }
      expect(state).toBe("cancelled");
    } finally {
      await sleepClient.close();
    }
  });

  it("不明なjob_idへのjob_cancelはisErrorを返す", async () => {
    const res = await client.callTool({
      name: "job_cancel",
      arguments: { job_id: "nope" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  it("delegate_taskの説明にモデル選定ガイドとユーザー確認指示を含む", async () => {
    const tools = await client.listTools();
    const delegate = tools.tools.find((t) => t.name === "delegate_task");
    expect(delegate?.description).toContain("モデル選定ガイド");
    expect(delegate?.description).toContain("ユーザーに確認");
    expect(delegate?.description).toContain("gpt-5.6-terra");
    expect(delegate?.description).toContain("claude-sonnet-5");
  });

  it("メディアartifactsを検出し、get_artifactで画像をインライン取得できる", async () => {
    const PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-media-"));
    const delegated = await client.callTool({
      name: "delegate_task",
      arguments: { target: "claude", prompt: "generate image", cwd: workDir },
    });
    const { job_id } = JSON.parse(textOf(delegated));

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

    // ジョブ開始後に生成されたメディアを模擬
    fs.writeFileSync(
      path.join(workDir, "preview.png"),
      Buffer.from(PNG_BASE64, "base64"),
    );

    const result = await client.callTool({
      name: "job_result",
      arguments: { job_id },
    });
    const parsed = JSON.parse(textOf(result));
    expect(
      parsed.artifacts.some((a: { path: string }) =>
        a.path.endsWith("preview.png"),
      ),
    ).toBe(true);

    const art = await client.callTool({
      name: "get_artifact",
      arguments: { job_id, path: "preview.png" },
    });
    const content = (
      art as { content: Array<{ type: string; data?: string; mimeType?: string }> }
    ).content;
    const img = content.find((c) => c.type === "image");
    expect(img?.mimeType).toBe("image/png");
    expect(img?.data).toBe(PNG_BASE64);

    const bad = await client.callTool({
      name: "get_artifact",
      arguments: { job_id, path: "../../../etc/hosts" },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });

  it("AGENT_BRIDGE_MODEL_GUIDE_FILEでガイドを差し替えられる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-guide-"));
    const guidePath = path.join(dir, "model-guide.md");
    fs.writeFileSync(guidePath, "カスタム: worker-model-zzz を使う");
    const { client: guideClient } = await spawnClient({
      AGENT_BRIDGE_MODEL_GUIDE_FILE: guidePath,
    });
    try {
      const tools = await guideClient.listTools();
      const delegate = tools.tools.find((t) => t.name === "delegate_task");
      expect(delegate?.description).toContain("worker-model-zzz");
    } finally {
      await guideClient.close();
    }
  });
});
