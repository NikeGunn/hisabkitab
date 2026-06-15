'use client';

import { motion } from 'framer-motion';

/**
 * "Is this for me?": persona tiles that make the visitor self identify, then
 * frame the relief. Name the pain they live with, then the calm after. Each card
 * leads with WHO, the pain, and the specific relief, concrete not generic.
 */
const ease = [0.22, 1, 0.36, 1] as const;

const PERSONAS = [
  {
    tag: 'Café & restaurant owners',
    emoji: '☕',
    pain: '“Bills pile up in a drawer. By the 25th I’m panicking about VAT.”',
    relief: 'Snap each bill as it comes. By month end your return is already prepared, ready for you to review and file.',
    proof: 'Shrawan return ready in 0 late nights',
  },
  {
    tag: 'Retail & hardware shops',
    emoji: '🛠️',
    pain: '“I don’t know which bills I can actually claim VAT on.”',
    relief: 'It flags abbreviated (17Ka) and expired bills, and explains why, so you can avoid over claiming.',
    proof: 'Wrong input credits → caught, not filed',
  },
  {
    tag: 'Suppliers & wholesalers',
    emoji: '📦',
    pain: '“TDS and credit terms are a mess across dozens of parties.”',
    relief: 'TDS on the VAT exclusive base, with AR and AP aging by party, so you always know who owes you and what you owe.',
    proof: 'Every debtor, bucketed by age',
  },
  {
    tag: 'Solo founders & freelancers',
    emoji: '💻',
    pain: '“I can’t afford a full-time accountant yet.”',
    relief: 'A careful bookkeeping assistant on WhatsApp for the price of a coffee, one that shows its work and asks when unsure.',
    proof: 'No app, no portal, no hire',
  },
  {
    tag: 'Family businesses',
    emoji: '🏪',
    pain: '“Whoever’s at the counter records sales differently.”',
    relief: 'One agent, one source of truth. Everyone just texts a photo; nothing saves without the owner’s ✅.',
    proof: 'One ledger, owner-approved',
  },
  {
    tag: 'Accountants (their clients)',
    emoji: '📚',
    pain: '“Chasing clients for shoebox receipts all month.”',
    relief: 'Clients capture as they go, so you get clean, reconciled, audit logged books to review instead of a shoebox.',
    proof: 'Month-end review, not data entry',
  },
];

export function UseCases() {
  return (
    <section id="who" className="bg-surface py-24">
      <div className="mx-auto max-w-content px-6">
        <div className="mb-14 max-w-2xl">
          <span className="label">Who it’s for</span>
          <h2 className="display mt-3 text-[34px] sm:text-[42px]">If you keep a VAT bill, this is for you</h2>
          <p className="mt-4 text-muted">
            Built for small Nepali businesses that are too busy serving customers to babysit a ledger,
            and too careful to trust a black box. Find yourself below.
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {PERSONAS.map((p, i) => (
            <motion.article
              key={p.tag}
              initial={{ opacity: 0, y: 22 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-8% 0px' }}
              transition={{ duration: 0.55, ease, delay: (i % 3) * 0.08 }}
              className="card group flex flex-col p-6 transition-all duration-300 hover:-translate-y-1 hover:border-primary/30 hover:shadow-lift"
            >
              <div className="mb-4 flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-card bg-cream text-xl transition-transform duration-300 group-hover:scale-110">
                  {p.emoji}
                </span>
                <h3 className="font-serif text-lg font-semibold leading-tight text-ink">{p.tag}</h3>
              </div>
              <p className="text-[15px] italic leading-relaxed text-muted">{p.pain}</p>
              <p className="mt-3 text-[15px] leading-relaxed text-ink">{p.relief}</p>
              <p className="mt-5 inline-flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-primary">
                <span aria-hidden>✓</span> {p.proof}
              </p>
            </motion.article>
          ))}
        </div>

        {/* the psychological close: scarcity + safety, no pressure */}
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mx-auto mt-12 max-w-xl text-center text-muted"
        >
          Joining the pilot is free, and you approve every entry, so there is nothing to lose and a
          month of evenings to gain.{' '}
          <a href="#start" className="font-semibold text-primary underline-offset-4 hover:underline">
            Start on WhatsApp →
          </a>
        </motion.p>
      </div>
    </section>
  );
}
