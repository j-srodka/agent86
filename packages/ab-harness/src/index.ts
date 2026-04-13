import { join } from "node:path";

import { PYTHON_STUB_GRAMMAR_DIGEST, V0_ADAPTER_FINGERPRINT } from "ts-adapter";

import { ensureClonedCommit } from "./clone.js";
import {
  writeExpandedMetrics,
  writeMetrics,
  METRICS_EXPANDED_SCHEMA_VERSION,
  METRICS_SCHEMA_VERSION,
} from "./metrics.js";
import {
  abHarnessPackageRoot,
  defaultCacheDir,
  defaultExpandedMetricsPath,
  defaultTrpcMetricsPath,
  prettierCacheDir,
  ruffCacheDir,
  trpcCacheDir,
} from "./paths.js";
import {
  readPinnedRev,
  readPinnedRevPrettier,
  readPinnedRevRuff,
  readPinnedRevTrpc,
} from "./pinned-rev.js";
import { runExpandedBenchmark } from "./run-expanded.js";
import { runTaskSuite } from "./run-tasks.js";
import { formatTrpcDemoSummary, runTrpcDemoSuite } from "./run-trpc-tasks.js";
import { BENCHMARK_SEED } from "./sample-tasks.js";

const DEFAULT_ZOD_REPO = "https://github.com/colinhacks/zod.git";
const DEFAULT_TRPC_REPO = "https://github.com/trpc/trpc.git";
const DEFAULT_PRETTIER_REPO = "https://github.com/prettier/prettier.git";
const DEFAULT_RUFF_REPO = "https://github.com/astral-sh/ruff.git";

function parseProfile(): "zod" | "trpc" | "expanded" {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const i = argv.indexOf("--profile");
  if (i >= 0 && argv[i + 1]) {
    const p = argv[i + 1];
    if (p === "trpc") {
      return "trpc";
    }
    if (p === "expanded") {
      return "expanded";
    }
  }
  if (process.env.AB_PROFILE === "trpc") {
    return "trpc";
  }
  if (process.env.AB_PROFILE === "expanded") {
    return "expanded";
  }
  return "zod";
}

export async function main(): Promise<void> {
  const profile = parseProfile();

  if (profile === "expanded") {
    const outPath = process.env.AB_METRICS_OUT ?? defaultExpandedMetricsPath();
    const outDir = abHarnessPackageRoot();
    const zodUrl = process.env.AB_ZOD_REPO_URL ?? DEFAULT_ZOD_REPO;
    const prettierUrl = process.env.AB_PRETTIER_REPO_URL ?? DEFAULT_PRETTIER_REPO;
    const ruffUrl = process.env.AB_RUFF_REPO_URL ?? DEFAULT_RUFF_REPO;
    const zodRev = process.env.AB_ZOD_REV ?? (await readPinnedRev());
    const prettierRev = process.env.AB_PRETTIER_REV ?? (await readPinnedRevPrettier());
    const ruffRev = process.env.AB_RUFF_REV ?? (await readPinnedRevRuff());

    const zodRoot =
      process.env.AB_SKIP_CLONE === "1"
        ? process.env.AB_CLONE_DIR_ZOD
        : await ensureClonedCommit({ repoUrl: zodUrl, rev: zodRev, cacheDir: defaultCacheDir() });
    const prettierRoot =
      process.env.AB_SKIP_CLONE === "1"
        ? process.env.AB_CLONE_DIR_PRETTIER
        : await ensureClonedCommit({ repoUrl: prettierUrl, rev: prettierRev, cacheDir: prettierCacheDir() });
    const ruffRoot =
      process.env.AB_SKIP_CLONE === "1"
        ? process.env.AB_CLONE_DIR_RUFF
        : await ensureClonedCommit({ repoUrl: ruffUrl, rev: ruffRev, cacheDir: ruffCacheDir() });

    if (!zodRoot || !prettierRoot || !ruffRoot) {
      throw new Error(
        "expanded profile: set AB_SKIP_CLONE=1 and AB_CLONE_DIR_ZOD, AB_CLONE_DIR_PRETTIER, AB_CLONE_DIR_RUFF for each clone root.",
      );
    }

    const { repos, human_summary } = await runExpandedBenchmark({
      outDir,
      repos: [
        { id: "zod", cloneRoot: zodRoot, url: zodUrl, rev: zodRev, language: "typescript" },
        { id: "prettier", cloneRoot: prettierRoot, url: prettierUrl, rev: prettierRev, language: "typescript" },
        { id: "ruff", cloneRoot: ruffRoot, url: ruffUrl, rev: ruffRev, language: "python_stub" },
      ],
    });

    await writeExpandedMetrics(outPath, {
      schema_version: METRICS_EXPANDED_SCHEMA_VERSION,
      adapter_fingerprint: { ...V0_ADAPTER_FINGERPRINT },
      grammar_digest: V0_ADAPTER_FINGERPRINT.grammar_digest,
      python_stub_grammar_digest: PYTHON_STUB_GRAMMAR_DIGEST,
      seed: BENCHMARK_SEED,
      repos,
      human_summary,
    });
    console.log(human_summary);
    console.log(`ab-harness: wrote ${outPath}`);
    return;
  }

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
