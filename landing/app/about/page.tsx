import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'About',
  description:
    'Why HisabKitab exists: a careful, owner-approved bookkeeping agent built for small VAT-registered businesses in Nepal.',
  alternates: { canonical: 'https://hisabkitab.pro/about' },
};

export default function AboutPage() {
  return (
    <PageShell
      eyebrow="Company"
      title="Bookkeeping that earns trust, not just time"
      lede="Hisab-kitab is the everyday Nepali phrase for keeping the books. That is exactly, and only, what this product does."
    >
      <Section title="The problem we kept seeing">
        <p>
          Small Nepali businesses don&apos;t lose money because they&apos;re careless. They lose it because
          bills pile up in a drawer, input credits expire unnoticed, and the 25th arrives faster than
          anyone planned. A full-time accountant is out of reach for most of them. So the books wait,
          until they can&apos;t.
        </p>
      </Section>

      <Section title="What we built">
        <p>
          A single bookkeeping agent that lives where business already happens: WhatsApp. Snap a bill,
          and it reads, classifies, and checks it against Nepal&apos;s VAT rules. The difference from a
          black box is simple: <strong>it shows its work, asks when unsure, and saves nothing without
          your approval.</strong>
        </p>
      </Section>

      <Section title="What we won't do">
        <p>
          We will never file your return for you, never guess a tax number to fill a gap, and never
          save an entry you haven&apos;t approved. The owner stays the single source of truth. That
          constraint isn&apos;t a limitation. It&apos;s the whole point.
        </p>
      </Section>

      <Section title="Made in Nepal 🇳🇵">
        <p>
          Built in Kathmandu for Nepali businesses, with Nepal&apos;s VAT, TDS, and Bikram Sambat calendar
          treated as first-class, not bolted onto a foreign template.
        </p>
      </Section>
    </PageShell>
  );
}
