import type { Metadata } from 'next';
import { Inter, Newsreader, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// anthropic.com leans on a warm editorial serif for display + a clean grotesque
// for body. Newsreader (serif) + Inter (sans) + JetBrains Mono (labels) gets that
// tone while honoring the design.md mono-for-metadata direction.
const serif = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-serif',
  display: 'swap',
});
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'HisabKitab — your pocket accountant on WhatsApp',
  description:
    'Log a bill by photo or voice. Get VAT-ready in seconds. You approve every entry — it never guesses. WhatsApp-first bookkeeping & tax for small VAT-registered businesses in Nepal.',
  metadataBase: new URL('https://hisabkitab.example'),
  openGraph: {
    title: 'HisabKitab — your pocket accountant on WhatsApp',
    description: 'Log a bill by photo. Get VAT-ready in seconds. You approve every entry — it never guesses.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body className="bg-cream font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
