'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { NEPAL_COMPANY } from '@/components/legal-entity';

/**
 * Catchy Khalti checkout, DEVELOPMENT mode. No key, no network call, button
 * disabled: it cannot charge. The plan picker is interactive so it feels real.
 */
const KHALTI = '#5C2D91'; // Khalti brand purple

type Plan = { code: string; name: string; priceNpr: number; blurb: string; perks: string[]; popular?: boolean };

const PLANS: Plan[] = [
  {
    code: 'starter',
    name: 'Starter',
    priceNpr: 2999,
    blurb: 'For a solo shop finding its rhythm.',
    perks: ['Log by photo or text', 'VAT reminders', 'Nil return prep', 'Just you (the owner)'],
  },
  {
    code: 'pro',
    name: 'Pro',
    priceNpr: 4999,
    blurb: 'For a growing business with credit customers.',
    perks: [
      'Everything in Starter',
      'Debtors and creditors',
      'Statements and aging',
      'Up to 3 people: add your accountant or auditor',
    ],
    popular: true,
  },
  {
    code: 'business',
    name: 'Business',
    priceNpr: 7999,
    blurb: 'For an established SMB with a bigger team.',
    perks: ['Everything in Pro', 'All PDF reports', 'Up to 10 people', 'Priority support'],
  },
];

const npr = (n: number) => `Rs ${n.toLocaleString('en-IN')}`;

/** Feature comparison. Mirrors @hisab/shared billing/features.ts (seats + accountant seat). */
type Cell = boolean | string;
const COMPARE: { label: string; cells: [Cell, Cell, Cell] }[] = [
  { label: 'Log sales and expenses by photo or text', cells: [true, true, true] },
  { label: 'VAT return prep and monthly reminders', cells: [true, true, true] },
  { label: 'TDS deposit reminders', cells: [true, true, true] },
  { label: 'Debtors and creditors, statements, aging', cells: [false, true, true] },
  { label: 'Professional PDF reports', cells: [false, false, true] },
  { label: 'People on the account (owner included)', cells: ['1', '3', '10'] },
  { label: 'Accountant who can confirm entries', cells: [false, true, true] },
  { label: 'Auditor, staff or viewer access', cells: [false, true, true] },
  { label: 'Time-limited access (7 days to 1 year)', cells: [false, true, true] },
  { label: 'Priority support', cells: [false, false, true] },
];

/** Roles. Mirrors @hisab/shared rbac/roles.ts: the server enforces exactly this. */
const ROLES: { name: string; tag: string; can: string; cannot: string }[] = [
  {
    name: 'Owner',
    tag: 'You',
    can: 'Everything: record, confirm, VAT, reports, payments and your team.',
    cannot: 'Only you can move money or change who has access.',
  },
  {
    name: 'Accountant',
    tag: 'Pro and Business',
    can: 'Record and confirm entries, prepare VAT, pull reports, check the audit trail.',
    cannot: 'Cannot move money, change billing or add people.',
  },
  {
    name: 'Auditor',
    tag: 'Read-only',
    can: 'Read every report and statement and verify the tamper-proof audit trail.',
    cannot: 'Cannot change anything: never records, confirms or edits.',
  },
  {
    name: 'Staff',
    tag: 'Drafts only',
    can: 'Send bills and record draft entries for you or your accountant to confirm.',
    cannot: 'Cannot confirm entries or see your reports.',
  },
  {
    name: 'Viewer',
    tag: 'Read-only',
    can: 'View reports and summaries, for a partner or family member.',
    cannot: 'Cannot change anything or see the audit trail.',
  },
];

const COMMANDS: [string, string][] = [
  ['add 98XXXXXXXX as accountant', 'Invite your accountant'],
  ['add 98XXXXXXXX as auditor for 30 days', 'Access that ends on its own'],
  ['change 98XXXXXXXX to viewer', 'Change what someone can do'],
  ['remove 98XXXXXXXX', 'Take access away, right away'],
  ['team', 'See everyone who has access'],
];

function Mark({ value }: { value: Cell }) {
  if (typeof value === 'string') return <span className="font-semibold text-ink">{value}</span>;
  return value ? (
    <span className="text-primary" aria-label="Included">
      ✓
    </span>
  ) : (
    <span className="text-muted" aria-label="Not included">
      ·
    </span>
  );
}

