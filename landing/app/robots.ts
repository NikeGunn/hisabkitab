import type { MetadataRoute } from 'next';

export const dynamic = 'force-static'; // required with output: 'export'

/** Allow everything except the dev payment preview; point crawlers at the sitemap. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: '/pay/' },
    sitemap: 'https://hisabkitab.pro/sitemap.xml',
    host: 'https://hisabkitab.pro',
  };
}
