import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Data deletion',
  description: 'How to delete your HisabKitab account and data.',
  alternates: { canonical: 'https://hisabkitab.pro/data-deletion' },
};

export default function DataDeletionPage() {
  return (
    <PageShell
      eyebrow="Legal"
      title="Delete your data"
      lede="Your data is yours. Here is exactly how to take it back or erase it."
    >
      <Section title="How to request deletion">
        <p>
          Email{' '}
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:privacy@hisabkitab.pro">privacy@hisabkitab.pro</a>{' '}
          from the contact tied to your account, or message us on WhatsApp, and ask us to delete your
          account. We&apos;ll confirm and process it promptly.
        </p>
      </Section>
      <Section title="What gets deleted">
        <p>
          Your account, your messages, and your bookkeeping records, except records we are legally
          required to retain under the IRD&apos;s 6-year rule, which are kept isolated and deleted once that
          period ends.
        </p>
      </Section>
      <Section title="Export first">
        <p>
          Want a copy before you go? Ask for an export in the same message and we&apos;ll send your books
          before deleting anything.
        </p>
      </Section>
    </PageShell>
  );
}
