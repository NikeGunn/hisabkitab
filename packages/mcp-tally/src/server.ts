/**
 * Build a Tally MCP server bound to ONE tenant (one session = one tenant), mirroring
 * the ledger server: tenantId + role come from verified signed session metadata in
 * the transport layer (src/http.ts) or directly in tests — NEVER from tool arguments.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertCan } from '@hisab/shared';
import type { Db } from '@hisab/db';
import type { TenantSession } from '@hisab/mcp-ledger';
import {
  createToolHandlers,
  inputSchemas,
  toolDescriptions,
  TOOL_CAPABILITY,
  type ToolContext,
} from './tools.js';

export interface TallyDeps {
  db: Db;
  correlationId?: string;
}

export function buildTallyServer(deps: TallyDeps, session: TenantSession): McpServer {
  const server = new McpServer({ name: 'hisab-tally', version: '0.1.0' });
  const ctx: ToolContext = {
    db: deps.db,
    tenantId: session.tenantId,
    role: session.role,
    ...(deps.correlationId ? { correlationId: deps.correlationId } : {}),
  };
  const handlers = createToolHandlers(ctx);

  for (const name of Object.keys(inputSchemas) as Array<keyof typeof inputSchemas>) {
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: inputSchemas[name] },
      async (rawArgs: unknown) => {
        try {
          // Server-side RBAC gate (PRD v2.0 §3): role from the signed session, never
          // the args — owner/accountant/viewer may ask Tally; setup/bind is owner-only.
          assertCan(session.role, TOOL_CAPABILITY[name]);
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
