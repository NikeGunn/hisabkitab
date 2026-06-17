import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Platform',
  description:
    'How HisabKitab works under the hood: bill extraction, Nepal VAT & TDS math, Khalti payments, reports, and monthly reminders, all inside WhatsApp, all approved by you.',
  alternates: { canonical: 'https://hisabkitab.pro/platform' },
};

export default function PlatformPage() {
  return (
    <PageShell
      eyebrow="Platform"
      title="One agent. Your whole back office."
      lede="HisabKitab is a single bookkeeping agent that lives in WhatsApp. Here is exactly what each part does, and where you stay in control."
    >
      <Section id="bill-extraction" title="Bill extraction">
        <p>
          Send a photo, a PDF, or a line of text. The agent reads messy receipts:
          faded thermal paper, handwritten totals, mixed Nepali and English, and pulls out the
          vendor, date, amounts, and VAT. <strong>When a field is unclear, it asks instead of
          guessing.</strong> Nothing is invented to fill a blank.
        </p>
      </Section>

      <Section id="vat-tds" title="VAT &amp; TDS">
        <p>
          Nepal&apos;s 13% VAT, computed in whole paisa with integer math so totals always reconcile.
          It handles inclusive and exclusive pricing, checks input-credit eligibility (Rule 17 vs the
          abbreviated 17Ka bill, and the one-year claim window), and applies TDS on the
          VAT-exclusive base. <strong>Ambiguous cases route to a human accountant; it never
          estimates a tax number.</strong> See the <a className="text-primary underline-offset-4 hover:underline" href="/vat-guide">Nepal VAT guide</a> for the full rules.
        </p>
      </Section>

      <Section id="payments" title="Payments">
        <p>
          Collect through Khalti and the sale records itself, <strong>exactly once</strong>, with an
          idempotency key so a retried message can never double-count. Every payment is verified
          against the gateway before it touches your books.
        </p>
      </Section>

      <Section id="reports" title="Reports">
        <p>
          Clean PDF reports rendered only from validated data: VAT summaries, AR/AP aging by party,
          and month-end statements. If a figure can&apos;t be reconciled, the report holds it and tells
          you why rather than shipping a wrong number.
        </p>
      </Section>

      <Section id="invoices" title="Invoices &amp; corrections">
        <p>
          Sales invoices carry <strong>gap-free sequential numbers per fiscal year</strong>, the way
          the IRD expects them. A confirmed invoice is never edited: a return or correction is issued as
          a linked <strong>credit or debit note</strong>, so the audit trail stays intact and your VAT
          nets out correctly.
        </p>
      </Section>

      <Section id="reminders" title="Reminders">
        <p>
          Before the 25th of each Nepali month, the IRD filing deadline, the agent prepares your
          return, self-verifies the numbers, and nudges you to review and file. You file on the IRD
          portal yourself; <strong>it never files for you.</strong>
        </p>
      </Section>
    </PageShell>
  );
}
