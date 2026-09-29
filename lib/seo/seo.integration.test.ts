import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';
import { branding } from '@/lib/config/branding';
import { getDb } from '@/lib/db';
import { en } from '@/lib/i18n/dictionaries/en';
import { categorySeo, exploreSeo, serviceSeo } from './catalog-metadata';

/**
 * Spec 044 §3.8/§3.9 (AC-5, AC-6) against the isolated `*_test` database: the sitemap lists exactly the
 * published catalog, robots.txt, and the catalog pages' metadata and JSON-LD for published, unpublished,
 * unknown and malformed entities.
 */
const SITE = 'https://apuriva.example';

async function insertCategory(status: string): Promise<{ id: string; name: string }> {
  const name = `SEO Category ${randomUUID().slice(0, 8)}`;
  const rows = (await getDb().execute(sql`INSERT INTO categories (name, slug, status) VALUES (${name}, ${`seo-${randomUUID()}`}, ${status}) RETURNING id, name`))
    .rows as Array<{ id: string; name: string }>;
  return rows[0]!;
}

async function insertService(categoryId: string, status: string): Promise<{ id: string; name: string }> {
  const name = `SEO Service ${randomUUID().slice(0, 8)}`;
  const rows = (
    await getDb().execute(sql`INSERT INTO services (category_id, name, slug, status) VALUES (${categoryId}, ${name}, ${`seo-${randomUUID()}`}, ${status}) RETURNING id, name`)
  ).rows as Array<{ id: string; name: string }>;
  return rows[0]!;
}

let published: { id: string; name: string };
let draftCategory: { id: string; name: string };
let retiredCategory: { id: string; name: string };
let liveService: { id: string; name: string };
let draftService: { id: string; name: string };
let retiredService: { id: string; name: string };
let orphanService: { id: string; name: string };

beforeAll(async () => {
  published = await insertCategory('published');
  draftCategory = await insertCategory('draft');
  retiredCategory = await insertCategory('retired');
  liveService = await insertService(published.id, 'published');
  draftService = await insertService(published.id, 'draft');
  retiredService = await insertService(published.id, 'retired');
  // Published, but its category is not: it has no reachable public page.
  orphanService = await insertService(draftCategory.id, 'published');
});

