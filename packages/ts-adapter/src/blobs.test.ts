import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { BlobNotFoundError, fetchBlobText, parseSha256Ref } from "./blobs.js";

describe("fetchBlobText", () => {
  it("reads UTF-8 text for a valid sha256: ref", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-blob-"));
    const hex = "a".repeat(64);
    const ref = `sha256:${hex}`;
    const cache = join(dir, ".cache", "blobs");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, hex), "hello-世界", "utf8");
    const t = await fetchBlobText(ref, dir);
    expect(t).toBe("hello-世界");
    expect(parseSha256Ref(ref)).toBe(hex);
  });

  it("throws BlobNotFoundError with [blob_unavailable] prefix when file missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-blob-"));
    const ref = `sha256:${"b".repeat(64)}`;
    await expect(fetchBlobText(ref, dir)).rejects.toMatchObject({
      name: "BlobNotFoundError",
    });
    try {
      await fetchBlobText(ref, dir);
    } catch (e) {
      expect(e).toBeInstanceOf(BlobNotFoundError);
      expect(String((e as Error).message)).toContain("[blob_unavailable]");
    }
  });
});
