'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, ErrorState, FormField, Input, Select, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { AdminRoleDto } from '@/lib/types/admin-rbac';
import styles from '../admin.module.css';

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

/** `VALIDATION_ERROR` responses carry the specific `field`/`message` (e.g. "userId must be a
 * valid UUID.") behind the generic top-level message — surface it so the operator knows exactly
 * what to fix instead of a bare "The request failed validation." (spec 009 §3 error contract). */
function describeError(error: ApiErrorBody | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.errors?.length) {
    return error.errors.map((e) => `${e.field} ${e.message}`).join(' ');
  }
  return error.message ?? fallback;
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

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

/**
 * Spec 009 §3/§5, `app/admin/roles` — Super Admin's role catalog + assign/revoke controls.
 * `GET /api/v1/admin/roles` is itself Super Admin-scoped server-side, so a non-Super-Admin caller
 * gets a plain "you don't have access" state here, never a client-side role check standing in for
 * the real (backend) authorization spec 009 §5 requires.
 */
export default function AdminRolesPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [roleNames, setRoleNames] = useState<AdminRoleDto['name'][]>([]);
  const [announcement, setAnnouncement] = useState('');

  const [targetUserId, setTargetUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<AdminRoleDto['name'] | ''>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [assignPending, setAssignPending] = useState(false);
  const [revokePending, setRevokePending] = useState(false);

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await apiFetch<AdminRoleDto[]>('/api/v1/admin/roles');
    if (!res.ok) {
      if (res.error?.code === 'FORBIDDEN') {
        setPageStatus('forbidden');
        return;
      }
      setPageStatus('error');
      setPageError(res.error?.message ?? "Couldn't load the role catalog.");
      return;
    }
    setRoleNames(res.data!.map((r) => r.name));
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAssign() {
    setFormError(null);
    if (!targetUserId.trim() || !selectedRole) {
      setFormError('Enter a user id and choose a role.');
      return;
    }
    setAssignPending(true);
    const res = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(targetUserId.trim())}/roles`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ role: selectedRole }),
    });
    setAssignPending(false);
    if (!res.ok) {
      setFormError(describeError(res.error, "Couldn't assign that role."));
      return;
    }
    setAnnouncement(`Assigned ${selectedRole} to ${targetUserId}.`);
  }

  async function handleRevoke() {
    setFormError(null);
    if (!targetUserId.trim() || !selectedRole) {
      setFormError('Enter a user id and choose a role.');
      return;
    }
    setRevokePending(true);
    const res = await apiFetch(`/api/v1/admin/users/${encodeURIComponent(targetUserId.trim())}/roles/${selectedRole}`, {
      method: 'DELETE',
      headers: mutateHeaders(),
    });
    setRevokePending(false);
    if (!res.ok) {
      setFormError(describeError(res.error, "Couldn't revoke that role."));
      return;
    }
    setAnnouncement(`Revoked ${selectedRole} from ${targetUserId}.`);
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Admin roles</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'forbidden') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Admin roles</h1>
        <Alert tone="warning" title="Super Admin required">
          Role management is scoped to the Super Admin role (spec 009 AC-5) — your account doesn't currently hold it.
        </Alert>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Admin roles</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  const columns: TableColumn<AdminRoleDto['name']>[] = [{ key: 'name', header: 'Role', render: (name) => name }];

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Admin roles</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="assign-heading" className={styles.section}>
        <h2 id="assign-heading" className={styles.sectionTitle}>
          Assign or revoke a role
        </h2>
        {formError ? (
          <Alert tone="error" title="Something went wrong">
            {formError}
          </Alert>
        ) : null}
        <div className={styles.form}>
          <div className={styles.formField}>
            <FormField label="User id" htmlFor="target-user-id">
              <Input id="target-user-id" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)} placeholder="user uuid" />
            </FormField>
          </div>
          <div className={styles.formField}>
            <FormField label="Role" htmlFor="target-role">
              <Select
                id="target-role"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as AdminRoleDto['name'])}
                options={roleNames.map((name) => ({ value: name, label: name }))}
                placeholder="Choose a role"
              />
            </FormField>
          </div>
          <div className={styles.actions}>
            <Button variant="primary" loading={assignPending} onClick={handleAssign}>
              Assign
            </Button>
            <Button variant="danger" loading={revokePending} onClick={handleRevoke}>
              Revoke
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="catalog-heading" className={styles.section}>
        <h2 id="catalog-heading" className={styles.sectionTitle}>
          Canonical roles
        </h2>
        <Table columns={columns} rows={roleNames} caption="The seven canonical admin roles" emptyMessage="No roles seeded." />
      </section>
    </main>
  );
}