describe('spec 044 SEO (integration)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sitemap.xml lists exactly /, /explore and the published catalog, from SITE_URL', async () => {
    vi.stubEnv('SITE_URL', SITE);
    const urls = (await sitemap()).map((entry) => entry.url);

    const expectedCategories = (await getDb().execute(sql`SELECT id FROM categories WHERE status = 'published'`)).rows as Array<{ id: string }>;
    const expectedServices = (
      await getDb().execute(sql`
        SELECT s.id, s.category_id FROM services s JOIN categories c ON c.id = s.category_id
         WHERE s.status = 'published' AND c.status = 'published'`)
    ).rows as Array<{ id: string; category_id: string }>;
    expect(urls.sort()).toEqual(
      [
        `${SITE}/`,
        `${SITE}/explore`,
        ...expectedCategories.map((c) => `${SITE}/explore/${c.id}`),
        ...expectedServices.map((s) => `${SITE}/explore/${s.category_id}/${s.id}`),
      ].sort(),
    );

    expect(urls).toContain(`${SITE}/explore/${published.id}`);
    expect(urls).toContain(`${SITE}/explore/${published.id}/${liveService.id}`);
    for (const hidden of [draftCategory.id, retiredCategory.id, draftService.id, retiredService.id, orphanService.id]) {
      expect(urls.some((u) => u.includes(hidden)), hidden).toBe(false);
    }
    expect(urls.some((u) => /\/(search|account|admin|provider|bookings|requests|support|login|register|offline)\b/.test(u))).toBe(false);
  });

  it('sitemap entries carry the row’s updated_at as lastModified', async () => {
    vi.stubEnv('SITE_URL', SITE);
    const entry = (await sitemap()).find((e) => e.url === `${SITE}/explore/${published.id}`)!;
    const rows = (await getDb().execute(sql`SELECT updated_at FROM categories WHERE id = ${published.id}`)).rows as Array<{ updated_at: Date | string }>;
    expect(new Date(entry.lastModified as Date).getTime()).toBe(new Date(rows[0]!.updated_at).getTime());
  });

  it('robots.txt allows everything but /api/ and points at the sitemap', () => {
    vi.stubEnv('SITE_URL', SITE);
    expect(robots()).toEqual({ rules: { userAgent: '*', allow: '/', disallow: '/api/' }, sitemap: `${SITE}/sitemap.xml` });
  });

  it('a published category: specific title and description, canonical, OG/Twitter and a BreadcrumbList', async () => {
    vi.stubEnv('SITE_URL', SITE);
    const { metadata, jsonLd } = await categorySeo('en', published.id);
    const url = `${SITE}/explore/${published.id}`;
    const description = en.seo.categoryDescription.replace('{name}', published.name);
    expect(metadata).toMatchObject({
      title: `${published.name} | ${branding.appName}`,
      description,
      alternates: { canonical: url },
      openGraph: { url, type: 'website', siteName: branding.appName, title: `${published.name} | ${branding.appName}`, description },
      twitter: { card: 'summary_large_image' },
    });
    expect(metadata.robots).toBeUndefined();
    const image = (metadata.openGraph as { images: Array<{ url: string }> }).images[0]!.url;
    expect(image).toMatch(new RegExp(`^${SITE}/images/marketing/`));
    expect(jsonLd).toEqual([
      expect.objectContaining({
        '@type': 'BreadcrumbList',
        itemListElement: [
          expect.objectContaining({ position: 1, item: `${SITE}/explore` }),
          expect.objectContaining({ position: 2, name: published.name, item: url }),
        ],
      }),
    ]);
  });

  it('a published service: canonical under its OWN category whatever the URL segment, plus BreadcrumbList and Service', async () => {
    vi.stubEnv('SITE_URL', SITE);
    const { metadata, jsonLd } = await serviceSeo('en', liveService.id);
    const url = `${SITE}/explore/${published.id}/${liveService.id}`;
    expect(metadata).toMatchObject({ title: `${liveService.name} | ${branding.appName}`, alternates: { canonical: url }, openGraph: { url } });
    expect(String((metadata.alternates as { canonical: string }).canonical)).not.toContain('?');
    expect(jsonLd.map((d) => d['@type'])).toEqual(['BreadcrumbList', 'Service']);
    expect(jsonLd[1]).toMatchObject({
      name: liveService.name,
      description: en.seo.serviceDescription.replace('{name}', liveService.name),
      serviceType: published.name,
      url,
      provider: { '@type': 'Organization', name: branding.appName },
    });
  });

  it('unknown, malformed, draft, retired or orphaned entities are noindex with no canonical, OG or JSON-LD', async () => {
    vi.stubEnv('SITE_URL', SITE);
    const cases = [
      await categorySeo('en', randomUUID()),
      await categorySeo('en', 'not-a-uuid'),
      await categorySeo('en', draftCategory.id),
      await categorySeo('en', retiredCategory.id),
      await serviceSeo('en', randomUUID()),
      await serviceSeo('en', "x'; DROP TABLE services;--"),
      await serviceSeo('en', draftService.id),
      await serviceSeo('en', retiredService.id),
      await serviceSeo('en', orphanService.id),
    ];
    for (const { metadata, jsonLd } of cases) {
      expect(metadata).toMatchObject({ robots: { index: false, follow: false }, alternates: null, openGraph: null, twitter: null });
      expect(jsonLd).toEqual([]);
    }
  });

  it('/explore has its own title, description and canonical', () => {
    vi.stubEnv('SITE_URL', SITE);
    expect(exploreSeo('en').metadata).toMatchObject({
      title: `${en.seo.exploreTitle} | ${branding.appName}`,
      description: en.seo.exploreDescription,
      alternates: { canonical: `${SITE}/explore` },
    });
  });

  it('a missing SITE_URL is a configuration error, never a guessed host', async () => {
    vi.stubEnv('SITE_URL', '');
    await expect(categorySeo('en', published.id)).rejects.toThrow(/SITE_URL/);
    expect(() => robots()).toThrow(/SITE_URL/);
  });
});
