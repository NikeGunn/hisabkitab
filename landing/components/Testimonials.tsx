'use client';

/**
 * Two infinite marquees scrolling in OPPOSITE directions, pausing on hover. Pure
 * CSS keyframes (animate-marquee / animate-marquee-reverse), no JS on the scroll
 * hot path. The track is duplicated so the -50% translate loops seamlessly.
 *
 * These are scenario cards (what the product does in a real moment), NOT attributed
 * customer quotes. The product is in pilot, so we do not invent testimonials.
 */
type Scenario = { icon: string; title: string; body: string };

const ROW_A: Scenario[] = [
  { icon: '📸', title: 'Send a photo', body: 'You snap a supplier bill. It reads the VAT and waits for your OK. Your accountant only reviews at month end.' },
  { icon: '🛡️', title: 'Catches 17Ka bills', body: 'An abbreviated bill that is not valid for input credit is flagged, with the reason explained in plain language.' },
  { icon: '✅', title: 'Nothing without your yes', body: 'Every entry stays a draft until you confirm it. You stay in control of what goes on the books.' },
  { icon: '🔔', title: 'Monthly VAT reminder', body: 'Around the 20th BS it prepares the return and shows the net payable on one screen, ready for you to file.' },
];

const ROW_B: Scenario[] = [
  { icon: '🗣️', title: 'Replies in your language', body: 'It answers in Romanized Nepali, Devanagari, or English, matching how you wrote to it.' },
  { icon: '🔎', title: 'Asks when unsure', body: 'If a photo is blurry it asks for a clearer one instead of recording a number it is not sure about.' },
  { icon: '💳', title: 'Khalti, once verified', body: 'A Khalti payment is recorded only after a server side check confirms it, so there is no double entry.' },
  { icon: '🧮', title: 'Integer paisa math', body: 'VAT is computed in whole paisa with integer math, so the figures reconcile cleanly to the rupee.' },
];

function Card({ q }: { q: Scenario }) {
  return (
    <figure className="card mx-3 w-[340px] shrink-0 p-6">
      <figcaption className="mb-3 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-lg text-white">
          {q.icon}
        </span>
        <p className="font-serif text-sm font-semibold text-ink">{q.title}</p>
      </figcaption>
      <p className="text-[15px] leading-relaxed text-muted">{q.body}</p>
    </figure>
  );
}

function Marquee({ items, reverse }: { items: Scenario[]; reverse?: boolean }) {
  const track = [...items, ...items]; // duplicate for a seamless -50% loop
  return (
    <div className="group relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
      <div className={`flex shrink-0 ${reverse ? 'animate-marquee-reverse' : 'animate-marquee'} group-hover:[animation-play-state:paused]`}>
        {track.map((q, i) => (
          <Card key={`${q.title}-${i}`} q={q} />
        ))}
      </div>
    </div>
  );
}

export function Testimonials() {
  return (
    <section className="py-24">
      <div className="mx-auto mb-12 max-w-content px-6 text-center">
        <span className="label">Built for shopkeepers</span>
        <h2 className="display mt-3 text-[34px] sm:text-[42px]">Small businesses, big peace of mind</h2>
        <p className="mx-auto mt-4 max-w-xl text-muted">
          Here is what HisabKitab does in the moments that matter on a normal working day.
        </p>
      </div>
      <div className="space-y-5">
        <Marquee items={ROW_A} />
        <Marquee items={ROW_B} reverse />
      </div>
    </section>
  );
}
