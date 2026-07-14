import { describe, it, expect } from "vitest";
import { summarizeProgress } from "../src/progress.js";

describe("summarizeProgress", () => {
  it("claudeのstream-jsonからテキストとツール使用を要約する", () => {
    const log = [
      '{"type":"system","subtype":"init","session_id":"s"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"まずテストを確認します"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}',
      "not json",
    ].join("\n");
    const lines = summarizeProgress(log);
    expect(lines.some((l) => l.includes("まずテストを確認します"))).toBe(true);
    expect(lines.some((l) => l.includes("Bash"))).toBe(true);
  });

  it("codexのイベントJSONLからコマンド実行やテキストを要約する", () => {
    const log = [
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"テストは通っています"}}',
    ].join("\n");
    const lines = summarizeProgress(log);
    expect(lines.some((l) => l.includes("npm test"))).toBe(true);
    expect(lines.some((l) => l.includes("テストは通っています"))).toBe(true);
  });

  it("最終result行も要約に含む", () => {
    const log = '{"type":"result","result":"完了しました","session_id":"s"}';
    expect(summarizeProgress(log).some((l) => l.includes("完了しました"))).toBe(
      true,
    );
  });

  it("要約対象がなければ空配列、limitで件数を制限する", () => {
    expect(summarizeProgress("plain\ntext")).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: `step ${i}` }] },
      }),
    ).join("\n");
    const lines = summarizeProgress(many, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("step 9");
  });

  it("長いテキストは切り詰める", () => {
    const long = "あ".repeat(500);
    const log = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: long }] },
    });
    const [line] = summarizeProgress(log);
    expect(line.length).toBeLessThan(200);
  });
});
