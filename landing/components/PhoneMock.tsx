'use client';

import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';

/**
 * The hero focal object: a phone running a live HisabKitab WhatsApp thread.
 * The conversation plays the real product loop: photo, extraction, owner
 * confirms, then a confirmed entry in whole paisa, staggered in like a real chat.
 * Motion notes: masked reveal, staggered entrance, restrained easing, ambient
 * float behind.
 */

type Msg =
  | { side: 'in' | 'out'; kind: 'text'; text: string; time: string }
  | { side: 'out'; kind: 'photo'; time: string }
  | { side: 'in'; kind: 'extract'; time: string }
  | { side: 'in'; kind: 'saved'; time: string };

const THREAD: Msg[] = [
  { side: 'out', kind: 'photo', time: '10:02' },
  { side: 'in', kind: 'extract', time: '10:02' },
  { side: 'out', kind: 'text', text: 'Yes, that’s right ✅', time: '10:03' },
  { side: 'in', kind: 'saved', time: '10:03' },
];

const ease = [0.22, 1, 0.36, 1] as const;

function Bubble({ children, side, delay }: { children: React.ReactNode; side: 'in' | 'out'; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.96 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '-10% 0px' }}
      transition={{ duration: 0.5, ease, delay }}
      className={`flex ${side === 'out' ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={`max-w-[78%] rounded-2xl px-3 py-2 text-[13px] leading-snug shadow-sm ${
          side === 'out' ? 'rounded-br-sm bg-wa-out text-ink' : 'rounded-bl-sm bg-wa-in text-ink'
        }`}
      >
        {children}
      </div>
    </motion.div>
  );
}

function Time({ t, light }: { t: string; light?: boolean }) {
  return <span className={`ml-2 align-bottom text-[10px] ${light ? 'text-white/70' : 'text-muted/70'}`}>{t}</span>;
}

export function PhoneMock() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });

  return (
    <div ref={ref} className="relative mx-auto w-[300px] sm:w-[330px]">
      {/* ambient glow + float */}
      <div className="pointer-events-none absolute -inset-10 -z-10 rounded-[48px] bg-primary/20 blur-3xl" />
      <motion.div
        initial={{ opacity: 0, y: 40, rotate: -2 }}
        animate={inView ? { opacity: 1, y: 0, rotate: 0 } : {}}
        transition={{ duration: 0.8, ease }}
        className="animate-float"
      >
        {/* device frame */}
        <div className="rounded-[40px] border-[10px] border-ink/90 bg-ink shadow-device">
          <div className="relative overflow-hidden rounded-[30px] bg-wa-bg">
            {/* notch */}
            <div className="absolute left-1/2 top-0 z-20 h-6 w-32 -translate-x-1/2 rounded-b-2xl bg-ink" />
            {/* WhatsApp header */}
            <div className="flex items-center gap-3 bg-wa-header px-4 pb-3 pt-7 text-white">
              <div className="grid h-9 w-9 place-items-center rounded-full bg-white/15 font-serif text-lg">हि</div>
              <div className="leading-tight">
                <p className="text-sm font-semibold">HisabKitab</p>
                <p className="text-[11px] text-white/70">online · your accountant</p>
              </div>
            </div>

            {/* chat body */}
            <div
              className="space-y-2 px-3 py-4"
              style={{
                backgroundImage:
                  'radial-gradient(rgba(17,24,39,0.04) 1px, transparent 1px)',
                backgroundSize: '16px 16px',
                minHeight: 420,
              }}
            >
              {THREAD.map((m, i) => {
                const delay = 0.3 + i * 0.7;
                if (m.kind === 'photo') {
                  return (
                    <Bubble key={i} side="out" delay={delay}>
                      <div className="overflow-hidden rounded-lg">
                        <BillThumb />
                      </div>
                      <div className="mt-1 text-right">
                        <Time t={m.time} /> <span className="text-wa-tick">✓✓</span>
                      </div>
                    </Bubble>
                  );
                }
                if (m.kind === 'extract') {
                  return (
                    <Bubble key={i} side="in" delay={delay}>
                      <p className="font-medium">I read this bill 👇 please check:</p>
                      <div className="mt-1.5 space-y-0.5 font-mono text-[11px] text-muted">
                        <Row k="Vendor" v="Everest Buildcon" />
                        <Row k="Taxable" v="Rs 8,000.00" />
                        <Row k="VAT 13%" v="Rs 1,040.00" />
                        <Row k="Total" v="Rs 9,040.00" strong />
                      </div>
                      <p className="mt-1.5 text-[12px]">Shall I save it? Reply <b>yes</b> to confirm.</p>
                      <div className="text-right"><Time t={m.time} /></div>
                    </Bubble>
                  );
                }
                if (m.kind === 'saved') {
                  return (
                    <Bubble key={i} side="in" delay={delay}>
                      <div className="flex items-center gap-2">
                        <span className="grid h-5 w-5 place-items-center rounded-full bg-primary/15 text-primary">✓</span>
                        <p className="font-medium">Saved. Entry #1042 confirmed.</p>
                      </div>
                      <p className="mt-1 text-[12px] text-muted">Input VAT Rs 1,040 added to this month’s return.</p>
                      <div className="text-right"><Time t={m.time} /></div>
                    </Bubble>
                  );
                }
                return (
                  <Bubble key={i} side="out" delay={delay}>
                    {m.text}
                    <Time t={m.time} /> <span className="text-wa-tick">✓✓</span>
                  </Bubble>
                );
              })}

              {/* typing dots before the first agent reply, fades out */}
              <motion.div
                initial={{ opacity: 0 }}
                whileInView={{ opacity: [0, 1, 1, 0] }}
                viewport={{ once: true }}
                transition={{ duration: 1, times: [0, 0.2, 0.8, 1], delay: 0.7 }}
                className="flex justify-start"
              >
                <div className="flex gap-1 rounded-2xl rounded-bl-sm bg-wa-in px-3 py-2.5 shadow-sm">
                  {[0, 1, 2].map((d) => (
                    <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/50" style={{ animationDelay: `${d * 0.15}s` }} />
                  ))}
                </div>
              </motion.div>
            </div>

            {/* input bar */}
            <div className="flex items-center gap-2 bg-wa-bg px-3 py-2">
              <div className="flex-1 rounded-pill bg-white px-3 py-2 text-[12px] text-muted">Message</div>
              <div className="grid h-9 w-9 place-items-center rounded-full bg-wa-header text-white">➤</div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* floating proof chips */}
      <FloatingChip className="-left-10 top-24" delay={1.2} label="No guessing" sub="asks if unsure" />
      <FloatingChip className="-right-12 bottom-28" delay={1.5} label="Exact paisa" sub="bigint, never floats" />
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{k}</span>
      <span className={strong ? 'font-semibold text-ink' : ''}>{v}</span>
    </div>
  );
}

function FloatingChip({ className, label, sub, delay }: { className: string; label: string; sub: string; delay: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: 10 }}
      whileInView={{ opacity: 1, scale: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, ease, delay }}
      className={`absolute z-20 hidden rounded-card border border-hairline bg-surface px-3 py-2 shadow-card sm:block ${className}`}
    >
      <p className="font-mono text-[11px] font-semibold uppercase tracking-wide text-primary">{label}</p>
      <p className="text-[11px] text-muted">{sub}</p>
    </motion.div>
  );
}

/** A tiny stylized "bill photo" (SVG, no asset needed). */
function BillThumb() {
  return (
    <svg viewBox="0 0 160 110" className="h-28 w-44" role="img" aria-label="Photo of a VAT bill">
      <rect width="160" height="110" fill="#EFE7D6" />
      <rect x="22" y="14" width="116" height="82" rx="3" fill="#fff" stroke="#E5E7EB" />
      <rect x="32" y="24" width="56" height="6" rx="3" fill="#111827" />
      <rect x="32" y="38" width="96" height="4" rx="2" fill="#9CA3AF" />
      <rect x="32" y="48" width="96" height="4" rx="2" fill="#9CA3AF" />
      <rect x="32" y="58" width="70" height="4" rx="2" fill="#9CA3AF" />
      <rect x="32" y="74" width="40" height="8" rx="2" fill="#F68B1F" />
      <rect x="96" y="73" width="32" height="9" rx="2" fill="#111827" />
    </svg>
  );
}
