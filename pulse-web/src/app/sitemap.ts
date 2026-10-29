import type { MetadataRoute } from 'next';

const BASE = 'https://sigmaseller.ru';
const lastModified = new Date();

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${BASE}/`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1.0,
    },
    {
      url: `${BASE}/legal/terms`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.4,
    },
    {
      url: `${BASE}/legal/privacy`,
      lastModified,
      changeFrequency: 'monthly',
      priority: 0.4,
    },
  ];
}
