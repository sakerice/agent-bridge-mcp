import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  scanArtifacts,
  readArtifact,
  ArtifactAccessError,
  MAX_INLINE_BYTES,
} from "../src/artifacts.js";

// 1x1透過PNG
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abm-art-"));
}

describe("scanArtifacts", () => {
  it("since以降に更新されたメディアだけを検出する", () => {
    const dir = makeDir();
    const oldFile = path.join(dir, "old.png");
    fs.writeFileSync(oldFile, Buffer.from(PNG_BASE64, "base64"));
    const past = Date.now() - 60_000;
    fs.utimesSync(oldFile, new Date(past), new Date(past));

    const since = Date.now() - 5_000;
    fs.writeFileSync(path.join(dir, "new.png"), Buffer.from(PNG_BASE64, "base64"));
    fs.writeFileSync(path.join(dir, "note.txt"), "not media");

    const found = scanArtifacts(dir, since);
    const names = found.map((a) => path.basename(a.path));
    expect(names).toContain("new.png");
    expect(names).not.toContain("old.png");
    expect(names).not.toContain("note.txt");
  });

  it("サブディレクトリを再帰し、node_modulesと隠しディレクトリは除外する", () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, "sub"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.mkdirSync(path.join(dir, ".git"));
    const buf = Buffer.from(PNG_BASE64, "base64");
    fs.writeFileSync(path.join(dir, "sub", "in-sub.png"), buf);
    fs.writeFileSync(path.join(dir, "node_modules", "dep.png"), buf);
    fs.writeFileSync(path.join(dir, ".git", "hidden.png"), buf);

    const names = scanArtifacts(dir, 0).map((a) => path.basename(a.path));
    expect(names).toContain("in-sub.png");
    expect(names).not.toContain("dep.png");
    expect(names).not.toContain("hidden.png");
  });

  it("bytesとmodified_atを含む", () => {
    const dir = makeDir();
    const buf = Buffer.from(PNG_BASE64, "base64");
    fs.writeFileSync(path.join(dir, "a.png"), buf);
    const [a] = scanArtifacts(dir, 0);
    expect(a.bytes).toBe(buf.length);
    expect(new Date(a.modified_at).getTime()).toBeGreaterThan(0);
  });
});

describe("readArtifact", () => {
  it("画像はbase64+mimeTypeでインライン返却する", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "img.png"), Buffer.from(PNG_BASE64, "base64"));
    const res = readArtifact(dir, "img.png");
    expect(res.kind).toBe("image");
    if (res.kind === "image") {
      expect(res.mimeType).toBe("image/png");
      expect(res.base64).toBe(PNG_BASE64);
    }
  });

  it("インライン上限を超える画像はfile扱いで理由を返す", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "big.png"), Buffer.alloc(MAX_INLINE_BYTES + 1));
    const res = readArtifact(dir, "big.png");
    expect(res.kind).toBe("file");
    if (res.kind === "file") expect(res.reason).toContain("提示");
  });

  it("動画などの非画像メディアはfile扱いで返す", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, "movie.mp4"), Buffer.alloc(10));
    const res = readArtifact(dir, "movie.mp4");
    expect(res.kind).toBe("file");
  });

  it("cwd外のパスはArtifactAccessError", () => {
    const dir = makeDir();
    expect(() => readArtifact(dir, "../outside.png")).toThrow(ArtifactAccessError);
    expect(() => readArtifact(dir, "/etc/hosts")).toThrow(ArtifactAccessError);
  });

  it("存在しないファイルはArtifactAccessError", () => {
    const dir = makeDir();
    expect(() => readArtifact(dir, "nope.png")).toThrow(ArtifactAccessError);
  });
});
