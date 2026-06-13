'use client';

import { motion } from 'framer-motion';

export function Nav() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50"
    >
      <nav className="mx-auto mt-4 flex max-w-content items-center justify-between rounded-pill border border-hairline bg-surface/80 px-4 py-2.5 shadow-card backdrop-blur-md sm:px-5">
        <a href="#" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent font-serif text-white">हि</span>
          <span className="font-serif text-lg font-semibold">HisabKitab</span>
        </a>
        <div className="hidden items-center gap-7 text-sm text-muted md:flex">
          <a href="#how" className="transition-colors hover:text-ink">How it works</a>
          <a href="#who" className="transition-colors hover:text-ink">Who it’s for</a>
          <a href="#features" className="transition-colors hover:text-ink">Features</a>
          <a href="#trust" className="transition-colors hover:text-ink">Trust</a>
        </div>
        <a href="#start" className="btn-primary !px-4 !py-2 text-sm">Start free</a>
      </nav>
    </motion.header>
  );
}
