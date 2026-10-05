import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';
import { LEGAL_ENTITY, NEPAL_COMPANY } from '@/components/legal-entity';
import { NepalCompanyCard } from '@/components/NepalCompanyCard';

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
      lede={`The agreement between you and HisabKitab (operated by ${LEGAL_ENTITY.name}), kept as short as honesty allows.`}
    >
      <Section title="Who we are">
        <p>
          HisabKitab is operated by <strong>{LEGAL_ENTITY.name}</strong>.
          Principal place of business and registered office: {LEGAL_ENTITY.address}. Phone:{' '}
          <a className="text-primary underline-offset-4 hover:underline" href={LEGAL_ENTITY.phoneHref}>{LEGAL_ENTITY.phone}</a>.
        </p>
        <p>
          HisabKitab is developed in Nepal by <strong>{NEPAL_COMPANY.name}</strong> (Company Reg. No.{' '}
          {NEPAL_COMPANY.registrationNo}, PAN {NEPAL_COMPANY.pan}), {NEPAL_COMPANY.city}. Subscription fees paid in
          Nepal, including payments through Khalti, are received by {NEPAL_COMPANY.name}.
        </p>
        <div className="not-prose mt-4">
          <NepalCompanyCard />
        </div>
      </Section>
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
