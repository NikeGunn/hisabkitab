/**
 * The three Utility templates (PRD v1.0 §12.2) — submit for Meta approval EARLY
 * (long lead time). Never marketing; defined-purpose finance assistant only.
 *
 *   pnpm --filter @hisab/orchestrator templates:submit
 *
 * Needs WA_BUSINESS_ACCOUNT_ID + WA_ACCESS_TOKEN. Submission is idempotent-ish:
 * an already-submitted name returns a Graph error we report and continue past.
 */

import { pathToFileURL } from 'node:url';

export interface TemplateDefinition {
  name: string;
  category: 'UTILITY' | 'AUTHENTICATION';
  language: string;
  components: unknown[];
}

export const TEMPLATES: TemplateDefinition[] = [
  {
    name: 'vat_due_soon',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Namaste! Your VAT return for {{1}} is due on {{2}}. Reply here to review the numbers before you file.',
        example: { body_text: [['Shrawan 2082', '25 Bhadra']] },
      },
    ],
  },
  {
    name: 'return_prepared',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your {{1}} VAT return is ready: net payable Rs {{2}}. Reply "show" to review it before filing.',
        example: { body_text: [['Shrawan 2082', '12,340.00']] },
      },
    ],
  },
  {
    name: 'tds_due_soon',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Reminder: TDS withheld for {{1}} (Rs {{2}}) must be deposited via eTDS by {{3}}. Reply here to review before you deposit.',
        example: { body_text: [['Shrawan 2082', '150.00', '25 Bhadra']] },
      },
    ],
  },
  {
    name: 'deadline_digest',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your HisabKitab calendar for {{1}}: {{2}} item(s) coming up. {{3}} Reply here for details.',
        example: {
          body_text: [
            [
              'Bhadra 2082',
              '3',
              'VAT return in 5d; TDS deposit in 5d; Invoice due: Sharma Traders in 9d',
            ],
          ],
        },
      },
    ],
  },
  // `pairing_code` — AUTHENTICATION category (Meta REJECTED the old UTILITY one with
  // INCORRECT_CATEGORY; an auth/one-time-code template MUST be AUTHENTICATION). The
  // body copy is FIXED by Meta ("<CODE> is your verification code."); we only opt into
  // the security disclaimer + expiry line and supply the COPY_CODE OTP button. Used to
  // deliver the onboarding code proactively (outside the 24h service window). Re-create
  // requires deleting the rejected version first — `templates:resubmit` does that.
  {
    name: 'pairing_code',
    category: 'AUTHENTICATION',
    language: 'en',
    components: [
      {
        type: 'BODY',
        add_security_recommendation: true,
      },
      {
        type: 'FOOTER',
        code_expiration_minutes: 15,
      },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }],
      },
    ],
  },
  // ---- P10 billing dunning (subscription renewal nudges) ----
  {
    name: 'subscription_due_soon',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your HisabKitab {{1}} plan renews on {{2}} (Rs {{3}}/month). Reply "renew" to keep it active.',
        example: { body_text: [['Pro', '30 Asar', '4,999']] },
      },
    ],
  },
  {
    name: 'subscription_expired',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your HisabKitab {{1}} plan has ended. You still have access for a few more days. Reply "renew" to continue. Your data is safe.',
        example: { body_text: [['Pro']] },
      },
    ],
  },
  {
    name: 'subscription_suspended',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your HisabKitab {{1}} plan is paused for non-payment. Your data is retained. Reply "renew" anytime to reactivate.',
        example: { body_text: [['Pro']] },
      },
    ],
  },
];

/**
 * Delete a template by NAME (removes ALL language/version rows for that name).
 * Required before re-creating a name that has a REJECTED version under a different
 * category (Meta keys templates by name+language and will not silently re-categorise).
 */
export async function deleteTemplateByName(opts: {
  businessAccountId: string;
  accessToken: string;
  name: string;
  graphVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; detail: string }> {
  const base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const version = opts.graphVersion ?? 'v23.0';
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${base}/${version}/${opts.businessAccountId}/message_templates?name=${encodeURIComponent(opts.name)}`;
  const res = await doFetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${opts.accessToken}` },
  });
  return { ok: res.ok, detail: (await res.text()).slice(0, 300) };
}

export async function submitTemplates(opts: {
  businessAccountId: string;
  accessToken: string;
  graphVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Submit only this subset of template names (default: all). */
  only?: string[];
}): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
  const version = opts.graphVersion ?? 'v23.0';
  const doFetch = opts.fetchImpl ?? fetch;
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const wanted = opts.only ? TEMPLATES.filter((t) => opts.only!.includes(t.name)) : TEMPLATES;
  for (const tpl of wanted) {
    const res = await doFetch(`${base}/${version}/${opts.businessAccountId}/message_templates`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(tpl),
    });
    const detail = (await res.text()).slice(0, 300);
    results.push({ name: tpl.name, ok: res.ok, detail });
  }
  return results;
}

// Use pathToFileURL for the is-direct-run check (CLAUDE.md §4a): the old hand-built
// `file:///${path}` produced four slashes on Linux, so a container entrypoint silently
// never ran. Never reintroduce that pattern.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const businessAccountId = process.env['WA_BUSINESS_ACCOUNT_ID'];
  const accessToken = process.env['WA_ACCESS_TOKEN'];
  if (!businessAccountId || !accessToken) {
    console.error('WA_BUSINESS_ACCOUNT_ID and WA_ACCESS_TOKEN are required');
    process.exit(1);
  }
  // Usage:
  //   templates.ts                       → submit all (already-approved ones error harmlessly)
  //   templates.ts resubmit <name>       → DELETE the existing (e.g. rejected) version, then
  //                                         submit it fresh (used to flip pairing_code to AUTH)
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'resubmit') {
    if (!name) {
      console.error('usage: templates.ts resubmit <template_name>');
      process.exit(1);
    }
    const del = await deleteTemplateByName({ businessAccountId, accessToken, name });
    console.log(`${del.ok ? 'deleted' : 'delete-skip'}  ${name}  ${del.detail}`);
    const results = await submitTemplates({ businessAccountId, accessToken, only: [name] });
    for (const r of results)
      console.log(`${r.ok ? 'submitted' : 'FAILED'}  ${r.name}  ${r.detail}`);
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }
  const results = await submitTemplates({ businessAccountId, accessToken });
  for (const r of results) console.log(`${r.ok ? 'submitted' : 'FAILED'}  ${r.name}  ${r.detail}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
