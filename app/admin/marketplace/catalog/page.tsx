'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ErrorState, FormField, Input, Select, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { CatalogEntityStatus, CatalogSuggestionDto, CategoryDto, PricingModel, SubcategoryDto } from '@/lib/types/catalog';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/admin/roles/page.tsx. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 204) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

function mutateHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() };
}

/** `VALIDATION_ERROR` carries the specific field/reason behind the generic top-level message —
 * surface it rather than a bare "The request failed validation." (matches app/admin/roles/page.tsx's
 * fix for the same class of defect). */
function describeError(error: ApiErrorBody | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.errors?.length) return error.errors.map((e) => `${e.field} ${e.message}`).join(' ');
  return error.message ?? fallback;
}

const STATUS_OPTIONS: { value: CatalogEntityStatus; label: string }[] = [
  { value: 'draft', label: 'draft' },
  { value: 'published', label: 'published' },
  { value: 'pending_review', label: 'pending_review' },
  { value: 'retired', label: 'retired' },
];

const PRICING_MODEL_OPTIONS: { value: PricingModel; label: string }[] = [
  { value: 'fixed', label: 'fixed' },
  { value: 'package', label: 'package' },
  { value: 'hourly', label: 'hourly' },
  { value: 'quote', label: 'quote' },
  { value: 'custom', label: 'custom' },
];

/** DS status badges: the literal status text, paired with tone (and the tone's icon). */
const STATUS_TONES: Record<CatalogEntityStatus, 'neutral' | 'success' | 'warning'> = {
  draft: 'neutral',
  published: 'success',
  pending_review: 'warning',
  retired: 'neutral',
};

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

interface FlatSubcategory extends SubcategoryDto {
  categoryName: string;
}

/**
 * Spec 010 §5, `app/admin/marketplace/catalog` — the Content/Marketplace admin's category,
 * subcategory, service, and AI-suggestion-review editor. `GET /api/v1/admin/categories` is itself
 * Content/Marketplace-scoped server-side (spec 009 §3.1), so a caller without that permission gets
 * a plain "you don't have access" state here, never a client-side check standing in for the real
 * backend authorization spec 010 §3 requires. Per CLAUDE.md's branding rule, no logo/header of its
 * own — reuses app/admin/admin.module.css, the same as app/admin/roles/page.tsx.
 */
