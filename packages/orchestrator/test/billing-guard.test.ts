/**
 * Billing guard: never send a template Meta has re-categorised as MARKETING, and
 * never let template WORDING drift toward marketing in the first place.
 * Fixtures: live category maps from a stubbed Graph. Invariants: a MARKETING
 * template is never POSTed to /messages; declared categories are never MARKETING.
 */
import { describe, expect, it } from 'vitest';
import {
  TemplateBillingBlocked,
  TemplateCategoryGuard,
  graphCategoryFetcher,
  templateSendVerdict,
} from '../src/whatsapp/category-guard.js';
import { TEMPLATES } from '../src/whatsapp/templates.js';
import { WaClient } from '../src/whatsapp/wa-client.js';

// Wording Meta read as marketing (2026-10-08: "Reply renew to keep it active").
const SALESY =
  /\b(renew|renewal offer|upgrade|offer|discount|deal|sale|limited time|hurry|don'?t miss|keep it active|buy|special|exclusive|free trial|subscribe now|act now)\b/i;

const live = (entries: Record<string, string>) => async () => new Map(Object.entries(entries));

describe('templateSendVerdict (pure)', () => {
  it('PASS for utility/authentication, FAIL for marketing, BLOCKED when unknown', () => {
    expect(templateSendVerdict('UTILITY')).toBe('PASS');
    expect(templateSendVerdict('AUTHENTICATION')).toBe('PASS');
    expect(templateSendVerdict('MARKETING')).toBe('FAIL');
    expect(templateSendVerdict(undefined)).toBe('BLOCKED');
  });
});

describe('TemplateCategoryGuard', () => {
  it('lets a utility template through', async () => {
    const g = new TemplateCategoryGuard({ fetchCategories: live({ vat_due_soon: 'UTILITY' }) });
    await expect(g.assertSendable('vat_due_soon')).resolves.toBe('PASS');
  });

  it('PROBE: refuses a template Meta re-categorised as MARKETING and alerts', async () => {
    const blocked: string[] = [];
    const g = new TemplateCategoryGuard({
      fetchCategories: live({ plan_renewal_notice: 'MARKETING' }),
      onBlocked: (n) => blocked.push(n),
    });
    await expect(g.assertSendable('plan_renewal_notice')).rejects.toBeInstanceOf(TemplateBillingBlocked);
    expect(blocked).toEqual(['plan_renewal_notice']);
  });

  it('BLOCKED (Meta unreachable, nothing known yet) still sends on the declared category', async () => {
    const errors: unknown[] = [];
    const g = new TemplateCategoryGuard({
      fetchCategories: async () => {
        throw new Error('graph down');
      },
      onLookupError: (e) => errors.push(e),
    });
    await expect(g.assertSendable('pairing_code')).resolves.toBe('BLOCKED');
    expect(errors).toHaveLength(1);
  });

  it('PROBE: a template once seen as MARKETING stays refused through a Meta outage', async () => {
    let t = 0;
    let down = false;
    const g = new TemplateCategoryGuard({
      now: () => t,
      ttlMs: 1000,
      fetchCategories: async () => {
        if (down) throw new Error('graph down');
        return new Map([['plan_ended_notice', 'MARKETING']]);
      },
    });
    await expect(g.assertSendable('plan_ended_notice')).rejects.toBeInstanceOf(TemplateBillingBlocked);
    down = true;
    t = 5000; // cache expired, refresh fails
    await expect(g.assertSendable('plan_ended_notice')).rejects.toBeInstanceOf(TemplateBillingBlocked);
  });

  it('PROBE: a failed lookup is not retried on every send (backs off)', async () => {
    let t = 0;
    let calls = 0;
    const g = new TemplateCategoryGuard({
      now: () => t,
      retryAfterMs: 60_000,
      fetchCategories: async () => {
        calls += 1;
        throw new Error('graph down');
      },
    });
    for (let i = 0; i < 5; i++) await g.assertSendable('vat_due_soon');
    expect(calls).toBe(1);
    t = 61_000;
    await g.assertSendable('vat_due_soon');
    expect(calls).toBe(2);
  });

  it('caches within the TTL and shares one in-flight lookup', async () => {
    let calls = 0;
    const g = new TemplateCategoryGuard({
      fetchCategories: async () => {
        calls += 1;
        return new Map([['vat_due_soon', 'UTILITY']]);
      },
    });
    await Promise.all([g.assertSendable('vat_due_soon'), g.assertSendable('vat_due_soon')]);
    await g.assertSendable('vat_due_soon');
    expect(calls).toBe(1);
  });

  it('PROBE: switching the WhatsApp account drops the old account\'s categories immediately', async () => {
    let account = 'old';
    const g = new TemplateCategoryGuard({
      scope: () => account,
      ttlMs: 60 * 60_000,
      fetchCategories: async () =>
        new Map([['vat_due_soon', account === 'old' ? 'UTILITY' : 'MARKETING']]),
    });
    await expect(g.assertSendable('vat_due_soon')).resolves.toBe('PASS');
    account = 'new'; // within the TTL, but a different account
    await expect(g.assertSendable('vat_due_soon')).rejects.toBeInstanceOf(TemplateBillingBlocked);
  });
});

describe('graphCategoryFetcher', () => {
  it('maps name → category, preferring the APPROVED version', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { name: 'a', category: 'MARKETING', status: 'APPROVED' },
            { name: 'a', category: 'UTILITY', status: 'REJECTED' },
            { name: 'b', category: 'UTILITY', status: 'PENDING' },
          ],
        }),
      )) as unknown as typeof fetch;
    const map = await graphCategoryFetcher({ creds: () => ({ accessToken: 't', businessAccountId: 'w' }), fetchImpl })();
    expect(map.get('a')).toBe('MARKETING');
    expect(map.get('b')).toBe('UTILITY');
  });

  it('throws on a Graph error (the guard then keeps the last known map)', async () => {
    const fetchImpl = (async () => new Response('{"error":{}}', { status: 500 })) as unknown as typeof fetch;
    const f = graphCategoryFetcher({ creds: () => ({ accessToken: 't', businessAccountId: 'w' }), fetchImpl });
    await expect(f()).rejects.toThrow(/500/);
  });
});

