import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'How it works',
  description:
    'The HisabKitab loop, step by step: send a bill on WhatsApp, the agent reads and checks it, you approve, and your VAT return is prepared by the 25th.',
  alternates: { canonical: 'https://hisabkitab.pro/how-it-works' },
};

const STEPS = [
  { n: '01', t: 'Send a bill', b: 'Snap a photo, forward a PDF, or just type the amount. Whatever is fastest in the moment, all inside WhatsApp.' },
  { n: '02', t: 'The agent reads it', b: 'Vendor, date, amount, and VAT are extracted from even messy receipts, then checked against Nepal’s 17 / 17Ka and one-year credit rules.' },
  { n: '03', t: 'It asks when unsure', b: 'A smudged total or a borderline input credit doesn’t get a guess. It gets a question, or a hand-off to an accountant.' },
  { n: '04', t: 'You approve', b: 'Nothing reaches your books without your ✅. Once approved, the entry is written once, with an audit trail.' },
  { n: '05', t: 'Your return is prepared', b: 'Before the 25th, the agent assembles the period’s VAT, self-verifies the totals in integer paisa, and nudges you.' },
  { n: '06', t: 'You review and file', b: 'You file on the IRD portal yourself. HisabKitab prepares and shows its work; it never files for you.' },
];

export default function HowItWorksPage() {
  return (
    <PageShell
      eyebrow="Resources"
      title="How it works"
      lede="Six steps, one WhatsApp thread. You stay the approver the entire way: the agent does the carrying, you keep the control."
    >
      <div className="mx-auto max-w-3xl space-y-5">
        {STEPS.map((s) => (
          <div key={s.n} className="card flex gap-5 p-6">
            <span className="font-mono text-2xl font-semibold text-primary">{s.n}</span>
            <div>
              <h3 className="font-serif text-lg font-semibold text-ink">{s.t}</h3>
              <p className="mt-1 text-[15px] leading-relaxed text-muted">{s.b}</p>
            </div>
          </div>
        ))}
      </div>

      <Section>
        <p className="text-center">
          That&apos;s the whole loop.{' '}
          <a href="/#start" className="font-semibold text-primary underline-offset-4 hover:underline">
            Start on WhatsApp →
          </a>
        </p>
      </Section>
    </PageShell>
  );
}
