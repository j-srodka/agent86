import path from "node:path";

import { JS_ADAPTER_FINGERPRINT } from "@agent86/js-adapter";
import { PY_ADAPTER_FINGERPRINT } from "@agent86/py-adapter";
import { V0_ADAPTER_FINGERPRINT } from "ts-adapter";

/**
 * Static linkage: reference adapters are part of the MCP server binary for mixed routing.
 */
void [V0_ADAPTER_FINGERPRINT.name, PY_ADAPTER_FINGERPRINT.name, JS_ADAPTER_FINGERPRINT.name];

export type SupportedLanguage = "ts" | "py" | "js";

/**
 * Routes by filename extension only (POSIX semantics after normalizing `\` to `/`).
 * `.tsx` is not routed here (handled as skipped paths on the ts materialization leg).
 */
export function languageForPath(filePath: string): SupportedLanguage | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith(".tsx")) return null;
  if (normalized.endsWith(".ts")) return "ts";
  if (normalized.endsWith(".py")) return "py";
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) {
    return "js";
  }
  return null;
}

export class McpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly evidence?: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export function assertSupportedLanguage(filePath: string): SupportedLanguage {
  const lang = languageForPath(filePath);
  if (lang === null) {
    const posix = filePath.replace(/\\/g, "/");
    const ext = path.posix.extname(posix) || "(no extension)";
    throw new McpError(
      "lang.agent86.unsupported_file_extension",
      `Unsupported source extension ${ext}; supported: .ts, .py, .js, .mjs, .cjs`,
      {
        file_path: filePath,
        extension: ext,
        supported_extensions: [".ts", ".py", ".js", ".mjs", ".cjs"],
      },
    );
  }
  return lang;
}
