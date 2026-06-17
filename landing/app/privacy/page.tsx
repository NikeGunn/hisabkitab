import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'How HisabKitab collects, uses, and protects your data.',
  alternates: { canonical: 'https://hisabkitab.pro/privacy' },
};

export default function PrivacyPage() {
  return (
    <PageShell
      eyebrow="Legal"
      title="Privacy policy"
      lede="Plain language, no surprises. The short version: we keep what bookkeeping requires, and nothing more."
    >
      <Section title="What we collect">
        <p>
          The bills, messages, and figures you send the agent on WhatsApp, your WhatsApp number, and
          the bookkeeping records you approve. That&apos;s the data the product needs to do its job.
        </p>
      </Section>
      <Section title="How we use it">
        <p>
          To read your bills, compute VAT and TDS, prepare your returns, and keep the audit trail Nepal&apos;s
          tax rules require. We do not sell your data, and we do not use it to advertise to you.
        </p>
      </Section>
      <Section title="How long we keep it">
        <p>
          Tax records are retained in line with the IRD&apos;s 6-year requirement. Everything else is kept
          only as long as your account is active. You can request deletion any time, see{' '}
          <a className="text-primary underline-offset-4 hover:underline" href="/data-deletion">Data deletion</a>.
        </p>
      </Section>
      <Section title="Contact">
        <p>
          Questions about your data:{' '}
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:privacy@hisabkitab.pro">privacy@hisabkitab.pro</a>
        </p>
      </Section>
    </PageShell>
  );
}
