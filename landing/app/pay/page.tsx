import type { Metadata } from 'next';
import { PayDevClient } from './PayDevClient';

export const metadata: Metadata = {
  title: 'Pay with Khalti · HisabKitab (Development Preview)',
  description:
    'A preview of HisabKitab subscription payment via Khalti. This is a development environment. Live payments open when the servers go live.',
  alternates: { canonical: 'https://hisabkitab.pro/pay' },
  robots: { index: false, follow: true }, // do not index the dev payment preview
};

/**
 * Khalti payment page in DEVELOPMENT mode. It looks like the real thing but cannot
 * charge anyone: there is no API key in the client, no network call, and the button
 * is disabled with a clear "coming soon" notice. So it costs nothing and is safe to
 * ship publicly while the backend is not deployed.
 */
export default function PayPage() {
  return <PayDevClient />;
}
