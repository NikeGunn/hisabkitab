/**
 * Live Meta Graph checks for the admin overview + the two account actions the
 * operator needs after swapping the WhatsApp number: subscribe the app to the
 * new account's webhooks, and submit any missing templates to it. Read paths
 * never throw — a Graph error is shown as BLOCKED, not hidden.
 */
import { REQUIRED_TEMPLATES, TEMPLATES, submitTemplates } from '../whatsapp/templates.js';

export interface MetaCreds {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  appId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const GRAPH = 'v23.0';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Graph JSON; every field is read defensively
type GraphJson = any;

async function graph(c: MetaCreds, path: string, init: RequestInit = {}): Promise<{ ok: boolean; body: GraphJson }> {
  const base = (c.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const res = await (c.fetchImpl ?? fetch)(`${base}/${GRAPH}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, body };
}

export interface MetaStatus {
  phone?: {
    display: string;
    name: string;
    status: string;
    quality: string;
    tier: string;
    nameStatus: string;
  };
  phoneError?: string;
  templates: { name: string; status: string; category?: string; reason?: string }[];
  templatesError?: string;
  appSubscribed?: boolean;
}

export async function metaStatus(c: MetaCreds): Promise<MetaStatus> {
  const out: MetaStatus = { templates: [] };
  try {
    const p = await graph(
      c,
      `/${c.phoneNumberId}?fields=display_phone_number,verified_name,status,quality_rating,messaging_limit_tier,name_status`,
    );
    if (p.ok) {
      out.phone = {
        display: p.body.display_phone_number ?? '',
        name: p.body.verified_name ?? '',
        status: p.body.status ?? '',
        quality: p.body.quality_rating ?? '',
        tier: p.body.messaging_limit_tier ?? '',
        nameStatus: p.body.name_status ?? '',
      };
    } else out.phoneError = p.body?.error?.message ?? 'lookup failed';
  } catch (err) {
    out.phoneError = String(err);
  }
  try {
    const t = await graph(c, `/${c.businessAccountId}/message_templates?fields=name,status,category,rejected_reason&limit=250`);
    if (t.ok) {
      const byName = new Map<string, { status: string; category?: string; reason?: string }>();
      for (const row of t.body.data ?? []) {
        // several languages/versions may exist; APPROVED wins
        const prev = byName.get(row.name);
        if (!prev || row.status === 'APPROVED') {
          byName.set(row.name, {
            status: row.status,
            ...(row.category ? { category: row.category } : {}),
            ...(row.rejected_reason && row.rejected_reason !== 'NONE' ? { reason: row.rejected_reason } : {}),
          });
        }
      }
      out.templates = REQUIRED_TEMPLATES.map((name) => ({ name, ...(byName.get(name) ?? { status: 'MISSING' }) }));
    } else out.templatesError = t.body?.error?.message ?? 'lookup failed';
  } catch (err) {
    out.templatesError = String(err);
  }
  if (c.appId) {
    try {
      const s = await graph(c, `/${c.businessAccountId}/subscribed_apps`);
      if (s.ok) {
        out.appSubscribed = (s.body.data ?? []).some(
          (a: { whatsapp_business_api_data?: { id?: string } }) => a.whatsapp_business_api_data?.id === c.appId,
        );
      }
    } catch {
      /* shown as unknown */
    }
  }
  return out;
}

/** Subscribe our app to the business account's webhooks (idempotent on Meta's side). */
export async function subscribeApp(c: MetaCreds): Promise<{ ok: boolean; detail: string }> {
  const r = await graph(c, `/${c.businessAccountId}/subscribed_apps`, { method: 'POST' });
  return { ok: r.ok && r.body?.success === true, detail: JSON.stringify(r.body).slice(0, 300) };
}

/** Submit every required template the account does not already have (any status). */
export async function syncTemplates(c: MetaCreds): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const { appId: _skip, ...withoutApp } = c;
  const status = await metaStatus(withoutApp);
  if (status.templatesError) throw new Error(status.templatesError);
  const missing = status.templates.filter((t) => t.status === 'MISSING').map((t) => t.name);
  if (missing.length === 0) return [];
  return submitTemplates({
    businessAccountId: c.businessAccountId,
    accessToken: c.accessToken,
    only: missing.filter((n) => TEMPLATES.some((t) => t.name === n)),
    ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
    ...(c.fetchImpl ? { fetchImpl: c.fetchImpl } : {}),
  });
}
