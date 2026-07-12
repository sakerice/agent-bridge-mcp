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
