/**
 * Convert our LangChain `tool()`-wrapped tools (Zod schemas) into the format
 * `@anthropic-ai/sdk` expects for the multimodal bypass runner.
 *
 * Anthropic format: { name, description, input_schema: JSONSchema }
 *
 * We piggy-back on `@langchain/core/utils/json_schema:toJsonSchema` — the
 * exact same converter `@langchain/anthropic` uses internally — so the schema
 * shape is identical to what the existing langgraph flow sends. This keeps
 * tool behaviour consistent across both paths.
 */

import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { StructuredToolInterface } from '@langchain/core/tools';

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function toAnthropicToolSpec(tool: StructuredToolInterface): AnthropicToolSpec {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: toJsonSchema(tool.schema as never) as Record<string, unknown>,
  };
}

export function toAnthropicToolSpecs(tools: StructuredToolInterface[]): AnthropicToolSpec[] {
  return tools.map(toAnthropicToolSpec);
}

/**
 * Find a tool by name in our flat registry. Used by the bypass runner to
 * dispatch tool_use blocks back to the same implementations LangGraph uses,
 * so behaviour (auth, logging, locking) stays identical across both paths.
 */
export function findToolByName(
  tools: StructuredToolInterface[],
  name: string,
): StructuredToolInterface | undefined {
  return tools.find((t) => t.name === name);
}
