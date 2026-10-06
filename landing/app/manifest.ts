import type { MetadataRoute } from 'next';

export const dynamic = 'force-static'; // required with output: 'export'

/** PWA manifest: improves mobile install + search engine app signals. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'HisabKitab',
    short_name: 'HisabKitab',
    description: 'Your pocket accountant on WhatsApp. VAT and TDS bookkeeping for Nepali businesses.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F2EAD3',
    theme_color: '#F68B1F',
    lang: 'en',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
