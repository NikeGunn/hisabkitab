import type { Metadata } from 'next';
import { PageShell, Section, CardGrid } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Pilot program',
  description:
    'Join the HisabKitab pilot. Free during the pilot, you approve every entry, and you can leave with your data anytime.',
  alternates: { canonical: 'https://hisabkitab.pro/pilot' },
};

export default function PilotPage() {
  return (
    <PageShell
      eyebrow="Company"
      title="Join the pilot"
      lede="We're onboarding a small group of VAT-registered Nepali businesses. Free during the pilot, nothing to install, and nothing to lose."
    >
      <Section title="What you get">
        <CardGrid
          items={[
            { title: 'Free during the pilot', body: 'No card, no commitment. We want your feedback more than your money right now.', emoji: '🎁' },
            { title: 'You approve everything', body: 'Nothing is saved to your books without your ✅. The agent prepares; you decide.', emoji: '✅' },
            { title: 'Real Nepal VAT logic', body: '13% VAT, 17/17Ka credit checks, TDS, and the 25th deadline, handled, not faked.', emoji: '🧮' },
            { title: 'Leave anytime', body: 'Export your data and walk away whenever you like. No lock-in.', emoji: '🚪' },
          ]}
        />
      </Section>

      <Section title="Who it's for">
        <p>
          Cafés, retail and hardware shops, suppliers, solo founders, family businesses, and the
          accountants who serve them. If you keep a VAT bill, the pilot is for you.
        </p>
      </Section>

      <Section title="How to join">
        <p>
          Start the conversation on WhatsApp and we&apos;ll set you up. It takes a few minutes.
        </p>
        <a href="/#start" className="btn-primary mt-2">Start on WhatsApp →</a>
      </Section>
    </PageShell>
  );
}
