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
  category: 'UTILITY' | 'AUTHENTICATION' | 'MARKETING';
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
  // plan_ended_notice / plan_paused_notice replace subscription_expired/_suspended,
  // which Meta re-categorised as MARKETING ("Reply renew" read as a sales prompt;
  // 2026-10-08). Plain account-status wording keeps them Utility. A deleted name is
  // locked for 30 days and an approved category can't be changed, hence new names.
  {
    name: 'plan_ended_notice',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Account update: the billing period for your HisabKitab {{1}} plan has ended. Your account stays open during the grace period and your records are kept. Reply here for your account details.',
        example: { body_text: [['Pro']] },
      },
    ],
  },
  {
    name: 'plan_paused_notice',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Account update: your HisabKitab {{1}} plan is paused because the latest payment was not received. Your records are kept and nothing has been deleted. Reply here for your account details.',
        example: { body_text: [['Pro']] },
      },
    ],
  },
  // ---- team, payments, signup (proactive sends that happen OUTSIDE the 24h window) ----
  // The invitee has never messaged us, so a free-form "you were invited" would be
  // rejected by Meta (131047). Only a template can reach them.
  {
    name: 'team_invite',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Namaste! {{1}} has invited you to their HisabKitab books as {{2}}. Reply JOIN to accept. If you were not expecting this, you can ignore this message.',
        example: { body_text: [['Karki Hardware', 'accountant']] },
      },
    ],
  },
  // Payment link with a URL button. The button points at OUR redirect
  // (/payments/go/<pidx>), never at Khalti directly, so the same approved template
  // works for sandbox and production Khalti without re-approval.
  {
    name: 'payment_link',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your HisabKitab {{1}} plan payment of Rs {{2}} is ready. Tap the button below to pay securely with Khalti. Your plan activates as soon as the payment is confirmed.',
        example: { body_text: [['Pro', '4,999.00']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          {
            type: 'URL',
            text: 'Pay with Khalti',
            url: 'https://api.hisabkitab.pro/payments/go/{{1}}',
            example: ['https://api.hisabkitab.pro/payments/go/HT6o6PEZRWFJ5ygavzHWd5'],
          },
        ],
      },
    ],
  },
  // Receipt, queued in the same transaction that settles the Khalti payment (outbox).
  {
    name: 'payment_received',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Payment received: Rs {{1}} for your HisabKitab {{2}} plan (Khalti transaction {{3}}). Your plan is active until {{4}}. Thank you!',
        example: { body_text: [['4,999.00', 'Pro', 'GFq9PFS7b2iYvL8Lir9oXe', '2026-11-05']] },
      },
    ],
  },
  // Operator alert: a business just signed up on the website. Three wordings that
  // carried the owner's name + number were rejected INCORRECT_CATEGORY; this one
  // reports only the update to the operator's own HisabKitab admin account.
  {
    name: 'admin_account_update',
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text: 'Your HisabKitab admin account has a new signup request from {{1}}. Open the admin panel to review it.',
        example: { body_text: [['Karki Hardware']] },
      },
    ],
  },
];

/** Every template the running product sends. The admin panel checks each is APPROVED. */
export const REQUIRED_TEMPLATES: readonly string[] = TEMPLATES.map((t) => t.name);

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
