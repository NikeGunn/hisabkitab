'use client';

import { motion, useInView, animate, useMotionValue, useTransform } from 'framer-motion';
import { useEffect, useRef } from 'react';

/**
 * A tablet showing the agent's WORK product — the live ledger/return dashboard the
 * agent maintains as it confirms entries. It sits behind/beside the phone so the
 * right side reads as "the financial agent, working": chat on the phone, the books
 * it keeps on the tablet. Numbers count up; the bar chart grows; all on scroll.
 */
const ease = [0.22, 1, 0.36, 1] as const;

function Counter({ to, prefix = '', className }: { to: number; prefix?: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => `${prefix}${Math.round(v).toLocaleString('en-IN')}`);
  useEffect(() => {
    if (inView) {
      const controls = animate(mv, to, { duration: 1.4, ease, delay: 0.3 });
      return controls.stop;
    }
  }, [inView, mv, to]);
  return <motion.span ref={ref} className={className}>{rounded}</motion.span>;
}

const BARS = [42, 58, 50, 72, 64, 88, 96];

export function TabletMock() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 50, rotate: 3 }}
      animate={inView ? { opacity: 1, y: 0, rotate: 0 } : {}}
      transition={{ duration: 0.9, ease, delay: 0.15 }}
      className="w-[420px] max-w-full"
    >
      <div className="rounded-[28px] border-[8px] border-ink/90 bg-ink shadow-device">
        <div className="overflow-hidden rounded-[20px] bg-surface">
          {/* app chrome */}
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 font-serif text-primary">हि</span>
              <p className="font-serif text-sm font-semibold">This month — Shrawan 2082</p>
            </div>
            <span className="pill !text-[10px]">Live</span>
          </div>

          <div className="grid grid-cols-3 gap-3 p-5">
            <Stat label="Sales" value={<Counter to={284500} prefix="Rs " />} tone="ink" delay={0.2} />
            <Stat label="Output VAT" value={<Counter to={36985} prefix="Rs " />} tone="primary" delay={0.3} />
            <Stat label="Net payable" value={<Counter to={21340} prefix="Rs " />} tone="accent" delay={0.4} />
          </div>

          {/* mini bar chart */}
          <div className="px-5 pb-3">
            <div className="flex items-end justify-between gap-2 rounded-card border border-hairline bg-cream/40 p-4">
              {BARS.map((h, i) => (
                <motion.div
                  key={i}
                  initial={{ height: 0, opacity: 0 }}
                  animate={inView ? { height: h, opacity: 1 } : {}}
                  transition={{ duration: 0.7, ease, delay: 0.5 + i * 0.08 }}
                  className="w-full rounded-t-md bg-gradient-to-t from-primary to-accent"
                  style={{ height: h }}
                />
              ))}
            </div>
          </div>

          {/* confirmed-entry row streaming in */}
          <div className="space-y-2 px-5 pb-5">
            {[
              { v: 'Everest Buildcon', a: 'Rs 9,040', t: 'confirmed' },
              { v: 'Momo sales x12', a: 'Rs 5,400', t: 'confirmed' },
            ].map((r, i) => (
              <motion.div
                key={r.v}
                initial={{ opacity: 0, x: 16 }}
                animate={inView ? { opacity: 1, x: 0 } : {}}
                transition={{ duration: 0.5, ease, delay: 0.9 + i * 0.15 }}
                className="flex items-center justify-between rounded-control border border-hairline bg-surface px-3 py-2"
              >
                <span className="text-[13px] text-ink">{r.v}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12px] font-semibold">{r.a}</span>
                  <span className="rounded-pill bg-primary/12 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">{r.t}</span>
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function Stat({ label, value, tone, delay }: { label: string; value: React.ReactNode; tone: 'ink' | 'primary' | 'accent'; delay: number }) {
  const ring = tone === 'primary' ? 'text-primary' : tone === 'accent' ? 'text-[#d99a00]' : 'text-ink';
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, ease, delay }}
      className="rounded-card border border-hairline bg-surface p-3"
    >
      <p className="label !text-[10px]">{label}</p>
      <p className={`mt-1 font-serif text-lg font-semibold ${ring}`}>{value}</p>
    </motion.div>
  );
}
