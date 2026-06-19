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

      <Section id="opening-balances" title="Start with your real numbers">
        <p>
          Switching mid-year? You are not starting from zero. Enter your existing open debtors, open
          creditors, and any carried VAT credit as <strong>opening balances</strong>, and your very
          first statement is accurate from day one. Every opening balance is yours to approve before it
          is saved, just like any other entry.
        </p>
      </Section>

      <Section id="tds-reminder" title="TDS deposit, never missed">
        <p>
          TDS you withheld is due by the 25th, the same day as VAT. HisabKitab totals the TDS withheld
          for the month, double-checks the figure against your confirmed entries, and reminds you in
          time to deposit through eTDS. <strong>It prepares the number; you deposit it.</strong> Two
          deadlines, one calm reminder, zero late fees.
        </p>
      </Section>

      <Section id="backdated-entries" title="Log it late, file it right">
        <p>
          A bill surfaced a week later? Record it on the date it actually happened. HisabKitab files it
          into the correct Nepali month automatically, flags it as backdated, and tells you exactly
          which return period to refresh. <strong>A future date is refused</strong>, because a financial
          entry should never be dated ahead of today.
        </p>
      </Section>

      <Section id="year-end" title="The whole year, carried forward correctly">
        <p>
          See your fiscal year at a glance: every month settled, the annual totals, and any excess VAT
          credit <strong>carried forward month to month</strong> the way the VAT Act intends. No
          spreadsheet, no manual carry-over, no credit quietly lost between months.
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
