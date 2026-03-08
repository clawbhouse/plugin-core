import { TOOL_SCHEMAS } from "./tools.js";
import type { ClawbhouseToolHandlerBase } from "./tool-handler-base.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

type RegisterToolFn = (tool: {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
}) => void;

/**
 * Register all Clawbhouse tools with an OpenClaw plugin API.
 * Call this from your plugin's `register(api)` method.
 */
export function registerClawbhouseTools(
  registerTool: RegisterToolFn,
  handler: ClawbhouseToolHandlerBase,
): void {
  for (const schema of TOOL_SCHEMAS) {
    registerTool({
      name: schema.name,
      label: schema.label,
      description: schema.description,
      parameters: schema.parameters,
      async execute(_toolCallId, params) {
        const result = await handler.handle(schema.name, params ?? {});
        const parsed = JSON.parse(result);
        return {
          content: [{ type: "text" as const, text: result }],
          details: parsed,
        };
      },
    });
  }
}
