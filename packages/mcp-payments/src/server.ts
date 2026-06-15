/**
 * Build a Payments MCP server bound to ONE tenant (one session = one tenant).
 * tenantId comes from verified signed session metadata in the transport layer
 * (src/http.ts) or directly in tests — NEVER from tool arguments.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertCan } from '@hisab/shared';
import { createToolHandlers, inputSchemas, toolDescriptions, TOOL_CAPABILITY, type PaymentsToolContext } from './tools.js';

export function buildPaymentsServer(ctx: PaymentsToolContext): McpServer {
  const server = new McpServer({ name: 'hisab-payments', version: '0.1.0' });
  const handlers = createToolHandlers(ctx);

  for (const name of Object.keys(inputSchemas) as Array<keyof typeof inputSchemas>) {
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: inputSchemas[name] },
      async (rawArgs: unknown) => {
        try {
          // Server-side RBAC gate (PRD v2.0 §3): money/billing actions are
          // owner-only. Role comes from the signed session, never the args.
          assertCan(ctx.role, TOOL_CAPABILITY[name]);
          const args = z.object(inputSchemas[name]).parse(rawArgs ?? {});
          const result = await (handlers[name] as (a: unknown) => Promise<unknown>)(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    );
  }
  return server;
}
