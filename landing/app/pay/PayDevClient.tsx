'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';

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
    priceNpr: 999,
    blurb: 'For a solo shop finding its rhythm.',
    perks: ['Log by photo or text', 'VAT reminders', 'Nil return prep', '1 user'],
  },
  {
    code: 'pro',
    name: 'Pro',
    priceNpr: 1999,
    blurb: 'For a growing business with credit customers.',
    perks: ['Everything in Starter', 'Debtors and creditors', 'Statements and aging', '3 users'],
    popular: true,
  },
  {
    code: 'business',
    name: 'Business',
    priceNpr: 2999,
    blurb: 'For an established SMB and its accountant.',
    perks: ['Everything in Pro', 'All PDF reports', 'Accountant seat', 'Priority support'],
  },
];

const npr = (n: number) => `Rs ${n.toLocaleString('en-IN')}`;

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
            <span className="rounded bg-cream px-2 py-1 font-mono">eSewa coming soon</span>
            <span className="rounded bg-cream px-2 py-1 font-mono">Fonepay coming soon</span>
          </div>
        </motion.div>

        <p className="mx-auto mt-10 max-w-md text-center text-sm text-muted">
          Want to be first in line?{' '}
          <a href="/#start" className="font-semibold text-primary underline-offset-4 hover:underline">
            Join the free pilot on WhatsApp
          </a>
        </p>
      </div>
    </main>
  );
}
