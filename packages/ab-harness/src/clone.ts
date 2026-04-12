import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";

function repoDirName(repoUrl: string): string {
  const base = basename(repoUrl.replace(/\.git$/i, ""));
  return base || "repo";
}

/**
 * Shallow-fetch a single commit into `.cache/ab-target/<name>/`.
 */
export async function ensureClonedCommit(input: {
  repoUrl: string;
  rev: string;
  cacheDir: string;
}): Promise<string> {
  const name = repoDirName(input.repoUrl);
  const dest = join(input.cacheDir, name);
  await mkdir(input.cacheDir, { recursive: true });

  if (existsSync(join(dest, ".git"))) {
    const head = execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head === input.rev) {
      return dest;
    }
    await rm(dest, { recursive: true, force: true });
  }

  await mkdir(dest, { recursive: true });
  execFileSync("git", ["-C", dest, "init"], { stdio: "inherit" });
  execFileSync("git", ["-C", dest, "remote", "add", "origin", input.repoUrl], { stdio: "inherit" });
  execFileSync("git", ["-C", dest, "fetch", "--depth", "1", "origin", input.rev], { stdio: "inherit" });
  execFileSync("git", ["-C", dest, "checkout", "FETCH_HEAD"], { stdio: "inherit" });

  const head = execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== input.rev) {
    throw new Error(`clone/checkout failed: expected ${input.rev}, got ${head}`);
  }

  return dest;
}
