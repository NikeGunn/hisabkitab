import type { Metadata } from 'next';
import { PageShell, Section, CardGrid } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Nepal VAT guide (2082/83)',
  description:
    'A plain-English guide to VAT in Nepal for FY 2082/83 (2025/26): the 13% rate, registration thresholds, monthly vs four-monthly filing, the 25th deadline, TDS, and record-keeping, plus exactly how the HisabKitab agent handles each step.',
  alternates: { canonical: 'https://hisabkitab.pro/vat-guide' },
};

export default function VatGuidePage() {
  return (
    <PageShell
      eyebrow="Resources · Updated for FY 2082/83 (2025/26)"
      title="Nepal VAT, in plain English"
      lede="Everything a small Nepali business needs to get VAT right: the rate, the thresholds, the deadlines, and how HisabKitab handles each step for you. This is guidance, not legal advice; always confirm on the IRD portal."
    >
      <Section title="The basics">
        <p>
          VAT in Nepal is a flat <strong>13%</strong>, charged on most goods and services. It is
          governed by the Value Added Tax Act, 2052 (1995) and administered by the Inland Revenue
          Department (IRD) at <a className="text-primary underline-offset-4 hover:underline" href="https://ird.gov.np" target="_blank" rel="noreferrer noopener">ird.gov.np</a>. Some
          items, such as basic foods, education, and health, are exempt or zero-rated.
        </p>
      </Section>

      <Section title="When do I have to register?">
        <p>VAT registration with the IRD becomes mandatory once your annual turnover crosses:</p>
        <CardGrid
          items={[
            { title: 'NPR 50 lakh', body: 'For a business dealing in goods.', emoji: '📦' },
            { title: 'NPR 30 lakh', body: 'For services, or for mixed goods-and-services.', emoji: '🧾' },
          ]}
        />
        <p className="mt-4">
          Below the threshold you can still register voluntarily. This is useful if your customers want VAT
          bills. Some categories must register regardless of turnover.
        </p>
      </Section>

      <Section title="How often do I file?">
        <p>
          It depends on your transaction volume in the previous fiscal year:
        </p>
        <CardGrid
          items={[
            {
              title: 'Monthly',
              body: 'Businesses with turnover above roughly Rs. 1 crore file every Nepali month, by the 25th of the following month.',
              emoji: '🗓️',
            },
            {
              title: 'Four-monthly (trimasik)',
              body: 'Smaller VAT-registered businesses may file once every four months instead of monthly.',
              emoji: '🍂',
            },
          ]}
        />
        <p className="mt-4">
          Either way, <strong>the deadline is the 25th of the Nepali month following the period.</strong> Returns are filed
          on the IRD portal. Note: alternate reporting periods for brick, hotel, tourism, and film
          industries were withdrawn, so those sectors now follow the standard monthly cycle.
        </p>
      </Section>

      <Section title="Input VAT credit: the part people get wrong">
        <p>
          You can offset the VAT you paid on purchases (input VAT) against the VAT you collected on
          sales (output VAT). But the bill has to qualify:
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>It must be a proper tax invoice. An <strong>abbreviated (17Ka) bill</strong> generally does not give a full input credit.</li>
          <li>The claim has a <strong>one-year window</strong> from the invoice. Miss it and the credit is gone.</li>
          <li>Some purchases (e.g. certain vehicles, entertainment) are restricted by Rule 17.</li>
        </ul>
        <p>
          Over-claiming here is the most common reason returns get questioned. This is exactly the
          check HisabKitab runs on every bill.
        </p>
      </Section>

      <Section title="TDS, briefly">
        <p>
          Tax Deducted at Source is separate from VAT but lives in the same workflow. For FY 2082/83,
          rates run from <strong>1.5%</strong> (on VAT-registered service providers) up to 25% on
          windfall gains. TDS is calculated on the <strong>VAT-exclusive</strong> base, and deposited
          to the IRD within 25 days of the month it was deducted.
        </p>
      </Section>

      <Section title="Keep your records for 6 years">
        <p>
          VAT-registered businesses must retain tax invoices, purchase and sales registers, the stock
          register, and import/export records for <strong>at least 6 years</strong> after the end of the
          relevant fiscal year, physical or in an IRD-approved electronic format. HisabKitab keeps an
          append-only, audit-logged copy of every entry for exactly this reason.
        </p>
      </Section>

      {/* The user's explicit ask: explain how the agent works inside the VAT context */}
      <Section id="how-the-agent-works" title="How HisabKitab handles all of this">
        <p>
          You never touch a spreadsheet. The agent runs the full loop inside WhatsApp, and you stay
          the approver at every step:
        </p>
        <ol className="ml-5 list-decimal space-y-3">
          <li><strong>You send a bill.</strong> A photo, a PDF, or a line of text, whatever is fastest in the moment.</li>
          <li><strong>It reads and classifies.</strong> Vendor, date, amount, and VAT are extracted; the bill is checked against the 17 / 17Ka and one-year-window rules above.</li>
          <li><strong>It asks when unsure.</strong> If anything is ambiguous, like a smudged total or a borderline credit, it asks you or routes to an accountant. It never invents a number.</li>
          <li><strong>You approve.</strong> Nothing is saved to your books without your ✅. The entry is then written once, with an audit trail.</li>
          <li><strong>It prepares your return.</strong> Before the 25th it assembles the period&apos;s VAT, self-verifies the totals in integer paisa, and nudges you.</li>
          <li><strong>You review and file.</strong> You file on the IRD portal yourself. HisabKitab prepares; it never files on your behalf.</li>
        </ol>
        <p>
          What it takes from you: a WhatsApp number and a few seconds per bill. What it never does:
          guess a tax figure, save without approval, or file your return for you.
        </p>
      </Section>

      <p className="mx-auto mt-6 max-w-3xl text-sm text-muted">
        Sources: Inland Revenue Department (ird.gov.np), Value Added Tax Act 2052, and the Finance Act
        2081 provisions for FY 2082/83. Rules change with each annual budget, so verify current figures on
        the IRD portal before filing.
      </p>
    </PageShell>
  );
}
