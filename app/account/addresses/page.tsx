'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Map, Skeleton } from '@/components';
import { AddressForm, type AddressFormValue, type ResolvedPoint } from '@/components/AddressForm';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { AddressDto } from '@/lib/types/location';
import styles from './addresses.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/account/privacy-security/page.tsx. */
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

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 012 §5 — saved-address management. Per CLAUDE.md's branding rule, this page carries no
 * logo/header of its own — the global AppHeader already provides the page's one brand placement.
 * §5 UI states: Loading (skeleton), Empty ("Add an address" prompt, manual entry always
 * available), Error (retry), Success (list with default badge, add/edit/delete).
 */
export default function AddressesPage() {
  const { t, errorText } = useLocale();
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<AddressDto[]>([]);

  const [formOpen, setFormOpen] = useState(false);
  const [editingAddress, setEditingAddress] = useState<AddressDto | null>(null);
  const [formPending, setFormPending] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AddressDto | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const loadAddresses = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await apiFetch<AddressDto[]>('/api/v1/addresses');
    if (!res.ok) {
      setPageStatus('error');
      setPageError(errorText(res.error?.code, res.error?.message, t('addresses.loadFailed')));
      return;
    }
    setAddresses(res.data ?? []);
    setPageStatus('ready');
  }, [errorText, t]);

  useEffect(() => {
    loadAddresses();
  }, [loadAddresses]);

  async function handleGeocode(address: string): Promise<ResolvedPoint | null> {
    const res = await apiFetch<ResolvedPoint>('/api/v1/location/geocode', {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ address }),
    });
    return res.ok ? res.data! : null;
  }

  async function handleSubmit(value: AddressFormValue) {
    setListError(null);
    setFormPending(true);
    const res = editingAddress
      ? await apiFetch<AddressDto>(`/api/v1/addresses/${editingAddress.id}`, {
          method: 'PATCH',
          headers: mutateHeaders(),
          body: JSON.stringify(value),
        })
      : await apiFetch<AddressDto>('/api/v1/addresses', {
          method: 'POST',
          headers: mutateHeaders(),
          body: JSON.stringify(value),
        });
    setFormPending(false);
    if (!res.ok) {
      setListError(errorText(res.error?.code, res.error?.message, t('addresses.saveFailed')));
      return;
    }
    setFormOpen(false);
    setEditingAddress(null);
    await loadAddresses();
  }

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    setListError(null);
    setDeletePending(true);
    const res = await apiFetch<void>(`/api/v1/addresses/${deleteTarget.id}`, { method: 'DELETE', headers: mutateHeaders() });
    setDeletePending(false);
    setDeleteTarget(null);
    if (!res.ok) {
      if (res.error?.code === 'ADDRESS_IN_USE') {
        setListError(t('addresses.inUse'));
        return;
      }
      setListError(errorText(res.error?.code, res.error?.message, t('addresses.deleteFailed')));
      return;
    }
    setAddresses((prev) => prev.filter((a) => a.id !== deleteTarget.id));
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('addresses.title')}</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('addresses.title')}</h1>
        <ErrorState description={pageError ?? undefined} onRetry={loadAddresses} />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t('addresses.title')}</h1>
        {!formOpen ? (
          <Button
            variant="primary"
            onClick={() => {
              setEditingAddress(null);
              setFormOpen(true);
            }}
          >
            {t('addresses.add')}
          </Button>
        ) : null}
      </div>

      {listError ? (
        <Alert tone="error" title={t('common.somethingWentWrong')}>
          {listError}
        </Alert>
      ) : null}

      {formOpen ? (
        <Card>
          <AddressForm
            key={editingAddress?.id ?? 'new'}
            initialValue={editingAddress ?? undefined}
            submitLabel={editingAddress ? t('addresses.saveChanges') : t('addresses.addAddress')}
            pending={formPending}
            onGeocode={handleGeocode}
            onSubmit={handleSubmit}
            onCancel={() => {
              setFormOpen(false);
              setEditingAddress(null);
            }}
          />
        </Card>
      ) : null}

      {addresses.length === 0 && !formOpen ? (
        <EmptyState
          title={t('addresses.emptyTitle')}
          description={t('addresses.emptyDescription')}
          action={
            <Button variant="primary" onClick={() => setFormOpen(true)}>
              {t('addresses.add')}
            </Button>
          }
        />
      ) : (
        <div className={styles.list}>
          {addresses.map((address) => (
            <Card key={address.id}>
              <div className={styles.addressCard}>
                <Map approxAreaLabel={address.approxAreaLabel} latitude={address.latitude} longitude={address.longitude} height={100} />
                <div className={styles.addressBody}>
                  <div className={styles.addressHeader}>
                    <span className={styles.addressLabel}>{address.label}</span>
                    {address.isDefault ? (
                      <Badge tone="brand" size="sm">
                        {t('addresses.default')}
                      </Badge>
                    ) : null}
                  </div>
                  <p className={styles.addressText}>
                    {[address.structured.line1, address.structured.area, address.structured.city, address.structured.country]
                      .filter(Boolean)
                      .join(', ')}
                  </p>
                  <div className={styles.addressActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      iconLeft="pencil"
                      onClick={() => {
                        setEditingAddress(address);
                        setFormOpen(true);
                      }}
                    >
                      {t('addresses.edit')}
                    </Button>
                    <Button variant="secondary" size="sm" iconLeft="trash-2" onClick={() => setDeleteTarget(address)}>
                      {t('addresses.delete')}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('addresses.deleteTitle')}
        description={deleteTarget ? t('addresses.deleteDescription', { label: deleteTarget.label }) : undefined}
        confirmLabel={t('addresses.deleteConfirm')}
        tone="danger"
        pending={deletePending}
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
}
