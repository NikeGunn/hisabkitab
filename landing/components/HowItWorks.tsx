'use client';

import { motion } from 'framer-motion';

/**
 * How the smart agent works — the four-step loop, the heart of the product.
 * Each step animates in on scroll with a connecting line drawn between them.
 */
const ease = [0.22, 1, 0.36, 1] as const;

const STEPS = [
  { n: '01', icon: '📸', title: 'You send a bill', body: 'A photo, PDF, or a quick line of text on WhatsApp. Voice notes coming soon.' },
  { n: '02', icon: '🧠', title: 'The agent reads it', body: 'It extracts vendor, taxable amount, and VAT — computing 13% to the exact paisa, never a float.' },
  { n: '03', icon: '🔎', title: 'It shows its work', body: 'Every field echoed back. Anything unclear is flagged — it asks rather than guesses.' },
  { n: '04', icon: '✅', title: 'You approve, it saves', body: 'Only on your ✅ does a draft become a confirmed entry. Nothing is ever filed for you.' },
];

export function HowItWorks() {
  return (
    <section id="how" className="relative py-24">
      <div className="mx-auto max-w-content px-6">
        <div className="mb-14 max-w-2xl">
          <span className="label">How it works</span>
          <h2 className="display mt-3 text-[34px] sm:text-[42px]">A careful loop, every single time</h2>
          <p className="mt-4 text-muted">
            The agent is built to one promise: <b className="text-ink">it shows its work, flags what it&apos;s
            unsure of, and never saves without your confirmation.</b>
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <motion.div
              key={s.n}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-10% 0px' }}
              transition={{ duration: 0.6, ease, delay: i * 0.1 }}
              className="card relative p-6 transition-transform duration-300 hover:-translate-y-1 hover:shadow-lift"
            >
              <div className="mb-4 flex items-center justify-between">
                <span className="grid h-12 w-12 place-items-center rounded-card bg-cream text-2xl">{s.icon}</span>
                <span className="font-mono text-sm font-semibold text-primary/70">{s.n}</span>
              </div>
              <h3 className="font-serif text-lg font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s.body}</p>
            </motion.div>
          ))}
        </div>

        {/* safety strip */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease }}
          className="mt-8 grid gap-px overflow-hidden rounded-card border border-hairline bg-hairline sm:grid-cols-3"
        >
          {[
            ['Never guesses', 'Low-confidence → it asks for a clearer photo or the missing field.'],
            ['Never auto-files', 'It prepares the numbers; you file on the IRD portal yourself.'],
            ['Never takes secrets', 'Passwords, OTPs and logins are refused — WhatsApp isn’t for secrets.'],
          ].map(([t, b]) => (
            <div key={t} className="bg-surface p-6">
              <p className="font-serif font-semibold text-ink">{t}</p>
              <p className="mt-1.5 text-sm text-muted">{b}</p>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
