import type { Metadata } from 'next';
import { PageShell, Section, CardGrid } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How HisabKitab protects your books: approval-gated writes, audit logging, role-based access, idempotent payments, and data you can export or delete.',
  alternates: { canonical: 'https://hisabkitab.pro/security' },
};

export default function SecurityPage() {
  return (
    <PageShell
      eyebrow="Resources"
      title="Security &amp; data"
      lede="A bookkeeping product is only as good as the trust behind its numbers. Here is how we earn it."
    >
      <Section title="The controls that matter">
        <CardGrid
          items={[
            { title: 'Approval-gated writes', body: 'No entry is saved to your books without your explicit ✅. The agent can prepare, but only you can commit.', emoji: '✅' },
            { title: 'Tamper-evident audit log', body: 'Every entry, edit, and approval is hash-chained, so the record cannot be silently rewritten. The trail you need for a 6-year IRD record.', emoji: '🧾' },
            { title: 'Role-based access', body: 'Owners approve; staff capture. Permissions are enforced on the server, not just hidden in the UI.', emoji: '🔐' },
            { title: 'Idempotent payments', body: 'Khalti payments carry an idempotency key, so a retried message can never double-count a sale.', emoji: '🔁' },
            { title: 'Encrypted PII', body: 'Your most sensitive identifiers, like PAN and VAT numbers, are encrypted at the field level with authenticated AES-256.', emoji: '🛡️' },
            { title: 'Per-business isolation', body: 'Each business sees only its own books. Tenant boundaries are enforced in the database itself, not just the app.', emoji: '🧱' },
          ]}
        />
      </Section>

      <Section title="Your data is yours">
        <p>
          You can export your books at any time, and request deletion of your account and data. We
          retain the records required for tax compliance only as long as needed, in line with the
          6-year IRD retention rule, and never sell your data.
        </p>
      </Section>

      <Section title="Reporting a vulnerability">
        <p>
          Found a security issue? We want to hear about it before anyone else does. Email{' '}
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:security@hisabkitab.pro">
            security@hisabkitab.pro
          </a>{' '}
          and we&apos;ll respond quickly. Please give us a reasonable window to fix it before public
          disclosure.
        </p>
      </Section>
    </PageShell>
  );
}
