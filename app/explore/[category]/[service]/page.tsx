'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button, Card, EmptyState, ErrorState, FAQList, Icon, PackageCard, PriceDisplay, Skeleton } from '@/components';
import type { ServicePageDto } from '@/lib/types/service-page';
import styles from '../../explore.module.css';

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 011 §3/AC-2/AC-3/AC-4/AC-5/AC-6, `app/explore/[category]/[service]` — reads
 * `GET /api/v1/services/{id}/page`. Pricing renders per `pricingModel` (AC-2, via
 * `PriceDisplay`); required fields are previewed (AC-3's contract itself is enforced at
 * submission time by spec 015, out of scope here — this page only surfaces what's required);
 * recommended-but-optional media guidance is inline help text, never blocking (AC-4); FAQs show
 * their source via icon+label (AC-6, via `FAQList`) and an approved AI suggestion displays
 * exactly like an official FAQ (AC-5). Per CLAUDE.md's branding rule, no logo/header of its own.
 */
export default function ServicePage() {
  const params = useParams<{ category: string; service: string }>();
  const serviceId = params.service;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<ServicePageDto | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`/api/v1/services/${encodeURIComponent(serviceId)}/page`);
      const json = await res.json();
      if (!res.ok) {
        setStatus('error');
        setError(json.message ?? "Couldn't load this service.");
        return;
      }
      setPage(json.data as ServicePageDto);
      setStatus('ready');
    } catch {
      setStatus('error');
      setError("Couldn't load this service.");
    }
  }, [serviceId]);

  useEffect(() => {
    load();
  }, [load]);

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <Skeleton lines={2} />
        <Card>
          <Skeleton lines={2} />
        </Card>
        <Card>
          <Skeleton lines={3} />
        </Card>
      </main>
    );
  }

  if (status === 'error' || !page) {
    return (
      <main className={styles.page}>
        <ErrorState description={error ?? undefined} onRetry={load} />
      </main>
    );
  }

  const hasPackagesOrFaqs = page.packages.length > 0 || page.faqs.length > 0;

  return (
    <main className={styles.page}>
      <div className={styles.heroRow}>
        <h1 className={styles.title}>{page.name}</h1>
        <PriceDisplay priceDisplay={page.priceDisplay} />
      </div>

      <Button variant="primary" size="lg">
        {page.priceDisplay.type === 'quote' ? 'Get offers' : 'Request service'}
      </Button>

      {!hasPackagesOrFaqs ? (
        <EmptyState
          icon="compass"
          title="Ask Apuriva"
          description="This service doesn't have packages or FAQs yet — describe what you need and Apuriva's AI assistant can help."
          action={
            <Button variant="secondary" size="md">
              Request service
            </Button>
          }
        />
      ) : (
        <>
          {page.packages.length > 0 ? (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Packages</h2>
              <div className={styles.grid}>
                {page.packages.map((pkg) => (
                  <PackageCard key={pkg.id} servicePackage={pkg} />
                ))}
              </div>
            </div>
          ) : null}

          {page.faqs.length > 0 ? (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Frequently asked questions</h2>
              <FAQList faqs={page.faqs} />
            </div>
          ) : null}
        </>
      )}

      {page.requirements.length > 0 ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Good to know</h2>
          {page.requirements.map((req) => (
            <div key={req.id} className={styles.requirementNote}>
              <Icon name="circle-alert" size="sm" />
              <span>{typeof req.detail.helpText === 'string' ? req.detail.helpText : `Recommended: ${req.kind}`}</span>
            </div>
          ))}
        </div>
      ) : null}

      {page.fields.length > 0 ? (
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>What we'll ask you</h2>
          <ul className={styles.fieldPreviewList}>
            {page.fields.map((field) => (
              <li key={field.id}>
                {field.label}
                {field.required ? ' (required)' : ' (optional)'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </main>
  );
}
