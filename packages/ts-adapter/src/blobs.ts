import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SHA256_REF = /^sha256:([0-9a-f]{64})$/;

/** Absolute `<snapshotRoot>/.cache/blobs` (normative for this repo; see `docs/impl/v0-decisions.md`). */
export function getBlobCachePath(snapshotRootPath: string): string {
  return join(resolve(snapshotRootPath), ".cache", "blobs");
}

export function parseSha256Ref(blobRef: string): string {
  const m = SHA256_REF.exec(blobRef.trim());
  if (!m) {
    throw new TypeError(`[blob_unavailable] invalid blob ref (expected sha256:<64 hex>): ${blobRef}`);
  }
  return m[1]!;
}

/**
 * Thrown when a `sha256:` ref is valid but the corresponding file is missing under
 * `.cache/blobs/`. Message is machine-filterable (`[blob_unavailable]`).
 */
export class BlobNotFoundError extends Error {
  override readonly name = "BlobNotFoundError";
  readonly blob_ref: string;

  constructor(blobRef: string) {
    super(
      `[blob_unavailable] blob not in local cache — re-materialize snapshot to rebuild (ref=${blobRef})`,
    );
    this.blob_ref = blobRef;
  }
}

/**
 * Resolve a local `sha256:` ref to UTF-8 text from `<snapshotRoot>/.cache/blobs/<hex>`.
 */
export async function fetchBlobText(blobRef: string, snapshotRootPath: string): Promise<string> {
  const hex = parseSha256Ref(blobRef);
  const path = join(getBlobCachePath(snapshotRootPath), hex);
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new BlobNotFoundError(blobRef);
    }
    throw e;
  }
}