export default function AdminCatalogPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [suggestions, setSuggestions] = useState<CatalogSuggestionDto[]>([]);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const [categoriesRes, suggestionsRes] = await Promise.all([
      apiFetch<CategoryDto[]>('/api/v1/admin/categories'),
      apiFetch<CatalogSuggestionDto[]>('/api/v1/admin/catalog/pending-review'),
    ]);
    if (!categoriesRes.ok) {
      if (categoriesRes.error?.code === 'FORBIDDEN') {
        setPageStatus('forbidden');
        return;
      }
      setPageStatus('error');
      setPageError(categoriesRes.error?.message ?? "Couldn't load the catalog.");
      return;
    }
    setCategories(categoriesRes.data!);
    setSuggestions(suggestionsRes.ok ? suggestionsRes.data! : []);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // --- Category form ---------------------------------------------------
  const [categoryFormError, setCategoryFormError] = useState<string | null>(null);
  const [categoryPending, setCategoryPending] = useState(false);
  const [categoryName, setCategoryName] = useState('');
  const [categorySlug, setCategorySlug] = useState('');
  const [categoryStatus, setCategoryStatus] = useState<CatalogEntityStatus>('draft');

  async function handleCreateCategory() {
    setCategoryFormError(null);
    if (!categoryName.trim() || !categorySlug.trim()) {
      setCategoryFormError('Enter a name and a slug.');
      return;
    }
    setCategoryPending(true);
    const res = await apiFetch<CategoryDto>('/api/v1/admin/categories', {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ name: categoryName, slug: categorySlug, status: categoryStatus }),
    });
    setCategoryPending(false);
    if (!res.ok) {
      setCategoryFormError(describeError(res.error, "Couldn't create that category."));
      return;
    }
    setAnnouncement(`Created category ${categoryName}.`);
    setCategoryName('');
    setCategorySlug('');
    load();
  }

  async function handleRetireCategory(id: string) {
    setCategoryFormError(null);
    const res = await apiFetch<CategoryDto>(`/api/v1/admin/categories/${encodeURIComponent(id)}/retire`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setCategoryFormError(describeError(res.error, "Couldn't retire that category."));
      return;
    }
    setAnnouncement('Category retired.');
    load();
  }

  // --- Subcategory form --------------------------------------------------
  const [subFormError, setSubFormError] = useState<string | null>(null);
  const [subPending, setSubPending] = useState(false);
  const [subCategoryId, setSubCategoryId] = useState('');
  const [subName, setSubName] = useState('');
  const [subSlug, setSubSlug] = useState('');
  const [subStatus, setSubStatus] = useState<CatalogEntityStatus>('draft');

  async function handleCreateSubcategory() {
    setSubFormError(null);
    if (!subCategoryId.trim() || !subName.trim() || !subSlug.trim()) {
      setSubFormError('Choose a parent category and enter a name and a slug.');
      return;
    }
    setSubPending(true);
    const res = await apiFetch<SubcategoryDto>(`/api/v1/admin/categories/${encodeURIComponent(subCategoryId)}/subcategories`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ name: subName, slug: subSlug, status: subStatus }),
    });
    setSubPending(false);
    if (!res.ok) {
      setSubFormError(describeError(res.error, "Couldn't create that subcategory."));
      return;
    }
    setAnnouncement(`Created subcategory ${subName}.`);
    setSubName('');
    setSubSlug('');
    load();
  }

  async function handleRetireSubcategory(id: string) {
    setSubFormError(null);
    const res = await apiFetch<SubcategoryDto>(`/api/v1/admin/subcategories/${encodeURIComponent(id)}/retire`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setSubFormError(describeError(res.error, "Couldn't retire that subcategory."));
      return;
    }
    setAnnouncement('Subcategory retired.');
    load();
  }

  // --- Service form -------------------------------------------------------
  const [serviceFormError, setServiceFormError] = useState<string | null>(null);
  const [servicePending, setServicePending] = useState(false);
  const [serviceCategoryId, setServiceCategoryId] = useState('');
  const [serviceSubcategoryId, setServiceSubcategoryId] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [serviceSlug, setServiceSlug] = useState('');
  const [servicePricingModel, setServicePricingModel] = useState<PricingModel>('quote');
  const [serviceStatus, setServiceStatus] = useState<CatalogEntityStatus>('draft');

  async function handleCreateService() {
    setServiceFormError(null);
    if (!serviceCategoryId.trim() || !serviceName.trim() || !serviceSlug.trim()) {
      setServiceFormError('Choose a category and enter a name and a slug.');
      return;
    }
    setServicePending(true);
    const res = await apiFetch('/api/v1/admin/services', {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({
        categoryId: serviceCategoryId,
        subcategoryId: serviceSubcategoryId.trim() ? serviceSubcategoryId.trim() : null,
        name: serviceName,
        slug: serviceSlug,
        pricingModel: servicePricingModel,
        status: serviceStatus,
      }),
    });
    setServicePending(false);
    if (!res.ok) {
      setServiceFormError(describeError(res.error, "Couldn't create that service."));
      return;
    }
    setAnnouncement(`Created service ${serviceName}.`);
    setServiceName('');
    setServiceSlug('');
    load();
  }

  // --- Service lookup (no list-all endpoint — spec 010 §3's admin API contract only defines
  // GET/PATCH/retire by id) --------------------------------------------
  const [lookupServiceId, setLookupServiceId] = useState('');
  const [lookupServiceError, setLookupServiceError] = useState<string | null>(null);

  async function handleRetireLookedUpService() {
    setLookupServiceError(null);
    if (!lookupServiceId.trim()) {
      setLookupServiceError('Enter a service id.');
      return;
    }
    const res = await apiFetch(`/api/v1/admin/services/${encodeURIComponent(lookupServiceId.trim())}/retire`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setLookupServiceError(describeError(res.error, "Couldn't retire that service."));
      return;
    }
    setAnnouncement('Service retired.');
    setLookupServiceId('');
  }

  // --- AI suggestion review -----------------------------------------------
  const [suggestionError, setSuggestionError] = useState<string | null>(null);

  async function handleApproveSuggestion(id: string) {
    setSuggestionError(null);
    const res = await apiFetch<CatalogSuggestionDto>(`/api/v1/admin/catalog/pending-review/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setSuggestionError(describeError(res.error, "Couldn't approve that suggestion."));
      return;
    }
    setAnnouncement('Suggestion approved — publish the resulting entry separately to make it customer-visible.');
    load();
  }

  async function handleRejectSuggestion(id: string) {
    setSuggestionError(null);
    const res = await apiFetch<CatalogSuggestionDto>(`/api/v1/admin/catalog/pending-review/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      headers: mutateHeaders(),
    });
    if (!res.ok) {
      setSuggestionError(describeError(res.error, "Couldn't reject that suggestion."));
      return;
    }
    setAnnouncement('Suggestion rejected.');
    load();
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Catalog</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'forbidden') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Catalog</h1>
        <Alert tone="warning" title="Content/Marketplace admin required">
          Catalog management is scoped to the Content/Marketplace admin permission (spec 010 §3) — your account doesn't currently hold it.
        </Alert>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Catalog</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  const categoryColumns: TableColumn<CategoryDto>[] = [
    { key: 'name', header: 'Name', render: (c) => c.name },
    { key: 'slug', header: 'Slug', render: (c) => c.slug },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <Badge tone={STATUS_TONES[c.status]} size="sm">
          {c.status}
        </Badge>
      ),
    },
    { key: 'sortOrder', header: 'Sort order', numeric: true, render: (c) => String(c.sortOrder) },
    {
      key: 'actions',
      header: '',
      align: 'end',
      render: (c) =>
        c.status === 'retired' ? null : (
          <Button variant="danger" size="sm" onClick={() => handleRetireCategory(c.id)}>
            Retire
          </Button>
        ),
    },
  ];

  const flatSubcategories: FlatSubcategory[] = categories.flatMap((c) => c.subcategories.map((s) => ({ ...s, categoryName: c.name })));
  const subcategoryColumns: TableColumn<FlatSubcategory>[] = [
    { key: 'categoryName', header: 'Category', render: (s) => s.categoryName },
    { key: 'name', header: 'Name', render: (s) => s.name },
    { key: 'slug', header: 'Slug', render: (s) => s.slug },
    {
      key: 'status',
      header: 'Status',
      render: (s) => (
        <Badge tone={STATUS_TONES[s.status]} size="sm">
          {s.status}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'end',
      render: (s) =>
        s.status === 'retired' ? null : (
          <Button variant="danger" size="sm" onClick={() => handleRetireSubcategory(s.id)}>
            Retire
          </Button>
        ),
    },
  ];

  const suggestionColumns: TableColumn<CatalogSuggestionDto>[] = [
    { key: 'entityType', header: 'Type', render: (s) => s.entityType },
    { key: 'proposedName', header: 'Proposed name', render: (s) => s.proposedName },
    { key: 'source', header: 'Source', render: (s) => s.source },
    { key: 'rationale', header: 'Rationale', render: (s) => s.rationale ?? '—' },
    {
      key: 'actions',
      header: '',
      align: 'end',
      render: (s) => (
        <div className={styles.actions}>
          <Button variant="primary" size="sm" onClick={() => handleApproveSuggestion(s.id)}>
            Approve
          </Button>
          <Button variant="danger" size="sm" onClick={() => handleRejectSuggestion(s.id)}>
            Reject
          </Button>
        </div>
      ),
    },
  ];

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Catalog</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="categories-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="categories-heading" className={styles.sectionTitle}>
            Categories
          </h2>
        </div>
        {categoryFormError ? (
          <Alert tone="error" title="Something went wrong">
            {categoryFormError}
          </Alert>
        ) : null}
        <Card elevation="flat" className={styles.form}>
          <div className={styles.formField}>
            <FormField label="Name" htmlFor="category-name">
              <Input id="category-name" value={categoryName} onChange={(e) => setCategoryName(e.target.value)} />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Slug" htmlFor="category-slug">
              <Input id="category-slug" value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} placeholder="category-slug" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Status" htmlFor="category-status">
              <Select id="category-status" value={categoryStatus} onChange={(e) => setCategoryStatus(e.target.value as CatalogEntityStatus)} options={STATUS_OPTIONS} />
            </FormField>
          </div>
          <div className={styles.actions}>
            <Button variant="primary" loading={categoryPending} onClick={handleCreateCategory}>
              Create category
            </Button>
          </div>
        </Card>
        <Table columns={categoryColumns} rows={categories} caption="All categories" emptyMessage="No categories yet." />
      </section>

      <section aria-labelledby="subcategories-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="subcategories-heading" className={styles.sectionTitle}>
            Subcategories
          </h2>
        </div>
        {subFormError ? (
          <Alert tone="error" title="Something went wrong">
            {subFormError}
          </Alert>
        ) : null}
        <Card elevation="flat" className={styles.form}>
          <div className={styles.formField}>
            <FormField label="Parent category id" htmlFor="sub-category-id">
              <Input id="sub-category-id" value={subCategoryId} onChange={(e) => setSubCategoryId(e.target.value)} placeholder="category uuid" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Name" htmlFor="sub-name">
              <Input id="sub-name" value={subName} onChange={(e) => setSubName(e.target.value)} />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Slug" htmlFor="sub-slug">
              <Input id="sub-slug" value={subSlug} onChange={(e) => setSubSlug(e.target.value)} placeholder="subcategory-slug" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Status" htmlFor="sub-status">
              <Select id="sub-status" value={subStatus} onChange={(e) => setSubStatus(e.target.value as CatalogEntityStatus)} options={STATUS_OPTIONS} />
            </FormField>
          </div>
          <div className={styles.actions}>
            <Button variant="primary" loading={subPending} onClick={handleCreateSubcategory}>
              Create subcategory
            </Button>
          </div>
        </Card>
        <Table columns={subcategoryColumns} rows={flatSubcategories} caption="All subcategories" emptyMessage="No subcategories yet." />
      </section>

      <section aria-labelledby="services-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="services-heading" className={styles.sectionTitle}>
            Services
          </h2>
          <p className={styles.sectionDescription}>Spec 010 defines no admin list-all endpoint for services — look one up by id to retire it.</p>
        </div>
        {serviceFormError ? (
          <Alert tone="error" title="Something went wrong">
            {serviceFormError}
          </Alert>
        ) : null}
        <Card elevation="flat" className={styles.form}>
          <div className={styles.formField}>
            <FormField label="Category id" htmlFor="service-category-id">
              <Input id="service-category-id" value={serviceCategoryId} onChange={(e) => setServiceCategoryId(e.target.value)} placeholder="category uuid" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Subcategory id (optional)" htmlFor="service-subcategory-id">
              <Input id="service-subcategory-id" value={serviceSubcategoryId} onChange={(e) => setServiceSubcategoryId(e.target.value)} placeholder="subcategory uuid" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Name" htmlFor="service-name">
              <Input id="service-name" value={serviceName} onChange={(e) => setServiceName(e.target.value)} />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Slug" htmlFor="service-slug">
              <Input id="service-slug" value={serviceSlug} onChange={(e) => setServiceSlug(e.target.value)} placeholder="service-slug" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Pricing model" htmlFor="service-pricing-model">
              <Select
                id="service-pricing-model"
                value={servicePricingModel}
                onChange={(e) => setServicePricingModel(e.target.value as PricingModel)}
                options={PRICING_MODEL_OPTIONS}
              />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Status" htmlFor="service-status">
              <Select id="service-status" value={serviceStatus} onChange={(e) => setServiceStatus(e.target.value as CatalogEntityStatus)} options={STATUS_OPTIONS} />
            </FormField>
          </div>
          <div className={styles.actions}>
            <Button variant="primary" loading={servicePending} onClick={handleCreateService}>
              Create service
            </Button>
          </div>
        </Card>

        {lookupServiceError ? (
          <Alert tone="error" title="Something went wrong">
            {lookupServiceError}
          </Alert>
        ) : null}
        <Card elevation="flat" className={styles.form}>
          <div className={styles.formField}>
            <FormField label="Service id" htmlFor="lookup-service-id">
              <Input id="lookup-service-id" value={lookupServiceId} onChange={(e) => setLookupServiceId(e.target.value)} placeholder="service uuid" />
            </FormField>
          </div>
          <div className={styles.actions}>
            <Button variant="danger" onClick={handleRetireLookedUpService}>
              Retire service
            </Button>
          </div>
        </Card>
      </section>

      <section aria-labelledby="ai-suggestions-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="ai-suggestions-heading" className={styles.sectionTitle}>
            AI suggestions pending review
          </h2>
          <p className={styles.sectionDescription}>
            Approving creates the entry as pending_review — it becomes customer-visible only once you separately publish it. AI never publishes directly.
          </p>
        </div>
        {suggestionError ? (
          <Alert tone="error" title="Something went wrong">
            {suggestionError}
          </Alert>
        ) : null}
        <Table columns={suggestionColumns} rows={suggestions} caption="Pending AI suggestions" emptyMessage="No suggestions pending review." />
      </section>
    </main>
  );
}
