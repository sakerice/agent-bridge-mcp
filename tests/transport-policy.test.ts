import { spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertStdioTransport,
  SUPPORTED_TRANSPORT,
} from "../src/transport-policy.js";

describe("stdio-only transport policy", () => {
  it("未指定またはstdioを許可する", () => {
    expect(assertStdioTransport(undefined)).toBe(SUPPORTED_TRANSPORT);
    expect(assertStdioTransport("stdio")).toBe(SUPPORTED_TRANSPORT);
    expect(assertStdioTransport("  stdio  ")).toBe(SUPPORTED_TRANSPORT);
  });

  it.each(["http", "sse", "streamable-http"])(
    "%sを拒否する",
    (transport) => {
      expect(() => assertStdioTransport(transport)).toThrow(/stdio/);
    },
  );

  it("サーバー起動時にも非stdio設定をfail-closedで拒否する", async () => {
    const serverPath = path.resolve("dist/index.js");
    const result = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [serverPath], {
          env: { ...process.env, AGENT_BRIDGE_TRANSPORT: "sse" },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("許可されていません");
    expect(result.stderr).toContain("stdio");
  });
});
