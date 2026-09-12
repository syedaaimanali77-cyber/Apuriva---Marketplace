'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Checkbox,
  ErrorState,
  FormField,
  Icon,
  Input,
  Radio,
  Select,
  Skeleton,
  Textarea,
} from '@/components';
import type { AddressDto } from '@/lib/types/location';
import type { ServiceFieldDto } from '@/lib/types/service-page';
import type { CreateRequestRequest, RequestDto, RequestUrgency } from '@/lib/types/requests';
import { apiFetch, fieldErrorMap, mutateHeaders, type ApiErrorBody } from '../../api-client';
import styles from '../../requests.module.css';

type PageStatus = 'loading' | 'error' | 'ready';
type BudgetMode = 'unsure' | 'amount' | 'range';

/** Spec 013's interpreter already defaults to this market's currency; multi-currency selection is
 * spec 042's (internationalization), not this form's to invent. */
const CURRENCY_CODE = 'PKR';

/** Master spec §27: the customer may give a target amount, a range, or "I'm not sure". */
const BUDGET_MODES: { value: BudgetMode; label: string }[] = [
  { value: 'unsure', label: "I'm not sure" },
  { value: 'amount', label: 'Target amount' },
  { value: 'range', label: 'Budget range' },
];

const URGENCY_OPTIONS: { value: RequestUrgency; label: string }[] = [
  { value: 'normal', label: 'Normal — within the next few days' },
  { value: 'urgent', label: 'Urgent — as soon as possible' },
];

/** Minor units -> major units for the form's inputs, which collect whole currency units. */
function toMinorUnits(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 100);
}

/**
 * Spec 015 §5, `/requests/new/{serviceId}` — the request form. AC-2/AC-3: service-specific fields
 * come from spec 011's `GET /api/v1/services/{id}/fields` (never a hardcoded list) and budget is
 * always optional. Submission failure preserves every entered value and maps each `errors[].field`
 * (a `ServiceField.key`) onto that control. Per CLAUDE.md's branding rule, no logo of its own.
 */
