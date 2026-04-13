import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_IR_MANIFEST_FILE,
  ManifestParseError,
  readAgentIrManifest,
  resolveManifestUrl,
} from "./manifest.js";

describe("manifest discovery (Task 10)", () => {
  it("resolveManifestUrl returns null when manifest file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    await expect(resolveManifestUrl(dir)).resolves.toBeNull();
  });

  it("resolveManifestUrl returns file URL when agent-ir.manifest.json exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    const abs = join(dir, AGENT_IR_MANIFEST_FILE);
    await writeFile(abs, "{}\n", "utf8");
    const url = await resolveManifestUrl(dir);
    expect(url).toBe(pathToFileURL(abs).href);
  });

  it("readAgentIrManifest returns {} when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    await expect(readAgentIrManifest(dir)).resolves.toEqual({});
  });

  it("readAgentIrManifest parses JSON object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    await writeFile(join(dir, AGENT_IR_MANIFEST_FILE), `{"x":1}\n`, "utf8");
    await expect(readAgentIrManifest(dir)).resolves.toEqual({ x: 1 });
  });

  it("readAgentIrManifest returns {} on invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    await writeFile(join(dir, AGENT_IR_MANIFEST_FILE), "not json\n", "utf8");
    await expect(readAgentIrManifest(dir)).resolves.toEqual({});
  });

  it("readAgentIrManifest strict: invalid JSON throws ManifestParseError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    const abs = join(dir, AGENT_IR_MANIFEST_FILE);
    await writeFile(abs, "{ not valid }\n", "utf8");
    await expect(readAgentIrManifest(dir, { strict: true })).rejects.toMatchObject({
      name: "ManifestParseError",
      reason: "invalid_json",
      manifestPath: abs,
    });
  });

  it("readAgentIrManifest strict: non-object root throws ManifestParseError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    const abs = join(dir, AGENT_IR_MANIFEST_FILE);
    await writeFile(abs, "[1,2,3]\n", "utf8");
    await expect(readAgentIrManifest(dir, { strict: true })).rejects.toMatchObject({
      name: "ManifestParseError",
      reason: "non_object_root",
      manifestPath: abs,
    });
  });

  it("readAgentIrManifest strict: missing file returns {}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    await expect(readAgentIrManifest(dir, { strict: true })).resolves.toEqual({});
  });

  it("ManifestParseError extends Error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent86-manifest-"));
    await writeFile(join(dir, AGENT_IR_MANIFEST_FILE), "x", "utf8");
    await expect(readAgentIrManifest(dir, { strict: true })).rejects.toBeInstanceOf(ManifestParseError);
  });
});
