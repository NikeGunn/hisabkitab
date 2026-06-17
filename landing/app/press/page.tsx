import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Press',
  description: 'HisabKitab press kit: what we are, the one-line pitch, and how to reach us.',
  alternates: { canonical: 'https://hisabkitab.pro/press' },
};

export default function PressPage() {
  return (
    <PageShell
      eyebrow="Company"
      title="Press &amp; media"
      lede="The short version, for journalists and partners who need the facts fast."
    >
      <Section title="One line">
        <p>
          <strong>HisabKitab is a WhatsApp bookkeeping agent for small VAT-registered businesses in
          Nepal</strong>. It reads bills, computes 13% VAT and TDS, and prepares the monthly return,
          while the owner approves every entry.
        </p>
      </Section>

      <Section title="Facts">
        <ul className="ml-5 list-disc space-y-2">
          <li><strong>What it is:</strong> a bookkeeping and VAT assistant that runs entirely inside WhatsApp, with no app to install.</li>
          <li><strong>Where:</strong> built in Kathmandu, for Nepal&apos;s VAT, TDS, and Bikram Sambat calendar.</li>
          <li><strong>Stage:</strong> currently onboarding a free pilot.</li>
          <li><strong>The principle:</strong> it prepares and shows its work; it never files for you and never saves without approval.</li>
        </ul>
      </Section>

      <Section title="Contact">
        <p>
          For interviews, assets, or fact-checks:{' '}
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:press@hisabkitab.pro">
            press@hisabkitab.pro
          </a>
        </p>
      </Section>
    </PageShell>
  );
}
