'use client';

import { motion } from 'framer-motion';

/** Bento grid (per design.md) — the agent's capabilities, varied tile sizes. */
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

        <div className="grid auto-rows-[180px] grid-cols-2 gap-5 lg:grid-cols-4">
          {/* big tile: VAT */}
          <Tile className="col-span-2 row-span-2 flex flex-col justify-between bg-gradient-to-br from-surface to-cream/50">
            <div>
              <span className="label">Nepal VAT &amp; TDS</span>
              <h3 className="display mt-3 text-2xl">Tax math, done right</h3>
              <p className="mt-2 max-w-sm text-sm text-muted">
                Inclusive/exclusive 13% VAT, input-credit eligibility (Rule 17 vs 17Ka, the 1-year
                window), TDS on the VAT-exclusive base. Ambiguous? It asks an accountant, never estimates.
              </p>
            </div>
            <div className="flex items-end gap-4 font-mono text-xs text-muted">
              <div><p className="text-2xl font-semibold text-ink">8,000</p>taxable</div>
              <div className="text-primary"><p className="text-2xl font-semibold">1,040</p>VAT 13%</div>
              <div><p className="text-2xl font-semibold text-ink">9,040</p>total</div>
            </div>
          </Tile>

          <Tile delay={0.05}><Icon>📄</Icon><h3 className="mt-3 font-serif font-semibold">Bill extraction</h3><p className="mt-1 text-sm text-muted">Reads messy photos &amp; PDFs — and asks when unsure.</p></Tile>
          <Tile delay={0.1}><Icon>💳</Icon><h3 className="mt-3 font-serif font-semibold">Khalti payments</h3><p className="mt-1 text-sm text-muted">Collect &amp; verify; the sale records itself, exactly once.</p></Tile>

          <Tile delay={0.15} className="col-span-2 flex items-center gap-5">
            <Icon big>🔔</Icon>
            <div><h3 className="font-serif font-semibold">Monthly VAT reminders</h3><p className="mt-1 text-sm text-muted">Around the 20th BS, it prepares the return, self-verifies the numbers, and nudges you — you review and file.</p></div>
          </Tile>

          <Tile delay={0.2}><Icon>📊</Icon><h3 className="mt-3 font-serif font-semibold">AR / AP &amp; aging</h3><p className="mt-1 text-sm text-muted">Who owes you, what you owe — bucketed by age.</p></Tile>
          <Tile delay={0.25}><Icon>📑</Icon><h3 className="mt-3 font-serif font-semibold">PDF reports</h3><p className="mt-1 text-sm text-muted">Rendered from validated data — reconcile-or-hold.</p></Tile>
        </div>
      </div>
    </section>
  );
}

function Icon({ children, big }: { children: React.ReactNode; big?: boolean }) {
  return <span className={`grid place-items-center rounded-card bg-cream ${big ? 'h-14 w-14 text-2xl' : 'h-11 w-11 text-xl'}`}>{children}</span>;
}
