import * as fs from "node:fs";
import * as path from "node:path";

// ジョブが生成したメディア成果物の検出とプレビュー読み出し。
// 「途中プレビュー」を可能にするため、検出は実行中ジョブに対しても行える
// (cwd配下でジョブ開始以降に更新されたメディアファイルを拾う)。

export interface ArtifactInfo {
  path: string;
  bytes: number;
  modified_at: string;
}

const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp4", ".mov", ".webm",
  ".mp3", ".wav", ".m4a",
  ".pdf",
]);

const INLINE_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const MAX_INLINE_BYTES = 3 * 1024 * 1024;
const MAX_ARTIFACTS = 20;
const MAX_VISITED = 10_000;
const MAX_DEPTH = 8;

export function scanArtifacts(cwd: string, sinceMs: number): ArtifactInfo[] {
  const found: ArtifactInfo[] = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_ARTIFACTS || ++visited > MAX_VISITED) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (!MEDIA_EXTENSIONS.has(path.extname(e.name).toLowerCase())) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      found.push({
        path: p,
        bytes: st.size,
        modified_at: st.mtime.toISOString(),
      });
    }
  };

  walk(cwd, 0);
  return found;
}

export class ArtifactAccessError extends Error {}

export type ArtifactContent =
  | {
      kind: "image";
      mimeType: string;
      base64: string;
      bytes: number;
      path: string;
    }
  | { kind: "file"; path: string; bytes: number; reason: string };

export function readArtifact(cwd: string, filePath: string): ArtifactContent {
  const resolvedCwd = fs.realpathSync(cwd);
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.join(resolvedCwd, filePath);
  let resolved: string;
  try {
    resolved = fs.realpathSync(abs);
  } catch {
    throw new ArtifactAccessError(`ファイルが見つかりません: ${filePath}`);
  }
  if (
    resolved !== resolvedCwd &&
    !resolved.startsWith(resolvedCwd + path.sep)
  ) {
    throw new ArtifactAccessError(
      `ジョブの作業ディレクトリ外のパスは読めません: ${filePath}`,
    );
  }
  const st = fs.statSync(resolved);
  if (!st.isFile()) {
    throw new ArtifactAccessError(`ファイルではありません: ${filePath}`);
  }
  const mime = INLINE_IMAGE_MIME[path.extname(resolved).toLowerCase()];
  if (!mime) {
    return {
      kind: "file",
      path: resolved,
      bytes: st.size,
      reason:
        "インライン表示は画像(png/jpg/gif/webp)のみ対応。このファイルは絶対パスを使ってユーザーに直接提示すること",
    };
  }
  if (st.size > MAX_INLINE_BYTES) {
    return {
      kind: "file",
      path: resolved,
      bytes: st.size,
      reason: `画像サイズが上限(${MAX_INLINE_BYTES}バイト)を超えるためインライン不可。絶対パスを使ってユーザーに直接提示すること`,
    };
  }
  return {
    kind: "image",
    mimeType: mime,
    base64: fs.readFileSync(resolved).toString("base64"),
    bytes: st.size,
    path: resolved,
  };
}