export function PayDevClient() {
  const [planCode, setPlanCode] = useState('pro');
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const plan = PLANS.find((p) => p.code === planCode) ?? PLANS[1]!;
  const months = cycle === 'yearly' ? 12 : 1;
  const discount = cycle === 'yearly' ? 0.8 : 1; // 2 months free on annual
  const amount = Math.round(plan.priceNpr * months * discount);

  return (
    <main className="min-h-screen bg-cream px-6 py-16">
      <div className="mx-auto max-w-content">
        {/* dev banner */}
        <div className="mb-8 flex items-center justify-center">
          <span
            className="inline-flex items-center gap-2 rounded-pill border px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest"
            style={{ borderColor: KHALTI, color: KHALTI, background: '#5C2D911a' }}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: KHALTI }} />
            Development environment · payments open soon
          </span>
        </div>

        <header className="mx-auto max-w-2xl text-center">
          <h1 className="display text-[34px] sm:text-[44px]">Choose your plan</h1>
          <p className="mt-4 text-muted">
            Pay securely in Nepali rupees with Khalti when HisabKitab goes live. Today this page is a
            preview, so nothing is charged. You set up billing once your pilot proves its worth.
          </p>
        </header>

        {/* billing cycle toggle */}
        <div className="mt-8 flex items-center justify-center gap-3">
          {(['monthly', 'yearly'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setCycle(c)}
              className={`rounded-pill border px-4 py-2 text-sm font-medium transition-colors ${
                cycle === c ? 'border-primary bg-primary text-white' : 'border-hairline bg-surface text-muted hover:text-ink'
              }`}
            >
              {c === 'monthly' ? 'Monthly' : 'Yearly'}
              {c === 'yearly' && <span className="ml-1.5 text-[11px] opacity-90">2 months free</span>}
            </button>
          ))}
        </div>

        {/* plans */}
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {PLANS.map((p) => {
            const selected = p.code === planCode;
            return (
              <button
                key={p.code}
                onClick={() => setPlanCode(p.code)}
                className={`card relative p-6 text-left transition-all duration-300 hover:-translate-y-1 ${
                  selected ? 'ring-2 ring-primary' : ''
                }`}
              >
                {p.popular && (
                  <span className="absolute -top-3 left-6 rounded-pill bg-primary px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wide text-white">
                    Most popular
                  </span>
                )}
                <h2 className="font-serif text-xl font-semibold text-ink">{p.name}</h2>
                <p className="mt-1 text-sm text-muted">{p.blurb}</p>
                <p className="mt-4 font-serif text-3xl font-semibold text-ink">
                  {npr(p.priceNpr)}
                  <span className="text-sm font-normal text-muted"> / mo</span>
                </p>
                <ul className="mt-4 space-y-2 text-sm text-muted">
                  {p.perks.map((perk) => (
                    <li key={perk} className="flex items-start gap-2">
                      <span className="mt-0.5 text-primary">✓</span> {perk}
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>

        {/* checkout summary + disabled Khalti button */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="card mx-auto mt-10 max-w-md p-6"
        >
          <div className="flex items-center justify-between">
            <span className="text-muted">{plan.name} plan</span>
            <span className="font-medium text-ink">{cycle === 'yearly' ? 'Annual' : 'Monthly'}</span>
          </div>
          <div className="mt-3 flex items-baseline justify-between border-t border-hairline pt-3">
            <span className="font-serif text-lg font-semibold text-ink">Total today</span>
            <span className="font-serif text-2xl font-semibold text-ink">{npr(amount)}</span>
          </div>

          <button
            type="button"
            disabled
            aria-disabled="true"
            title="Payments open when the HisabKitab servers go live"
            className="mt-5 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-control px-6 py-3 font-semibold text-white opacity-60"
            style={{ background: KHALTI }}
          >
            <span aria-hidden>🔒</span> Pay {npr(amount)} with Khalti
          </button>

          <p className="mt-3 text-center text-xs text-muted">
            This is a development preview. No payment is processed and no card or wallet is charged.
            We will switch this on after the pilot.
          </p>
          <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-muted">
            <span className="rounded-sm bg-cream px-2 py-1 font-mono">eSewa coming soon</span>
            <span className="rounded-sm bg-cream px-2 py-1 font-mono">Fonepay coming soon</span>
          </div>
        </motion.div>

        {/* compare plans */}
        <section className="mt-20" aria-labelledby="compare">
          <h2 id="compare" className="display text-center text-[26px] sm:text-[32px]">
            Compare plans
          </h2>
          <div className="card mt-8 overflow-x-auto p-0">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-hairline">
                  <th className="p-4 font-medium text-muted">Feature</th>
                  {PLANS.map((p) => (
                    <th key={p.code} className="p-4 text-center font-serif text-base font-semibold text-ink">
                      {p.name}
                      <span className="block font-sans text-xs font-normal text-muted">{npr(p.priceNpr)} / mo</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row) => (
                  <tr key={row.label} className="border-b border-hairline last:border-0">
                    <td className="p-4 text-muted">{row.label}</td>
                    {row.cells.map((c, i) => (
                      <td key={i} className="p-4 text-center">
                        <Mark value={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* team + roles */}
        <section className="mt-20" aria-labelledby="team">
          <div className="mx-auto max-w-2xl text-center">
            <h2 id="team" className="display text-[26px] sm:text-[32px]">
              Bring your accountant. Keep the keys.
            </h2>
            <p className="mt-4 text-muted">
              On Pro and Business you can give your accountant, auditor or staff their own access from their own
              WhatsApp. Each person sees only what their role allows, and our servers check the role on every single
              request.
            </p>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {ROLES.map((r) => (
              <div key={r.name} className="card p-5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-serif text-lg font-semibold text-ink">{r.name}</h3>
                  <span className="rounded-pill bg-cream px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted">
                    {r.tag}
                  </span>
                </div>
                <p className="mt-3 text-sm text-ink">{r.can}</p>
                <p className="mt-2 text-xs text-muted">{r.cannot}</p>
              </div>
            ))}
          </div>
        </section>

        {/* how to add people */}
        <section className="mt-20 grid gap-8 md:grid-cols-2 md:items-center" aria-labelledby="add-team">
          <div>
            <h2 id="add-team" className="display text-[26px] sm:text-[32px]">
              Add someone in one message
            </h2>
            <p className="mt-4 text-muted">
              Send a message to HisabKitab from your number. The person you add gets a WhatsApp invite and replies{' '}
              <span className="font-mono text-ink">JOIN</span> from their own phone. Nobody gets in without that reply,
              and nobody can add themselves.
            </p>
            <ul className="mt-5 space-y-2 text-sm text-muted">
              <li className="flex gap-2">
                <span className="text-primary">✓</span> Give access for 7 days, a quarter or a year, and it ends on its
                own
              </li>
              <li className="flex gap-2">
                <span className="text-primary">✓</span> Remove someone and their next message is refused
              </li>
              <li className="flex gap-2">
                <span className="text-primary">✓</span> Every change is written to your tamper-proof audit log
              </li>
              <li className="flex gap-2">
                <span className="text-primary">✓</span> If our support team changes your team, you are told on
                WhatsApp
              </li>
            </ul>
          </div>
          <div className="card p-5">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted">From your WhatsApp</p>
            <ul className="mt-4 space-y-3">
              {COMMANDS.map(([cmd, what]) => (
                <li key={cmd} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <code className="rounded-sm bg-cream px-2 py-1 font-mono text-[13px] text-ink">{cmd}</code>
                  <span className="text-xs text-muted">{what}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* small print */}
        <section className="mx-auto mt-20 max-w-2xl" aria-labelledby="pricing-faq">
          <h2 id="pricing-faq" className="display text-center text-[26px] sm:text-[32px]">
            Good to know
          </h2>
          <dl className="mt-8 space-y-6 text-sm">
            <div>
              <dt className="font-semibold text-ink">Is it a contract?</dt>
              <dd className="mt-1 text-muted">
                No. You pay for one month up front in Nepali rupees. Nothing renews or charges on its own.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">What counts as a person?</dt>
              <dd className="mt-1 text-muted">
                Every WhatsApp number with access, including you. An invite waiting for a JOIN reply holds its place
                for 7 days.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">Can my auditor change my books?</dt>
              <dd className="mt-1 text-muted">
                No. An auditor and a viewer are read-only. Only you or an accountant can confirm an entry, and only you
                can move money.
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">What if I stop paying?</dt>
              <dd className="mt-1 text-muted">
                Your data stays yours and is never deleted for a missed payment. Renew and carry on where you left off.
              </dd>
            </div>
          </dl>
        </section>

        <p className="mx-auto mt-10 max-w-md text-center text-sm text-muted">
          Want to be first in line?{' '}
          <a href="/pilot#signup" className="font-semibold text-primary underline-offset-4 hover:underline">
            Join the free pilot
          </a>
        </p>
        <p className="mx-auto mt-6 max-w-lg text-center text-xs leading-relaxed text-muted">
          Payments are received by <span className="text-ink">{NEPAL_COMPANY.name}</span>, Company Reg. No.{' '}
          {NEPAL_COMPANY.registrationNo}, PAN {NEPAL_COMPANY.pan}, {NEPAL_COMPANY.city}.
        </p>
      </div>
    </main>
  );
}
