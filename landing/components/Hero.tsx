'use client';

import { motion } from 'framer-motion';
import { PhoneMock } from './PhoneMock';
import { TabletMock } from './TabletMock';

const ease = [0.22, 1, 0.36, 1] as const;

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1, delayChildren: 0.1 } },
};
const rise = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease } },
};

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pb-24 pt-28 sm:pt-32">
      <div className="mx-auto grid max-w-content items-center gap-16 lg:grid-cols-[1fr_1.05fr]">
        {/* ---- left: the promise ---- */}
        <motion.div variants={stagger} initial="hidden" animate="show" className="relative z-10">
          <motion.span variants={rise} className="pill mb-6">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" /> WhatsApp-first · Nepal VAT &amp; TDS
          </motion.span>

          <motion.h1 variants={rise} className="display text-[44px] sm:text-[58px]">
            Your smart accountant,{' '}
            <span className="relative whitespace-nowrap text-primary">
              inside WhatsApp
              <Underline />
            </span>
          </motion.h1>

          <motion.p variants={rise} className="mt-6 max-w-md text-lg leading-relaxed text-muted">
            Snap a bill. It reads the vendor, the taxable amount, and the 13% VAT in paisa, then shows
            its work and waits for your <b className="text-ink">✅</b> before saving. When something is
            unclear, it <b className="text-ink">asks instead of assuming</b>.
          </motion.p>

          <motion.div variants={rise} className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#start" className="btn-primary">
              Start on WhatsApp
              <span aria-hidden>→</span>
            </a>
            <a href="#how" className="btn-ghost">See how it works</a>
          </motion.div>

          <motion.dl variants={rise} className="mt-10 grid max-w-sm grid-cols-3 gap-6">
            {[
              ['100%', 'owner-confirmed'],
              ['13%', 'VAT, exact paisa'],
              ['0', 'logins required'],
            ].map(([n, l]) => (
              <div key={l}>
                <dt className="font-serif text-2xl font-semibold text-ink">{n}</dt>
                <dd className="label mt-1 normal-case tracking-normal">{l}</dd>
              </div>
            ))}
          </motion.dl>
        </motion.div>

        {/* ---- right: the agent, working (tablet behind + phone in front) ---- */}
        <div className="relative mx-auto flex min-h-[560px] w-full items-center justify-center">
          <div className="absolute right-0 top-6 hidden -rotate-3 lg:block">
            <TabletMock />
          </div>
          <div className="relative z-10 lg:-translate-x-16 lg:translate-y-8">
            <PhoneMock />
          </div>
          {/* "agent thinking" caption */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.8, duration: 0.6 }}
            className="absolute bottom-0 left-1/2 z-20 -translate-x-1/2 rounded-pill border border-hairline bg-surface/90 px-4 py-2 font-mono text-[11px] text-muted shadow-card backdrop-blur"
          >
            <span className="mr-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            agent: extracted → validated → awaiting your ✅
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function Underline() {
  return (
    <svg className="absolute -bottom-2 left-0 w-full" height="10" viewBox="0 0 300 10" fill="none" aria-hidden>
      <motion.path
        d="M2 7C60 3 120 3 180 5C220 6 260 6 298 4"
        stroke="#FDB813"
        strokeWidth="4"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1, ease, delay: 0.6 }}
      />
    </svg>
  );
}
