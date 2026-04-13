import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { abHarnessPackageRoot } from "./paths.js";

async function readShaFile(filename: string): Promise<string> {
  const p = join(abHarnessPackageRoot(), filename);
  const raw = await readFile(p, "utf8");
  const line = raw.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(line)) {
    throw new Error(`ab-harness: invalid commit SHA in ${filename}: ${line}`);
  }
  return line.toLowerCase();
}

export async function readPinnedRev(): Promise<string> {
  return readShaFile(".pinned-rev");
}

export async function readPinnedRevTrpc(): Promise<string> {
  return readShaFile(".pinned-rev-trpc");
}
