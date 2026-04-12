import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { abHarnessPackageRoot } from "./paths.js";

export async function readPinnedRev(): Promise<string> {
  const p = join(abHarnessPackageRoot(), ".pinned-rev");
  const raw = await readFile(p, "utf8");
  const line = raw.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(line)) {
    throw new Error(`ab-harness: invalid commit SHA in .pinned-rev: ${line}`);
  }
  return line.toLowerCase();
}
