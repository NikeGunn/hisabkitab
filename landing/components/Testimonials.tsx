'use client';

/**
 * Two infinite marquees scrolling in OPPOSITE directions (left→right and
 * right→left), pausing on hover. Pure CSS keyframes (animate-marquee /
 * animate-marquee-reverse) — no JS on the scroll hot path. The track is
 * duplicated so the -50% translate loops seamlessly.
 */
type Quote = { name: string; role: string; town: string; quote: string };

const ROW_A: Quote[] = [
  { name: 'Sita Karki', role: 'Owner, Karki Café', town: 'Lalitpur', quote: 'I just send a photo of the bill. It does the VAT and waits for my OK. My accountant only checks at month-end now.' },
  { name: 'Ram Thapa', role: 'Thapa Suppliers', town: 'Bhaktapur', quote: 'It caught an abbreviated bill I’d have wrongly claimed. It said “not valid for input credit” and explained why.' },
  { name: 'Anjana Shrestha', role: 'Newa Kitchen', town: 'Kathmandu', quote: 'Nothing gets saved unless I say yes. That’s exactly how I want my books handled.' },
  { name: 'Bikash Gurung', role: 'Gurung Hardware', town: 'Pokhara', quote: 'The monthly reminder shows my net payable on one screen. I file on the IRD portal myself in two minutes.' },
];

const ROW_B: Quote[] = [
  { name: 'Pratima Rai', role: 'Rai Boutique', town: 'Dharan', quote: 'It writes in Romanized Nepali back to me. Feels like texting a careful accountant, not a robot.' },
  { name: 'Suresh Adhikari', role: 'Adhikari Traders', town: 'Butwal', quote: 'When a photo was blurry it asked for a clearer one instead of guessing a number. That trust matters.' },
  { name: 'Maya Tamang', role: 'Tamang Tea House', town: 'Kathmandu', quote: 'Khalti payments get recorded automatically once verified. No double entry, no mistakes.' },
  { name: 'Deepak Joshi', role: 'Joshi Electronics', town: 'Biratnagar', quote: 'Exact paisa, every time. I checked against my old ledger — it reconciled to the rupee.' },
];

function Card({ q }: { q: Quote }) {
  return (
    <figure className="card mx-3 w-[340px] shrink-0 p-6">
      <figcaption className="mb-3 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-primary to-accent font-serif text-white">
          {q.name[0]}
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">{q.name}</p>
          <p className="font-mono text-[11px] uppercase tracking-wide text-muted">{q.role} · {q.town}</p>
        </div>
      </figcaption>
      <blockquote className="text-[15px] leading-relaxed text-muted">“{q.quote}”</blockquote>
    </figure>
  );
}

function Marquee({ items, reverse }: { items: Quote[]; reverse?: boolean }) {
  const track = [...items, ...items]; // duplicate for a seamless -50% loop
  return (
    <div className="group relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
      <div className={`flex shrink-0 ${reverse ? 'animate-marquee-reverse' : 'animate-marquee'} group-hover:[animation-play-state:paused]`}>
        {track.map((q, i) => (
          <Card key={`${q.name}-${i}`} q={q} />
        ))}
      </div>
    </div>
  );
}

export function Testimonials() {
  return (
    <section className="py-24">
      <div className="mx-auto mb-12 max-w-content px-6 text-center">
        <span className="label">Loved by shopkeepers</span>
        <h2 className="display mt-3 text-[34px] sm:text-[42px]">Small businesses, big peace of mind</h2>
        <p className="mx-auto mt-4 max-w-xl text-muted">
          Owners across Nepal keep their books on WhatsApp — and approve every single entry.
        </p>
      </div>
      <div className="space-y-5">
        <Marquee items={ROW_A} />
        <Marquee items={ROW_B} reverse />
      </div>
    </section>
  );
}
