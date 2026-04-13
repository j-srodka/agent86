import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Monorepo root (…/agent86), derived from this package’s `dist/` layout. */
export function workspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

export function abHarnessPackageRoot(): string {
  return join(workspaceRoot(), "packages", "ab-harness");
}

export function defaultCacheDir(): string {
  return join(workspaceRoot(), ".cache", "ab-target");
}

/** tRPC demo profile clone directory (see `.pinned-rev-trpc`). */
export function trpcCacheDir(): string {
  return join(workspaceRoot(), ".cache", "ab-trpc");
}

/** Prettier OSS clone for expanded benchmark (`prettier/prettier` under this dir). */
export function prettierCacheDir(): string {
  return join(workspaceRoot(), ".cache", "ab-prettier");
}

/** Ruff OSS clone for expanded benchmark (`ruff/ruff` under this dir). */
export function ruffCacheDir(): string {
  return join(workspaceRoot(), ".cache", "ab-ruff");
}

export function defaultTrpcMetricsPath(): string {
  return join(abHarnessPackageRoot(), "ab-metrics-trpc.json");
}

export function defaultExpandedMetricsPath(): string {
  return join(abHarnessPackageRoot(), "ab-metrics-expanded.json");
}
