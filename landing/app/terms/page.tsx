import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Terms',
  description: 'The terms of using HisabKitab during the pilot.',
  alternates: { canonical: 'https://hisabkitab.pro/terms' },
};

export default function TermsPage() {
  return (
    <PageShell
      eyebrow="Legal"
      title="Terms of use"
      lede="The agreement between you and HisabKitab, kept as short as honesty allows."
    >
      <Section title="What HisabKitab is">
        <p>
          A bookkeeping assistant. It prepares figures and shows its work. <strong>It does not file your
          tax returns and is not a substitute for a licensed accountant.</strong> You remain responsible
          for what you file with the IRD.
        </p>
      </Section>
      <Section title="Your responsibilities">
        <p>
          Review every entry before approving it, file your returns on the IRD portal yourself, and keep
          your account credentials safe. Nothing is saved to your books without your approval, which
          means accuracy of approvals is on you.
        </p>
      </Section>
      <Section title="Pilot terms">
        <p>
          The service is offered free during the pilot, as-is, and may change as we improve it. You can
          stop using it and export your data at any time.
        </p>
      </Section>
      <Section title="Contact">
        <p>
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:hello@hisabkitab.pro">hello@hisabkitab.pro</a>
        </p>
      </Section>
    </PageShell>
  );
}