export default function NewRequestPage() {
  const params = useParams<{ serviceId: string }>();
  const router = useRouter();
  const serviceId = params.serviceId;

  const [status, setStatus] = useState<PageStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serviceName, setServiceName] = useState('');
  const [fields, setFields] = useState<ServiceFieldDto[]>([]);
  const [addresses, setAddresses] = useState<AddressDto[]>([]);

  const [description, setDescription] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string | number | boolean>>({});
  const [budgetMode, setBudgetMode] = useState<BudgetMode>('unsure');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [preferredAt, setPreferredAt] = useState('');
  const [addressId, setAddressId] = useState('');
  const [urgency, setUrgency] = useState<RequestUrgency>('normal');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiErrorBody | undefined>();

  /**
   * §3: `Idempotency-Key` is required, and deliberately generated once per form instance rather
   * than per click — that is what makes a double-submit or a retry after a dropped response
   * resolve to the same single request instead of creating a second one.
   */
  const [idempotencyKey, setIdempotencyKey] = useState('');
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);

    const [service, serviceFields, addressList] = await Promise.all([
      apiFetch<{ id: string; name: string }>(`/api/v1/services/${encodeURIComponent(serviceId)}`),
      apiFetch<ServiceFieldDto[]>(`/api/v1/services/${encodeURIComponent(serviceId)}/fields`),
      apiFetch<AddressDto[]>('/api/v1/addresses'),
    ]);

    if (!service.ok) {
      setLoadError(service.error?.message ?? "Couldn't load this service.");
      setStatus('error');
      return;
    }

    setServiceName(service.data?.name ?? '');
    setFields(serviceFields.ok ? serviceFields.data ?? [] : []);
    const saved = addressList.ok ? addressList.data ?? [] : [];
    setAddresses(saved);
    setAddressId((current) => current || saved.find((a) => a.isDefault)?.id || saved[0]?.id || '');
    setStatus('ready');
  }, [serviceId]);

  useEffect(() => {
    load();
  }, [load]);

  const fieldErrors = useMemo(() => fieldErrorMap(submitError), [submitError]);

  function setFieldValue(key: string, value: string | number | boolean) {
    setFieldValues((current) => ({ ...current, [key]: value }));
  }

  function buildBudget(): CreateRequestRequest['budget'] {
    if (budgetMode === 'amount') {
      const amountMinorUnits = toMinorUnits(budgetAmount);
      return amountMinorUnits === undefined ? null : { amountMinorUnits, currencyCode: CURRENCY_CODE };
    }
    if (budgetMode === 'range') {
      const minAmountMinorUnits = toMinorUnits(budgetMin);
      const maxAmountMinorUnits = toMinorUnits(budgetMax);
      if (minAmountMinorUnits === undefined || maxAmountMinorUnits === undefined) return null;
      return { minAmountMinorUnits, maxAmountMinorUnits, currencyCode: CURRENCY_CODE };
    }
    return null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(undefined);

    const body: CreateRequestRequest = {
      serviceId,
      description,
      fieldValues,
      budget: buildBudget(),
      addressId,
      urgency,
      ...(preferredAt
        ? {
            preferredAt: new Date(preferredAt).toISOString(),
            preferredTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }
        : {}),
    };

    const result = await apiFetch<RequestDto>('/api/v1/requests', {
      method: 'POST',
      headers: mutateHeaders({ 'Idempotency-Key': idempotencyKey }),
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }
    // §5 Success: straight into the live status view.
    router.push(`/requests/${result.data!.id}`);
  }

  if (status === 'loading') {
    return (
      <main className={styles.page}>
        <div className={styles.head}>
          <Skeleton width="160px" height={12} />
          <Skeleton width="280px" height={28} />
        </div>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (status === 'error') {
    return (
      <main className={styles.page}>
        <div className={styles.stateCard}>
          <ErrorState description={loadError ?? undefined} onRetry={load} />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <span className={styles.eyebrow}>
          <Link href="/requests" className={styles.eyebrowLink}>
            Requests
          </Link>
          <Icon name="chevron-right" size="xs" />
          <span>New</span>
        </span>
        <h1 className={styles.title}>Request {serviceName.toLowerCase()}</h1>
        <p className={styles.lede}>
          Tell providers what you need. Only the marked details are required — everything else helps them quote
          accurately.
        </p>
      </header>

      {submitError && (submitError.errors ?? []).length === 0 ? (
        <p className={styles.errorNote} role="alert">
          <Icon name="circle-alert" size="sm" />
          {submitError.message}
        </p>
      ) : null}

      <form className={styles.form} onSubmit={submit} noValidate>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>What you need</h2>
          <FormField label="Describe the job" htmlFor="description" required error={fieldErrors.description}>
            <Textarea
              id="description"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
              placeholder="What needs doing, and anything a provider should know before quoting."
              rows={4}
              maxLength={4000}
              invalid={Boolean(fieldErrors.description)}
            />
          </FormField>

          {fields.map((field) => (
            <FormField
              key={field.id}
              label={field.label}
              htmlFor={`field-${field.key}`}
              required={field.required}
              optional={!field.required}
              error={fieldErrors[field.key]}
            >
              {field.type === 'select' ? (
                <Select
                  id={`field-${field.key}`}
                  value={String(fieldValues[field.key] ?? '')}
                  onChange={(e) => setFieldValue(field.key, e.target.value)}
                  placeholder="Choose one"
                  options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
                  invalid={Boolean(fieldErrors[field.key])}
                />
              ) : field.type === 'boolean' ? (
                <Checkbox
                  id={`field-${field.key}`}
                  label={field.label}
                  checked={Boolean(fieldValues[field.key])}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFieldValue(field.key, e.target.checked)}
                />
              ) : (
                <Input
                  id={`field-${field.key}`}
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={String(fieldValues[field.key] ?? '')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setFieldValue(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)
                  }
                  invalid={Boolean(fieldErrors[field.key])}
                />
              )}
            </FormField>
          ))}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Budget</h2>
          <p className={styles.sectionHint}>
            Optional. Providers can still offer outside it, and the offer price is always explicit.
          </p>
          <div className={styles.budgetChoice} role="radiogroup" aria-label="Budget">
            {BUDGET_MODES.map((mode) => (
              <Radio
                key={mode.value}
                name="budget-mode"
                label={mode.label}
                value={mode.value}
                checked={budgetMode === mode.value}
                onChange={() => setBudgetMode(mode.value)}
              />
            ))}
          </div>

          {budgetMode === 'amount' ? (
            <FormField label={`Target amount (${CURRENCY_CODE})`} htmlFor="budget-amount" error={fieldErrors['budget.amountMinorUnits']}>
              <Input
                id="budget-amount"
                type="number"
                min={0}
                value={budgetAmount}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudgetAmount(e.target.value)}
                invalid={Boolean(fieldErrors['budget.amountMinorUnits'])}
              />
            </FormField>
          ) : null}

          {budgetMode === 'range' ? (
            <div className={styles.inlineFields}>
              <FormField label={`Minimum (${CURRENCY_CODE})`} htmlFor="budget-min" error={fieldErrors['budget.minAmountMinorUnits']}>
                <Input
                  id="budget-min"
                  type="number"
                  min={0}
                  value={budgetMin}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudgetMin(e.target.value)}
                  invalid={Boolean(fieldErrors['budget.minAmountMinorUnits'])}
                />
              </FormField>
              <FormField label={`Maximum (${CURRENCY_CODE})`} htmlFor="budget-max" error={fieldErrors['budget.maxAmountMinorUnits']}>
                <Input
                  id="budget-max"
                  type="number"
                  min={0}
                  value={budgetMax}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudgetMax(e.target.value)}
                  invalid={Boolean(fieldErrors['budget.maxAmountMinorUnits'])}
                />
              </FormField>
            </div>
          ) : null}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>When and where</h2>
          <div className={styles.inlineFields}>
            <FormField label="Preferred date and time" htmlFor="preferred-at" optional error={fieldErrors.preferredAt}>
              <Input
                id="preferred-at"
                type="datetime-local"
                value={preferredAt}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPreferredAt(e.target.value)}
                invalid={Boolean(fieldErrors.preferredAt)}
              />
            </FormField>

            <FormField label="Urgency" htmlFor="urgency">
              <Select
                id="urgency"
                value={urgency}
                onChange={(e) => setUrgency(e.target.value as RequestUrgency)}
                options={URGENCY_OPTIONS}
              />
            </FormField>
          </div>

          {addresses.length === 0 ? (
            <FormField label="Address" required error={fieldErrors.addressId} help="You need a saved address before you can send a request.">
              <Link href="/account/addresses">
                <Button variant="secondary" iconLeft="map-pin">
                  Add an address
                </Button>
              </Link>
            </FormField>
          ) : (
            <FormField label="Address" htmlFor="address" required error={fieldErrors.addressId}>
              <Select
                id="address"
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                placeholder="Choose an address"
                options={addresses.map((address) => ({
                  value: address.id,
                  label: `${address.label} — ${address.approxAreaLabel}`,
                }))}
                invalid={Boolean(fieldErrors.addressId)}
              />
            </FormField>
          )}
        </section>

        <div className={styles.formActions}>
          <Link href="/requests">
            <Button variant="ghost" type="button">
              Cancel
            </Button>
          </Link>
          <Button type="submit" variant="primary" loading={submitting} disabled={addresses.length === 0}>
            Send request
          </Button>
        </div>
      </form>
    </main>
  );
}
