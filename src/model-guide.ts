import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// delegate_task のツール説明に埋め込むモデル選定ガイド。
// ~/.agent-bridge/model-guide.md(または AGENT_BRIDGE_MODEL_GUIDE_FILE)を
// 置くと差し替えられる。モデルのラインナップは変わるため、日付を明記しておく。
export const DEFAULT_MODEL_GUIDE = `## モデル選定ガイド(2026-09-19時点。**必ず古くなる**)

原則: 高位モデルには高位の仕事(設計判断・高難度レビュー・オーケストレーション)を、
下位モデルにはワーカー仕事(定型実装・変換・調査)を割り当てる。

### 画像を作らせるときは model を指定しない(**繰り返し起きている失敗**)

画像生成モデル(gpt-image-2 など)を model に直接指定すると失敗する:
  The 'gpt-image-2' model is not supported when using Codex with a ChatGPT account.

model は指定せず(または通常のテキストモデルを指定し)、**プロンプトで「画像を作ってほしい」と
依頼する**こと。委譲先が自分の画像生成の道具を使って描く。

SVG を書いて PNG に変換する代用は品質が低い。画像が要るならプロンプトに
「SVG やプログラムで図形を描くのは禁止。画像生成で描くこと」と明記する。

### モデル名(**古くなっている前提で扱うこと**)

- codex側: gpt-6-astra(このマシンの ~/.codex/config.toml の既定。実測) /
  gpt-5.6-sol / gpt-5.6-terra(旧ガイド記載。現存するか未確認)
- claude側: claude-fable-5-1(最上位・高コスト、複雑な設計/推論のみ) / claude-opus-5(高位) /
  claude-sonnet-5(標準ワーカー推奨) / claude-haiku-4-5(軽量・定型)
- model未指定の場合、各CLIの既定=それぞれの最高位モデルで実行される(意図的な仕様)。

実地で確かめる: cat ~/.codex/config.toml | head -5

### 使用量の上限

ChatGPT アカウントの codex には枠がある。上限に当たると即座に
「You've hit your usage limit ... try again at <時刻>」が返る。
**その時刻は当てにならない**(待って投げ直しても同じまま失敗することがある。実測)。
数回試して駄目なら深追いせず、ユーザーに報告して止めること。`;

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
