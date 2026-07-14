#!/usr/bin/env node
// テスト用の偽claude/codex CLI。FAKE_MODE で挙動を切り替える:
//   success (default) — claude風のJSON行を出力し、-o があればそのファイルにも書いて正常終了
//   fail  — stderrに出して exit 1
//   sleep — 60秒スリープ(タイムアウト/キャンセルのテスト用)
import * as fs from "node:fs";

const mode = process.env.FAKE_MODE ?? "success";

const oIdx = process.argv.indexOf("-o");
if (oIdx !== -1 && mode === "success") {
  fs.writeFileSync(process.argv[oIdx + 1], "fake codex done");
}

if (mode === "sleep") {
  setTimeout(() => process.exit(0), 60_000);
} else if (mode === "fail") {
  console.error("fake failure: auth expired");
  process.exit(1);
} else {
  // claudeのstream-json風: 進捗イベント + session_id付きの最終result行
  console.log(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "working on it" }] },
    }),
  );
  console.log(
    JSON.stringify({
      type: "result",
      result: "fake done",
      session_id: "fake-sess-1",
    }),
  );
  process.exit(0);
}
