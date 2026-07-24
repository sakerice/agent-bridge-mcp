import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Readers and the detached runner access job files concurrently.  Write via a
// sibling temporary file so readers never observe a partially-written JSON
// document.  0600 is intentional: prompts and model output may be sensitive.
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
