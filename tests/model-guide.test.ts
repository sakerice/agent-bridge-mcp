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

  // ここでモデル名を固定しないこと。
  //
  // 以前このテストは claude-fable-5 / gpt-5.6-sol / gpt-5.6-terra / gpt-image-2 が
  // 「含まれていること」を要求していた。モデルは入れ替わるので、この形は
  // **ガイドを古いまま固定する**。しかも gpt-image-2 は「画像生成はこれを指定」という
  // 誤った助言とセットで載っていて、そのとおりに指定すると
  // 「not supported when using Codex with a ChatGPT account」で必ず失敗する。
  // 固定すべきなのは名前ではなく、**古くなっても変わらない決まり**のほう。
  it("内蔵デフォルトは日付を明示している(古さを読み手に伝えるため)", () => {
    expect(DEFAULT_MODEL_GUIDE).toMatch(/20\d\d-\d\d-\d\d/);
  });

  it("内蔵デフォルトは画像モデルを model に指定しないよう警告する", () => {
    expect(DEFAULT_MODEL_GUIDE).toContain("model を指定しない");
    // 失敗の実文言を残す。次に踏んだ人が検索で辿り着けるようにするため
    expect(DEFAULT_MODEL_GUIDE).toContain("ChatGPT account");
  });

  it("内蔵デフォルトは高位/ワーカーの割り当ての原則を述べている", () => {
    expect(DEFAULT_MODEL_GUIDE).toContain("高位モデルには高位の仕事");
    expect(DEFAULT_MODEL_GUIDE).toContain("ワーカー仕事");
  });

  it("内蔵デフォルトは model 未指定時の既定の挙動を述べている", () => {
    expect(DEFAULT_MODEL_GUIDE).toContain("model未指定");
  });
});
