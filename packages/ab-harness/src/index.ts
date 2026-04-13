import { join } from "node:path";

import { V0_ADAPTER_FINGERPRINT } from "ts-adapter";

import { ensureClonedCommit } from "./clone.js";
import { writeMetrics, METRICS_SCHEMA_VERSION } from "./metrics.js";
import { defaultCacheDir, defaultTrpcMetricsPath, trpcCacheDir } from "./paths.js";
import { readPinnedRev, readPinnedRevTrpc } from "./pinned-rev.js";
import { runTaskSuite } from "./run-tasks.js";
import { formatTrpcDemoSummary, runTrpcDemoSuite } from "./run-trpc-tasks.js";

const DEFAULT_ZOD_REPO = "https://github.com/colinhacks/zod.git";
const DEFAULT_TRPC_REPO = "https://github.com/trpc/trpc.git";

function parseProfile(): "zod" | "trpc" {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const i = argv.indexOf("--profile");
  if (i >= 0 && argv[i + 1]) {
    return argv[i + 1] === "trpc" ? "trpc" : "zod";
  }
  return process.env.AB_PROFILE === "trpc" ? "trpc" : "zod";
}

export async function main(): Promise<void> {
  const profile = parseProfile();
  const repoUrl =
    profile === "trpc" ? (process.env.TARGET_REPO_URL ?? DEFAULT_TRPC_REPO) : (process.env.TARGET_REPO_URL ?? DEFAULT_ZOD_REPO);
  const rev =
    profile === "trpc"
      ? (process.env.TARGET_REPO_REV ?? (await readPinnedRevTrpc()))
      : (process.env.TARGET_REPO_REV ?? (await readPinnedRev()));

  const defaultOut = profile === "trpc" ? defaultTrpcMetricsPath() : join(process.cwd(), "ab-metrics.json");
  const outPath = process.env.AB_METRICS_OUT ?? defaultOut;

  const cacheDir = profile === "trpc" ? trpcCacheDir() : defaultCacheDir();

  const cloneRoot =
    process.env.AB_SKIP_CLONE === "1" ? process.env.AB_CLONE_DIR : await ensureClonedCommit({ repoUrl, rev, cacheDir });

  if (!cloneRoot) {
    throw new Error("AB_SKIP_CLONE=1 requires AB_CLONE_DIR to point at an existing clone root.");
  }

  if (profile === "trpc") {
    const { snapshotRoot, tasks } = await runTrpcDemoSuite(cloneRoot);
    const human_summary = formatTrpcDemoSummary(tasks);
    await writeMetrics(outPath, {
      schema_version: METRICS_SCHEMA_VERSION,
      adapter_fingerprint: { ...V0_ADAPTER_FINGERPRINT },
      grammar_digest: V0_ADAPTER_FINGERPRINT.grammar_digest,
      repo: { url: repoUrl, rev },
      snapshot_root: snapshotRoot,
      tasks,
      demo_run: true,
      human_summary,
    });
    console.log(human_summary);
    console.log(`ab-harness: wrote ${outPath}`);
    return;
  }

  const { snapshotRoot, tasks } = await runTaskSuite(cloneRoot);

  await writeMetrics(outPath, {
    schema_version: METRICS_SCHEMA_VERSION,
    adapter_fingerprint: { ...V0_ADAPTER_FINGERPRINT },
    grammar_digest: V0_ADAPTER_FINGERPRINT.grammar_digest,
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
