import { existsSync, mkdirSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export function filesystemErrorMessage(err: unknown, target?: string): string {
  const nodeError = err as NodeJS.ErrnoException;
  if (nodeError.code !== "ENOSPC") return nodeError.message || String(err);
  let detail = "";
  try {
    const stats = statfsSync(target ? path.dirname(target) : process.cwd());
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    detail = ` (${(freeBytes / 1024 ** 3).toFixed(2)} GiB available on the target filesystem)`;
  } catch {
    // Keep the original error if filesystem diagnostics are unavailable.
  }
  return `ENOSPC while writing${target ? ` ${target}` : ""}${detail}. This may be a filesystem quota or inode limit even when byte capacity remains.`;
}

/** Same-directory temp + rename avoids partial note contents after a process interruption. */
export function writeFileAtomic(absPath: string, content: string): void {
  const tempPath = `${absPath}.oe-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
    renameSync(tempPath, absPath);
  } catch (err) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original failure.
    }
    throw new Error(filesystemErrorMessage(err, absPath), { cause: err });
  }
}
