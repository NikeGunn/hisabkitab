/**
 * Footer per design.md — multi-column navigation (Platform / Company / Resources
 * / Connect) + legal pathways. Static (server component, no client JS).
 */
const COLUMNS: { title: string; links: string[] }[] = [
  { title: 'Platform', links: ['Bill extraction', 'VAT & TDS', 'Payments', 'Reports', 'Reminders'] },
  { title: 'Company', links: ['About', 'Pilot program', 'Careers', 'Press'] },
  { title: 'Resources', links: ['How it works', 'Nepal VAT guide', 'Security', 'Status'] },
  { title: 'Connect', links: ['WhatsApp', 'Email', 'Twitter / X', 'LinkedIn'] },
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
              Hisab-kitab is the everyday Nepali phrase for keeping the books. That is exactly — and
              only — what this agent does.
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
                  <li key={l}>
                    <a href="#" className="text-sm text-muted transition-colors hover:text-ink">{l}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-hairline pt-7 text-sm text-muted sm:flex-row">
          <p>© {new Date().getFullYear()} HisabKitab. Made in Nepal 🇳🇵</p>
          <div className="flex gap-6">
            <a href="#" className="transition-colors hover:text-ink">Privacy</a>
            <a href="#" className="transition-colors hover:text-ink">Terms</a>
            <a href="#" className="transition-colors hover:text-ink">Data deletion</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
