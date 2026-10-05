/**
 * Admin "send payment link": create a Khalti subscription checkout for a business
 * through the REAL payments MCP (same tool, same exactly-once billing_payments
 * row, same price-from-config rule — the admin never types an amount), then send
 * the approved `payment_link` template whose button opens /payments/go/<pidx>.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTenantToken } from '@hisab/mcp-ledger';

export interface InitiateResult {
  ok: boolean;
  mode?: 'live' | 'development';
  pidx?: string;
  plan_name?: string;
  amount_paisa?: number;
  reason?: string;
}

export async function initiateSubscriptionLink(opts: {
  paymentsMcpUrl: string;
  signingSecret: string;
  tenantId: string;
  planCode: 'starter' | 'pro' | 'business';
}): Promise<InitiateResult> {
  const token = createTenantToken(opts.tenantId, opts.signingSecret, { role: 'owner', ttlSeconds: 120 });
  const transport = new StreamableHTTPClientTransport(new URL(opts.paymentsMcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'hisab-admin', version: '0.0.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({
      name: 'initiate_subscription',
      // The operator is acting on the owner's explicit request (onboarding call);
      // the consent flag is recorded in the audit row by the tool.
      arguments: { plan_code: opts.planCode, owner_approved: true },
    });
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '{}';
    if (res.isError) return { ok: false, reason: text };
    return JSON.parse(text) as InitiateResult;
  } finally {
    await client.close();
  }
}
