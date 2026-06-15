/**
 * Build a Ledger MCP server bound to ONE tenant (one session = one tenant).
 * The tenantId comes from verified signed session metadata in the transport layer
 * (src/http.ts) or directly in tests — NEVER from tool arguments.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertCan, defaultTaxConfig, type TaxConfig } from '@hisab/shared';
import type { Db } from '@hisab/db';
import type { TenantSession } from './auth.js';
import { createToolHandlers, inputSchemas, toolDescriptions, TOOL_CAPABILITY, type ToolContext } from './tools.js';

export interface LedgerDeps {
  db: Db;
  cfg?: TaxConfig;
}

export function buildLedgerServer(deps: LedgerDeps, session: TenantSession): McpServer {
  const server = new McpServer({ name: 'hisab-ledger', version: '0.1.0' });
  const ctx: ToolContext = {
    db: deps.db,
    tenantId: session.tenantId,
    role: session.role,
    cfg: deps.cfg ?? defaultTaxConfig,
  };
  const handlers = createToolHandlers(ctx);

  for (const name of Object.keys(inputSchemas) as Array<keyof typeof inputSchemas>) {
    server.registerTool(
      name,
      { description: toolDescriptions[name], inputSchema: inputSchemas[name] },
      async (rawArgs: unknown) => {
        try {
          // Server-side RBAC gate (PRD v2.0 §3): the role comes from the signed
          // session, never the args — so the model cannot escalate. Deny → throw.
          assertCan(session.role, TOOL_CAPABILITY[name]);
          const args = z.object(inputSchemas[name]).parse(rawArgs ?? {});
          // each handler narrows its own args; the cast is safe because schema[name] parsed them
          const result = await (handlers[name] as (a: unknown) => Promise<unknown>)(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      },
    );
  }
  return server;
}
