import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';
import { LEGAL_ENTITY, PARTNER_COMPANY } from '@/components/legal-entity';

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
          HisabKitab is operated by <strong>{LEGAL_ENTITY.name}</strong>, a private limited company
          registered with the {LEGAL_ENTITY.registrar} (Reg. No. {LEGAL_ENTITY.registrationNo}).
          Registered office: {LEGAL_ENTITY.address}. Phone:{' '}
          <a className="text-primary underline-offset-4 hover:underline" href={LEGAL_ENTITY.phoneHref}>{LEGAL_ENTITY.phone}</a>.
        </p>
      </Section>
      <Section title="Partner company">
        <p>
          Our partner company is <strong>{PARTNER_COMPANY.name}</strong>.
          Principal place of business and registered office: {PARTNER_COMPANY.address}. Phone:{' '}
          <a className="text-primary underline-offset-4 hover:underline" href={PARTNER_COMPANY.phoneHref}>{PARTNER_COMPANY.phone}</a>.
        </p>
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
