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

export function Footer() {
  return (
    <footer id="trust" className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-content px-6 py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent font-serif text-white">हि</span>
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

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-hairline pt-7 text-sm text-muted sm:flex-row">
          <div className="text-center sm:text-left">
            <p>© {new Date().getFullYear()} {LEGAL_ENTITY.name}. HisabKitab is a product of {LEGAL_ENTITY.name}. Made in Nepal 🇳🇵</p>
            <p className="mt-1 text-xs">
              Company Reg. No. {LEGAL_ENTITY.registrationNo} · {LEGAL_ENTITY.address} ·{' '}
              <a href={LEGAL_ENTITY.phoneHref} className="hover:text-ink">{LEGAL_ENTITY.phone}</a> ·{' '}
              <a href={`mailto:${LEGAL_ENTITY.email}`} className="hover:text-ink">{LEGAL_ENTITY.email}</a>
            </p>
          </div>
          <div className="flex gap-6">
            <a href="/privacy" className="transition-colors hover:text-ink">Privacy</a>
            <a href="/terms" className="transition-colors hover:text-ink">Terms</a>
            <a href="/data-deletion" className="transition-colors hover:text-ink">Data deletion</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
