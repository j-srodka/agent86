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

export function defaultTrpcMetricsPath(): string {
  return join(abHarnessPackageRoot(), "ab-metrics-trpc.json");
}
