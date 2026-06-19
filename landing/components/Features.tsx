'use client';

import { motion } from 'framer-motion';

/** Bento grid of product capabilities, with varied tile sizes. */
const ease = [0.22, 1, 0.36, 1] as const;

function Tile({ className = '', children, delay = 0 }: { className?: string; children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-8% 0px' }}
      transition={{ duration: 0.6, ease, delay }}
      className={`card p-6 ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function Features() {
  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-content px-6">
        <div className="mb-12 max-w-2xl">
          <span className="label">What the agent does</span>
          <h2 className="display mt-3 text-[34px] sm:text-[42px]">One agent. Your whole back office.</h2>
        </div>

        {/* Bento grid: single column on phones (nothing clips), 2-up on small
            tablets, full 4-col bento from lg up. Rows size to content
            (auto-rows-fr keeps siblings in a row equal height) so copy never
            overflows a fixed tile height. */}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:auto-rows-fr lg:grid-cols-4">
          {/* big tile: VAT — spans 2x2 only where there's room for it */}
          <Tile className="flex flex-col justify-between gap-6 bg-gradient-to-br from-surface to-cream/50 sm:col-span-2 sm:row-span-2">
            <div>
              <span className="label">Nepal VAT &amp; TDS</span>
              <h3 className="display mt-3 text-2xl">Tax math, done right</h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">
                Inclusive/exclusive 13% VAT, input-credit eligibility (Rule 17 vs 17Ka, the 1-year
                window), TDS on the VAT-exclusive base. Ambiguous? It asks an accountant, never estimates.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3 font-mono text-xs text-muted">
              <div><p className="text-2xl font-semibold text-ink">8,000</p>taxable</div>
              <div className="text-primary"><p className="text-2xl font-semibold">1,040</p>VAT 13%</div>
              <div><p className="text-2xl font-semibold text-ink">9,040</p>total</div>
            </div>
          </Tile>

          <Tile delay={0.05}><Icon>📄</Icon><h3 className="mt-3 font-serif font-semibold">Bill extraction</h3><p className="mt-1 text-sm leading-relaxed text-muted">Reads messy photos and PDFs, and asks when unsure.</p></Tile>
          <Tile delay={0.1}><Icon>💳</Icon><h3 className="mt-3 font-serif font-semibold">Khalti payments</h3><p className="mt-1 text-sm leading-relaxed text-muted">Collect and verify, and the sale records itself, exactly once.</p></Tile>

          <Tile delay={0.15} className="flex items-start gap-5 sm:col-span-2">
            <Icon big>🔔</Icon>
            <div><h3 className="font-serif font-semibold">Monthly VAT reminders</h3><p className="mt-1 text-sm leading-relaxed text-muted">Before the 25th, it prepares the return, self verifies the numbers, and nudges you to review and file.</p></div>
          </Tile>

          <Tile delay={0.2}><Icon>📊</Icon><h3 className="mt-3 font-serif font-semibold">AR / AP and aging</h3><p className="mt-1 text-sm leading-relaxed text-muted">Who owes you and what you owe, bucketed by age.</p></Tile>
          <Tile delay={0.25}><Icon>📑</Icon><h3 className="mt-3 font-serif font-semibold">PDF reports</h3><p className="mt-1 text-sm leading-relaxed text-muted">Rendered from validated data, with reconcile or hold.</p></Tile>

          <Tile delay={0.3} className="flex items-start gap-5 sm:col-span-2">
            <Icon big>🧾</Icon>
            <div><h3 className="font-serif font-semibold">TDS deposit, never missed</h3><p className="mt-1 text-sm leading-relaxed text-muted">TDS is due on the 25th too. It totals what you withheld, checks the figure, and reminds you in time to deposit. Two deadlines, one calm nudge.</p></div>
          </Tile>

          <Tile delay={0.35}><Icon>🌱</Icon><h3 className="mt-3 font-serif font-semibold">Opening balances</h3><p className="mt-1 text-sm leading-relaxed text-muted">Switching mid year? Bring your open debtors, creditors, and VAT credit so day one is accurate.</p></Tile>
          <Tile delay={0.4}><Icon>📅</Icon><h3 className="mt-3 font-serif font-semibold">Year end carry forward</h3><p className="mt-1 text-sm leading-relaxed text-muted">Every month settled and excess VAT credit carried forward, the way the VAT Act intends.</p></Tile>
        </div>
      </div>
    </section>
  );
}

function Icon({ children, big }: { children: React.ReactNode; big?: boolean }) {
  return <span className={`grid place-items-center rounded-card bg-cream ${big ? 'h-14 w-14 text-2xl' : 'h-11 w-11 text-xl'}`}>{children}</span>;
}