describe('WaClient + guard', () => {
  it('PROBE: a MARKETING template is never POSTed to Meta', async () => {
    const posted: string[] = [];
    const fetchImpl = (async (url: string) => {
      posted.push(String(url));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }));
    }) as unknown as typeof fetch;
    const guard = new TemplateCategoryGuard({ fetchCategories: live({ plan_paused_notice: 'MARKETING', vat_due_soon: 'UTILITY' }) });
    const wa = new WaClient({ phoneNumberId: 'p', accessToken: 't', fetchImpl, templateGuard: guard, retryAttempts: 1 });

    await expect(wa.sendTemplate('+9779800000000', 'plan_paused_notice', ['Pro'])).rejects.toBeInstanceOf(TemplateBillingBlocked);
    expect(posted).toHaveLength(0);

    await wa.sendTemplate('+9779800000000', 'vat_due_soon', ['Ashwin 2082', '25 Kartik']);
    expect(posted).toHaveLength(1);
  });
});

// Wording lint: keep every template a plain account notice so Meta has no reason
// to re-categorise it. These rules are what Meta actually objected to.
describe('template wording (pre-submission lint)', () => {
  const bodies = TEMPLATES.flatMap((t) =>
    (t.components as { type: string; text?: string }[])
      .filter((c) => c.type === 'BODY' && typeof c.text === 'string')
      .map((c) => ({ name: t.name, text: c.text! })),
  );

  it('no template is declared MARKETING', () => {
    for (const t of TEMPLATES) expect(t.category, t.name).not.toBe('MARKETING');
  });

  it('PROBE: sales nudges are caught (the lint itself works)', () => {
    expect(SALESY.test('Reply "renew" to keep it active.')).toBe(true);
    expect(SALESY.test('Upgrade now for a special offer!')).toBe(true);
    expect(SALESY.test('Account update: your plan is paused.')).toBe(false);
  });

  it('no body uses sales-nudge wording', () => {
    for (const b of bodies) expect(SALESY.test(b.text), `${b.name}: ${b.text}`).toBe(false);
  });

  it('no {{variable}} at the very start or end of a body (Meta rejects it)', () => {
    for (const b of bodies) {
      expect(/^\s*\{\{/.test(b.text), b.name).toBe(false);
      expect(/\}\}[\s.!?]*$/.test(b.text), b.name).toBe(false);
    }
  });
});
