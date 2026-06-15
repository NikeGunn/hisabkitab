import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export so the site is served by GitHub Pages (no Node server needed).
  output: 'export',
  // Pages serves a plain bucket: emit /pay/index.html style folders and
  // unoptimized images (the Next image optimizer needs a running server).
  trailingSlash: true,
  images: { unoptimized: true },
  // This app has its own lockfile; pin the trace root so Next doesn't walk up to
  // the monorepo root (silences the multiple-lockfiles warning).
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
};

export default nextConfig;
