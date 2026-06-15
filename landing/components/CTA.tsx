'use client';

import { motion } from 'framer-motion';

export function CTA() {
  return (
    <section id="start" className="px-6 py-24">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        className="relative mx-auto max-w-content overflow-hidden rounded-[28px] bg-ink px-8 py-16 text-center text-white sm:px-16"
      >
        {/* ambient orange glow */}
        <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-primary/30 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-10 h-72 w-72 rounded-full bg-accent/20 blur-3xl" />
        <span className="label !text-accent">Ready when you are</span>
        <h2 className="display mx-auto mt-4 max-w-2xl text-[36px] text-white sm:text-[48px]">
          Keep your books on WhatsApp, and approve every entry.
        </h2>
        <p className="mx-auto mt-5 max-w-lg text-white/70">
          No app to install. No portal logins. Send a bill, review the figures, and tap to confirm.
          Every entry waits for your approval before it is saved.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a href="#" className="btn-primary !bg-primary">Start on WhatsApp →</a>
          <a href="#how" className="rounded-control border border-white/20 px-6 py-3 font-medium text-white transition-colors hover:bg-white/10">
            See how it works
          </a>
        </div>
        <p className="mt-6 font-mono text-[11px] uppercase tracking-widest text-white/40">
          Made in Nepal · नेपालका लागि
        </p>
      </motion.div>
    </section>
  );
}
