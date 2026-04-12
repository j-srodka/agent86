import { join } from "node:path";

import { ensureClonedCommit } from "./clone.js";
import { writeMetrics, METRICS_SCHEMA_VERSION } from "./metrics.js";
import { defaultCacheDir } from "./paths.js";
import { readPinnedRev } from "./pinned-rev.js";
import { runTaskSuite } from "./run-tasks.js";

const DEFAULT_REPO = "https://github.com/colinhacks/zod.git";

export async function main(): Promise<void> {
  const repoUrl = process.env.TARGET_REPO_URL ?? DEFAULT_REPO;
  const rev = process.env.TARGET_REPO_REV ?? (await readPinnedRev());
  const outPath = process.env.AB_METRICS_OUT ?? join(process.cwd(), "ab-metrics.json");

  const cloneRoot =
    process.env.AB_SKIP_CLONE === "1"
      ? process.env.AB_CLONE_DIR
      : await ensureClonedCommit({ repoUrl, rev, cacheDir: defaultCacheDir() });

  if (!cloneRoot) {
    throw new Error("AB_SKIP_CLONE=1 requires AB_CLONE_DIR to point at an existing clone root.");
  }

  const { snapshotRoot, tasks } = await runTaskSuite(cloneRoot);

  await writeMetrics(outPath, {
    schema_version: METRICS_SCHEMA_VERSION,
    repo: { url: repoUrl, rev },
    snapshot_root: snapshotRoot,
    tasks,
  });

  console.log(`ab-harness: wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
