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
  childDepth: number,
): Command {
  if (spec.target === "codex") {
    const args = [
      "exec",
      "--json",
      "-C", spec.cwd,
      "-s", "workspace-write",
      "--skip-git-repo-check",
      // Codex CLIは内蔵MCPサーバーに渡すenvを不透明にサニタイズし得るため、
      // AGENT_BRIDGE_DEPTH の伝播をプロセスenvだけに頼らず、
      // -c (TOMLオーバーライド)経由でも明示的に上書きする。
      "-c", `mcp_servers.agent-bridge.env.AGENT_BRIDGE_DEPTH="${childDepth}"`,
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
