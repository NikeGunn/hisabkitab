/**
 * "Registered in Nepal" card: the company that builds HisabKitab and collects
 * subscription payments in Nepal. Styled as a seal plus registry-chip row, the way
 * a Nepali company certificate reads. Static server component, no client JS.
 */
import { NEPAL_COMPANY } from './legal-entity';

function Seal() {
  return (
    <svg viewBox="0 0 64 64" className="h-14 w-14 shrink-0" role="img" aria-label="Registered company seal">
      <defs>
        <path id="seal-ring" d="M32 32 m-23 0 a23 23 0 1 1 46 0 a23 23 0 1 1 -46 0" />
      </defs>
      <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2.6" />
      <circle cx="32" cy="32" r="18" fill="currentColor" opacity="0.1" />
      <text fontSize="6.4" fontWeight="700" letterSpacing="1.6" fill="currentColor">
        <textPath href="#seal-ring">REGISTERED IN NEPAL • REGISTERED IN NEPAL •</textPath>
      </text>
      <text x="32" y="37" textAnchor="middle" fontSize="14" fontWeight="700" fill="currentColor" fontFamily="serif">
        प्रा.लि.
      </text>
    </svg>
  );
}

const CHIPS: { label: string; value: string }[] = [
  { label: 'Company Reg. No.', value: NEPAL_COMPANY.registrationNo },
  { label: 'PAN', value: NEPAL_COMPANY.pan },
  { label: 'Incorporated', value: NEPAL_COMPANY.incorporated },
  { label: 'Based in', value: NEPAL_COMPANY.city },
];

export function NepalCompanyCard({ compact = false }: { compact?: boolean }) {
  return (
    <section
      aria-label="Company registered in Nepal"
      className="relative overflow-hidden rounded-xl border border-hairline bg-white/70 px-5 py-5 text-sm"
    >
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/10 blur-2xl" />
      <div className="flex items-start gap-4">
        <span className="text-primary">
          <Seal />
        </span>
        <div className="min-w-0">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">
            Built in Nepal by
          </p>
          <p className="mt-1 font-serif text-lg font-semibold leading-snug text-ink">{NEPAL_COMPANY.name}</p>
          <p className="mt-0.5 text-muted" lang="ne">
            {NEPAL_COMPANY.nameNe}
          </p>
          {!compact ? (
            <p className="mt-2 max-w-2xl leading-relaxed text-muted">
              The private limited company that develops HisabKitab, registered with the {NEPAL_COMPANY.registrar}. Subscription
              payments made in Nepal (via Khalti) are received by this company.
            </p>
          ) : null}
        </div>
      </div>
      <dl className="mt-4 flex flex-wrap gap-2">
        {CHIPS.map((c) => (
          <div key={c.label} className="rounded-pill border border-hairline bg-surface px-3 py-1">
            <dt className="sr-only">{c.label}</dt>
            <dd className="text-[12.5px] text-ink">
              <span className="text-muted">{c.label}: </span>
              {c.value}
            </dd>
          </div>
        ))}
        <div className="rounded-pill border border-hairline bg-surface px-3 py-1">
          <dt className="sr-only">Contact</dt>
          <dd className="text-[12.5px]">
            <a href={NEPAL_COMPANY.phoneHref} className="text-ink transition-colors hover:text-primary">
              {NEPAL_COMPANY.phone}
            </a>
          </dd>
        </div>
      </dl>
    </section>
  );
}
