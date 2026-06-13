# HisabKitab — landing page

Next.js 15 (App Router) + Tailwind + Framer Motion. Warm orange/cream palette from
`docs/nexus-global-transfers-5-DESIGN.md`, anthropic.com-style serif display
(Newsreader) + Inter body + JetBrains Mono labels.

## Sections
- **Hero** — the smart agent *working*: a live WhatsApp thread on a phone (bill →
  extraction → owner ✅ → confirmed entry) with a tablet dashboard behind it
  (counting numbers, growing chart). Staggered Framer Motion, ambient float.
- **How it works** — the 4-step careful loop + the safety strip.
- **Who it’s for** — psychologically-targeted persona cards (pain → relief).
- **Features** — bento grid of agent capabilities.
- **Testimonials** — two infinite marquees scrolling opposite directions, pause on hover.
- **CTA + Footer** — multi-column footer per the design spec.

## Run it

```sh
cd landing
pnpm install --ignore-workspace   # first time only (own lockfile)
pnpm dev                          # http://localhost:3000
pnpm build && pnpm start          # production
```

Or from the repo root, run the **whole stack** (landing + all backend services):

```sh
pnpm dev          # landing + ledger MCP + payments MCP + webhook, color-coded
pnpm dev:landing  # just the landing page
pnpm dev:backend  # just the three backend services
```

## Deploy (Vercel)
Set the **Root Directory** to `landing` in the Vercel project settings; framework
preset = Next.js. No env vars needed for the marketing site.
