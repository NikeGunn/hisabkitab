import type { MetadataRoute } from 'next';

export const dynamic = 'force-static'; // required with output: 'export'

const BASE = 'https://hisabkitab.pro';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE}/pay/`, lastModified: now, changeFrequency: 'monthly', priority: 0.5 },
  ];
}
