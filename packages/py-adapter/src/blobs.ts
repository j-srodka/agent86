import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SHA256_REF = /^sha256:([0-9a-f]{64})$/;

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
