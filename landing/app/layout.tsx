import type { Metadata } from 'next';
import { Inter, Newsreader, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// A warm editorial serif for display moments + a clean grotesque for body:
// Newsreader (serif) + Inter (sans) + JetBrains Mono (metadata labels).
const serif = Newsreader({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-serif',
  display: 'swap',
});
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-mono', display: 'swap' });

const SITE = 'https://hisabkitab.pro';
const TITLE = 'HisabKitab · WhatsApp bookkeeping and VAT for Nepali businesses';
const DESCRIPTION =
  'Your pocket accountant on WhatsApp. Log a bill by photo, get VAT ready in seconds, and approve every entry before it is saved. Bookkeeping, VAT, and TDS for small VAT registered businesses in Nepal.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: '%s · HisabKitab' },
  description: DESCRIPTION,
  applicationName: 'HisabKitab',
  keywords: [
    'Nepal VAT software',
    'WhatsApp bookkeeping',
    'VAT return Nepal',
    'TDS Nepal',
    'IRD VAT',
    'small business accounting Nepal',
    'hisab kitab',
    'Khalti payments',
    'Nepali accountant app',
    'bookkeeping for SMB Nepal',
  ],
  authors: [{ name: 'HisabKitab' }],
  creator: 'HisabKitab',
  publisher: 'HisabKitab',
  alternates: { canonical: SITE },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  openGraph: {
    type: 'website',
    url: SITE,
    siteName: 'HisabKitab',
    title: TITLE,
    description: DESCRIPTION,
    locale: 'en_NP',
    images: [{ url: '/og.svg', width: 1200, height: 630, alt: 'HisabKitab, your pocket accountant on WhatsApp' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og.svg'],
  },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  category: 'finance',
};

// JSON-LD structured data: helps Google show a rich result and understand the
// product, organization, and FAQ from day one. Hoisted to module scope (static).
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE}/#org`,
      name: 'HisabKitab',
      url: SITE,
      logo: `${SITE}/icon.svg`,
      areaServed: 'NP',
      description: DESCRIPTION,
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#site`,
      url: SITE,
      name: 'HisabKitab',
      publisher: { '@id': `${SITE}/#org` },
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'HisabKitab',
      applicationCategory: 'FinanceApplication',
      operatingSystem: 'WhatsApp, Web',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'NPR', description: 'Free pilot' },
      description: DESCRIPTION,
      url: SITE,
    },
    {
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Does HisabKitab file my VAT return automatically?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. It prepares the numbers and shows its work. You review and file on the IRD portal yourself. It never files for you.',
          },
        },
        {
          '@type': 'Question',
          name: 'Do I need to install an app?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'No. HisabKitab works entirely inside WhatsApp. You send a photo or a line of text, and it does the rest.',
          },
        },
        {
          '@type': 'Question',
          name: 'How does it handle VAT for Nepal?',
          acceptedAnswer: {
            '@type': 'Answer',
            text: 'It computes 13% VAT in whole paisa using integer math, flags abbreviated (17Ka) and expired bills, and waits for your confirmation before saving any entry.',
          },
        },
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <script
          type="application/ld+json"
          // Structured data must be raw JSON in a script tag.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body className="bg-cream font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
