// ジョブのJSONL出力(claude stream-json / codex --json)から、
// 人間が読める進捗要約を作る。job_statusのprogress欄で
// オーケストレータがユーザーに途中経過を共有するために使う。

const MAX_SNIPPET = 120;

function trunc(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_SNIPPET ? `${t.slice(0, MAX_SNIPPET)}…` : t;
}

// 1イベント(JSON行)を1行の要約に変換する。要約できない行はnull。
function describeEvent(obj: Record<string, unknown>): string | null {
  if (typeof obj.result === "string") return `result: ${trunc(obj.result)}`;

  // claude stream-json: {"type":"assistant","message":{"content":[...]}}
  const message = obj.message as
    | { content?: Array<Record<string, unknown>> }
    | undefined;
  if (obj.type === "assistant" && Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        return `assistant: ${trunc(block.text)}`;
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        return `tool: ${block.name}`;
      }
    }
    return null;
  }

  // codex --json: {"type":"item.completed","item":{...}}
  const item = obj.item as Record<string, unknown> | undefined;
  if (item) {
    if (typeof item.command === "string") return `exec: ${trunc(item.command)}`;
    if (typeof item.text === "string") return `codex: ${trunc(item.text)}`;
  }

  return null;
}

export function summarizeProgress(log: string, limit = 5): string[] {
  const summaries: string[] = [];
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const desc = describeEvent(JSON.parse(line));
      if (desc) summaries.push(desc);
    } catch {
      // JSONでない行は無視
    }
  }
  return summaries.slice(-limit);
}
