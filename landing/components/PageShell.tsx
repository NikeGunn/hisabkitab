import type { ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';

/**
 * Shared chrome for every content (footer) page: the floating nav, a consistent
 * editorial header band, a readable prose column, and the site footer. Keeping
 * this in one place is what lets a dozen pages stay visually identical without
 * repeating markup — change the band here and every doc page follows.
 */
export function PageShell({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Nav />
      <main className="pt-28 sm:pt-32">
        <header className="mx-auto flex max-w-3xl flex-col items-center px-6 text-center">
          <a href="/" className="label transition-colors hover:text-ink">← Back to home</a>
          <span className="label mt-8 block">{eyebrow}</span>
          <h1 className="display mt-3 text-[34px] sm:text-[48px]">{title}</h1>
          {lede ? (
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">{lede}</p>
          ) : null}
        </header>
        <div className="mx-auto mt-14 max-w-content px-6 pb-24">{children}</div>
      </main>
      <Footer />
    </>
  );
}

/** A titled prose block — the workhorse of every doc page. */
export function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mx-auto max-w-3xl scroll-mt-28 border-t border-hairline py-10 first:border-t-0 first:pt-0">
      {title ? <h2 className="display text-2xl sm:text-[28px]">{title}</h2> : null}
      {/* Body prose is LEFT-aligned for readability — only the page header band is
          centered. Centered long-form text is hard to read and looks off. */}
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted [&_strong]:text-ink">
        {children}
      </div>
    </section>
  );
}

/** Definition-style card grid for feature/spec lists. */
export function CardGrid({ items }: { items: { title: string; body: string; emoji?: string }[] }) {
  return (
    <div className="grid gap-5 first:mt-6 sm:grid-cols-2">
      {items.map((it) => (
        <div key={it.title} className="card p-6">
          {it.emoji ? (
            <span className="mb-3 grid h-11 w-11 place-items-center rounded-card bg-cream text-xl">
              {it.emoji}
            </span>
          ) : null}
          <h3 className="font-serif text-lg font-semibold text-ink">{it.title}</h3>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">{it.body}</p>
        </div>
      ))}
    </div>
  );
}
