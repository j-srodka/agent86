import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export function jsonToolSuccess(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function jsonToolError(payload: {
  code: string;
  message: string;
  evidence?: Record<string, unknown> | null;
}): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export function zodToToolInputError(err: z.ZodError): CallToolResult {
  return jsonToolError({
    code: "lang.agent86.invalid_tool_input",
    message: "Tool arguments failed validation.",
    evidence: { issues: err.issues },
  });
}

export function internalToolError(err: unknown): CallToolResult {
  const e = err instanceof Error ? err : new Error(String(err));
  return jsonToolError({
    code: "lang.agent86.internal_error",
    message: e.message,
    evidence: { stack: e.stack ?? null },
  });
}

export async function runToolHandler(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    return internalToolError(e);
  }
}
