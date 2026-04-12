import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { abHarnessPackageRoot } from "./paths.js";

const FIXTURE_DIR = "fixtures";
const AGENT_SUBDIR = "__agent_ir_ab__";

/** Overwrite `<cloneRoot>/__agent_ir_ab__/*.ts` from `packages/ab-harness/fixtures/`. */
export async function refreshAbFixtures(cloneRoot: string): Promise<string> {
  const pkg = abHarnessPackageRoot();
  const srcDir = join(pkg, FIXTURE_DIR);
  const destRoot = join(cloneRoot, AGENT_SUBDIR);
  await mkdir(destRoot, { recursive: true });
  const names = await readdir(srcDir);
  for (const n of names) {
    if (!n.endsWith(".ts")) {
      continue;
    }
    await copyFile(join(srcDir, n), join(destRoot, n));
  }
  return destRoot;
}
