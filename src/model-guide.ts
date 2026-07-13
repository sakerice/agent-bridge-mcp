import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// delegate_task のツール説明に埋め込むモデル選定ガイド。
// ~/.agent-bridge/model-guide.md(または AGENT_BRIDGE_MODEL_GUIDE_FILE)を
// 置くと差し替えられる。モデルのラインナップは変わるため、日付を明記しておく。
export const DEFAULT_MODEL_GUIDE = `## モデル選定ガイド(2026-07-13時点。古い可能性あり)

原則: 高位モデルには高位の仕事(設計判断・高難度レビュー・オーケストレーション)を、
下位モデルにはワーカー仕事(定型実装・変換・調査)を割り当てる。

- claude側: claude-fable-5(最高位・高コスト、複雑な設計/推論のみ) / claude-opus-4-8(高位) /
  claude-sonnet-5(標準ワーカー推奨) / claude-haiku-4-5(軽量・定型)
- codex側: gpt-5.6-sol(高位思考、reasoning xhigh) / gpt-5.6-terra(標準ワーカー推奨) /
  gpt-image-2(画像生成はこれを指定)
- model未指定の場合、各CLIの既定=それぞれの最高位モデルで実行される(意図的な仕様)。`;

export function guideFilePath(): string {
  return (
    process.env.AGENT_BRIDGE_MODEL_GUIDE_FILE ??
    path.join(os.homedir(), ".agent-bridge", "model-guide.md")
  );
}

export function loadModelGuide(filePath: string = guideFilePath()): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return DEFAULT_MODEL_GUIDE;
  }
}
