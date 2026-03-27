/**
 * MCP Sampling helper — wraps server.server.createMessage with graceful fallback.
 *
 * Sampling allows the server to request an LLM completion from the connected
 * client (the AI model). Not all MCP clients support sampling; this wrapper
 * returns null instead of throwing when sampling is unavailable.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface SamplingMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

/**
 * Request an LLM completion via MCP Sampling.
 * Returns the generated text, or null if the client doesn't support sampling
 * or if any error occurs.
 */
export async function sampleOrNull(
  server: McpServer,
  messages: SamplingMessage[],
  options: { maxTokens?: number; systemPrompt?: string } = {}
): Promise<string | null> {
  try {
    const result = await server.server.createMessage({
      messages,
      maxTokens: options.maxTokens ?? 256,
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    });
    const content = result?.content;
    if (content && content.type === "text") {
      return content.text ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
