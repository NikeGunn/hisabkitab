/**
 * Footer: multi column navigation (Platform / Company / Resources / Connect)
 * plus legal pathways. Static (server component, no client JS).
 */
import { LEGAL_ENTITY } from './legal-entity';

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Platform',
    links: [
      { label: 'Bill extraction', href: '/platform#bill-extraction' },
      { label: 'VAT & TDS', href: '/platform#vat-tds' },
      { label: 'Payments', href: '/platform#payments' },
      { label: 'Reports', href: '/platform#reports' },
      { label: 'Reminders', href: '/platform#reminders' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Pilot program', href: '/pilot' },
      { label: 'Careers', href: '/careers' },
      { label: 'Press', href: '/press' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'How it works', href: '/how-it-works' },
      { label: 'Nepal VAT guide', href: '/vat-guide' },
      { label: 'Security', href: '/security' },
      { label: 'Status', href: '/status' },
    ],
  },
  {
    title: 'Connect',
    links: [
      { label: 'WhatsApp', href: '/#start' },
      { label: 'Email', href: 'mailto:hello@hisabkitab.pro' },
      { label: 'Twitter / X', href: 'https://x.com/hisabkitab' },
      { label: 'LinkedIn', href: 'https://www.linkedin.com/company/hisabkitab' },
    ],
  },
];

const LEGAL_FACTS: { label: string; value: string; href?: string }[] = [
  { label: 'Phone', value: LEGAL_ENTITY.phone, href: LEGAL_ENTITY.phoneHref },
  { label: 'Email', value: LEGAL_ENTITY.email, href: `mailto:${LEGAL_ENTITY.email}` },
];

/** Inline flag: the 🇳🇵 emoji renders as letters "NP" on Windows. */
function NepalFlag() {
  return (
    <svg viewBox="0 0 40 49" className="h-4 w-auto" role="img" aria-label="Nepal flag">
      <path d="M1 1 L37 22 H14 L37 48 H1 Z" fill="#DC143C" stroke="#003893" strokeWidth="2.5" strokeLinejoin="miter" />
      <circle cx="11" cy="15" r="3.2" fill="#fff" />
      <circle cx="11" cy="37" r="4.2" fill="#fff" />
    </svg>
  );
}

export function Footer() {
  return (
    <footer id="trust" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-content px-6 py-16">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-4 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div className="col-span-2 sm:col-span-4 lg:col-span-1">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-linear-to-br from-primary to-accent font-serif text-white">हि</span>
              <span className="font-serif text-xl font-semibold">HisabKitab</span>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted">
              Hisab-kitab is the everyday Nepali phrase for keeping the books. That is exactly, and
              only, what this product does.
            </p>
            <p className="mt-5 font-mono text-[11px] uppercase tracking-widest text-muted">
              Nothing saved without your ✅
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="label">{col.title}</p>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <a href={l.href} className="text-sm text-muted transition-colors hover:text-ink">{l.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 border-t border-hairline pt-8">
          <div className="flex flex-col gap-4 text-sm text-muted md:flex-row md:items-center md:justify-between">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>© {new Date().getFullYear()} HisabKitab.</span>
            </p>
            <nav aria-label="Legal" className="flex shrink-0 gap-6 whitespace-nowrap">
              <a href="/privacy" className="transition-colors hover:text-ink">Privacy</a>
              <a href="/terms" className="transition-colors hover:text-ink">Terms</a>
              <a href="/data-deletion" className="transition-colors hover:text-ink">Data deletion</a>
            </nav>
          </div>

          <dl className="mt-6 grid gap-x-8 gap-y-4 rounded-xl border border-hairline bg-white/60 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-[auto_auto]">
            {LEGAL_FACTS.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">{f.label}</dt>
                <dd className="mt-1 text-ink">
                  {f.href ? (
                    <a href={f.href} className="transition-colors hover:text-primary">{f.value}</a>
                  ) : (
                    f.value
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-6 flex items-center gap-2 text-xs text-muted">
            <NepalFlag />
            Proudly built in Nepal, for Nepal&apos;s businesses
          </p>
        </div>
      </div>
    </footer>
  );
}
