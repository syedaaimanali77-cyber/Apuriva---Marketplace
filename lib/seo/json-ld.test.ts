import { describe, expect, it } from 'vitest';
import { breadcrumbList, serializeJsonLd, serviceJsonLd } from './json-ld';

describe('JSON-LD (spec 044 §3.9, AC-5)', () => {
  it('BreadcrumbList numbers its items from 1 in order', () => {
    expect(
      breadcrumbList([
        { name: 'Explore services', url: 'https://a.example/explore' },
        { name: 'Cleaning', url: 'https://a.example/explore/c1' },
      ]),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Explore services', item: 'https://a.example/explore' },
        { '@type': 'ListItem', position: 2, name: 'Cleaning', item: 'https://a.example/explore/c1' },
      ],
    });
  });

  it('Service is provided by the platform Organization, typed by its category, with no rating or offer', () => {
    const data = serviceJsonLd({ name: 'Deep clean', description: 'd', categoryName: 'Cleaning', url: 'https://a.example/explore/c1/s1', providerName: 'APURIVA' });
    expect(data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Service',
      name: 'Deep clean',
      description: 'd',
      serviceType: 'Cleaning',
      url: 'https://a.example/explore/c1/s1',
      provider: { '@type': 'Organization', name: 'APURIVA' },
    });
    expect(data).not.toHaveProperty('aggregateRating');
    expect(data).not.toHaveProperty('offers');
  });

  it('serializes for an inline script without letting authored text close the tag', () => {
    const out = serializeJsonLd({ name: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});
