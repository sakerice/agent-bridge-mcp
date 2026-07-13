import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadModelGuide, DEFAULT_MODEL_GUIDE } from "../src/model-guide.js";

describe("loadModelGuide", () => {
  it("ファイルがなければ内蔵デフォルトを返す", () => {
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "abm-guide-")),
      "no-such-guide.md",
    );
    expect(loadModelGuide(missing)).toBe(DEFAULT_MODEL_GUIDE);
  });

  it("ファイルがあればその内容を返す", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abm-guide-"));
    const p = path.join(dir, "model-guide.md");
    fs.writeFileSync(p, "カスタムガイド: test-model-x をワーカーに");
    expect(loadModelGuide(p)).toContain("test-model-x");
  });

  it("内蔵デフォルトは両陣営の高位/ワーカー/画像モデルを含む", () => {
    expect(DEFAULT_MODEL_GUIDE).toContain("claude-fable-5");
    expect(DEFAULT_MODEL_GUIDE).toContain("claude-sonnet-5");
    expect(DEFAULT_MODEL_GUIDE).toContain("gpt-5.6-sol");
    expect(DEFAULT_MODEL_GUIDE).toContain("gpt-5.6-terra");
    expect(DEFAULT_MODEL_GUIDE).toContain("gpt-image-2");
  });
});
