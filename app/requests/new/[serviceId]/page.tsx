'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Card,
  Checkbox,
  DirectionalIcon,
  ErrorState,
  FormField,
  Icon,
  Input,
  Radio,
  Select,
  Skeleton,
  Textarea,
} from '@/components';
import { OfflineWriteNotice } from '@/app/_components/OfflineWriteNotice';
import { UrgencyEmergencyNotice } from '@/app/_components/UrgencyEmergencyNotice';
import { useNetworkStatus } from '@/app/_components/useNetworkStatus';
import { useLocale } from '@/app/_components/LocaleProvider';
import { useLocales } from '@/app/_components/useLocales';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { currencyFractionDigits } from '@/lib/i18n/format';
import type { AddressDto } from '@/lib/types/location';
import type { ServiceFieldDto } from '@/lib/types/service-page';
import type { CreateRequestRequest, RequestDto, RequestUrgency } from '@/lib/types/requests';
import { apiFetch, fieldErrorMap, mutateHeaders, type ApiErrorBody } from '../../api-client';
import styles from '../../requests.module.css';

type PageStatus = 'loading' | 'error' | 'ready';
type BudgetMode = 'unsure' | 'amount' | 'range';

/** Master spec §27: the customer may give a target amount, a range, or "I'm not sure". */
const BUDGET_MODES: { value: BudgetMode; label: MessageKey }[] = [
  { value: 'unsure', label: 'requestNew.budgetModes.unsure' },
  { value: 'amount', label: 'requestNew.budgetModes.amount' },
  { value: 'range', label: 'requestNew.budgetModes.range' },
];

const URGENCY_OPTIONS: { value: RequestUrgency; label: MessageKey }[] = [
  { value: 'normal', label: 'requestNew.urgency.normal' },
  { value: 'urgent', label: 'requestNew.urgency.urgent' },
];

/**
 * Major units (the form's inputs) -> minor units, at the currency's real fraction digits (spec 042 §3.9:
 * PKR 2, JPY 0, KWD 3 — the old `× 100` assumed two for every currency).
 */
function toMinorUnits(value: string, currencyCode: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round(parsed * 10 ** currencyFractionDigits(currencyCode));
}

/**
 * Spec 015 §5, `/requests/new/{serviceId}` — the request form. AC-2/AC-3: service-specific fields
 * come from spec 011's `GET /api/v1/services/{id}/fields` (never a hardcoded list) and budget is
 * always optional. Submission failure preserves every entered value and maps each `errors[].field`
 * (a `ServiceField.key`) onto that control. Per CLAUDE.md's branding rule, no logo of its own.
 */
export default function NewRequestPage() {
  const { t, errorText } = useLocale();
  // Spec 042 §3.9 (X-8): the budget's currency is the configured market default from `GET /locales`,
  // never a literal. Until it is known there is deliberately no fallback (AC-3).
  const { platformCurrencyCode: currencyCode } = useLocales();
  const params = useParams<{ serviceId: string }>();
  const router = useRouter();
  const serviceId = params.serviceId;
  // Spec 044 §3.5 (X-5): request submission is disabled while offline, with the offline notice.
  const { online } = useNetworkStatus();
  const offlineNoticeId = useId();

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
  const [currencyError, setCurrencyError] = useState(false);

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
      setLoadError(errorText(service.error?.code, service.error?.message, t('requestNew.loadFailed')));
      setStatus('error');
      return;
    }

    setServiceName(service.data?.name ?? '');
    setFields(serviceFields.ok ? serviceFields.data ?? [] : []);
    const saved = addressList.ok ? addressList.data ?? [] : [];
    setAddresses(saved);
    setAddressId((current) => current || saved.find((a) => a.isDefault)?.id || saved[0]?.id || '');
    setStatus('ready');
  }, [errorText, serviceId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const fieldErrors = useMemo(() => fieldErrorMap(submitError), [submitError]);

  function setFieldValue(key: string, value: string | number | boolean) {
    setFieldValues((current) => ({ ...current, [key]: value }));
  }

  function buildBudget(currency: string): CreateRequestRequest['budget'] {
    if (budgetMode === 'amount') {
      const amountMinorUnits = toMinorUnits(budgetAmount, currency);
      return amountMinorUnits === undefined ? null : { amountMinorUnits, currencyCode: currency };
    }
    if (budgetMode === 'range') {
      const minAmountMinorUnits = toMinorUnits(budgetMin, currency);
      const maxAmountMinorUnits = toMinorUnits(budgetMax, currency);
      if (minAmountMinorUnits === undefined || maxAmountMinorUnits === undefined) return null;
      return { minAmountMinorUnits, maxAmountMinorUnits, currencyCode: currency };
    }
    return null;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitError(undefined);
    setCurrencyError(false);
    if (budgetMode !== 'unsure' && !currencyCode) {
      // A budget amount without its currency would be meaningless — refuse rather than guess one.
      setCurrencyError(true);
      return;
    }
    setSubmitting(true);

    const body: CreateRequestRequest = {
      serviceId,
      description,
      fieldValues,
      budget: currencyCode ? buildBudget(currencyCode) : null,
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
            {t('requestNew.requests')}
          </Link>
          <DirectionalIcon name="chevron-right" size="xs" />
          <span>{t('requestNew.new')}</span>
        </span>
        <h1 className={styles.title}>{t('requestNew.title', { service: serviceName.toLowerCase() })}</h1>
        <p className={styles.lede}>{t('requestNew.lede')}</p>
      </header>

      {submitError && (submitError.errors ?? []).length === 0 ? (
        <p className={styles.errorNote} role="alert">
          <Icon name="circle-alert" size="sm" />
          {errorText(submitError.code, submitError.message)}
        </p>
      ) : null}
      {/* Spec 042 §3.7: field messages stay the server's; a translated generic line sits above them. */}
      {submitError && (submitError.errors ?? []).length > 0 ? (
        <p className={styles.errorNote}>
          <Icon name="circle-alert" size="sm" />
          {t('common.checkHighlightedFields')}
        </p>
      ) : null}
      {currencyError ? (
        <p className={styles.errorNote} role="alert">
          <Icon name="circle-alert" size="sm" />
          {t('requestNew.currencyUnavailable')}
        </p>
      ) : null}

      <form className={styles.form} onSubmit={submit} noValidate>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('requestNew.whatYouNeed')}</h2>
          <FormField label={t('requestNew.describe')} htmlFor="description" required error={fieldErrors.description}>
            <Textarea
              id="description"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
              placeholder={t('requestNew.describePlaceholder')}
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
                  placeholder={t('requestNew.chooseOne')}
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
          <h2 className={styles.sectionTitle}>{t('requestNew.budget')}</h2>
          <p className={styles.sectionHint}>{t('requestNew.budgetHint')}</p>
          <div className={styles.budgetChoice} role="radiogroup" aria-label={t('requestNew.budget')}>
            {BUDGET_MODES.map((mode) => (
              <Radio
                key={mode.value}
                name="budget-mode"
                label={t(mode.label)}
                value={mode.value}
                checked={budgetMode === mode.value}
                onChange={() => setBudgetMode(mode.value)}
              />
            ))}
          </div>

          {budgetMode === 'amount' ? (
            <FormField
              label={currencyCode ? t('requestNew.targetAmount', { currency: currencyCode }) : t('requestNew.targetAmountPlain')}
              htmlFor="budget-amount" error={fieldErrors['budget.amountMinorUnits']}>
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
              <FormField
                label={currencyCode ? t('requestNew.minimum', { currency: currencyCode }) : t('requestNew.minimumPlain')}
                htmlFor="budget-min" error={fieldErrors['budget.minAmountMinorUnits']}>
                <Input
                  id="budget-min"
                  type="number"
                  min={0}
                  value={budgetMin}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBudgetMin(e.target.value)}
                  invalid={Boolean(fieldErrors['budget.minAmountMinorUnits'])}
                />
              </FormField>
              <FormField
                label={currencyCode ? t('requestNew.maximum', { currency: currencyCode }) : t('requestNew.maximumPlain')}
                htmlFor="budget-max" error={fieldErrors['budget.maxAmountMinorUnits']}>
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
          <h2 className={styles.sectionTitle}>{t('requestNew.whenWhere')}</h2>
          <div className={styles.inlineFields}>
            <FormField label={t('requestNew.preferredAt')} htmlFor="preferred-at" optional error={fieldErrors.preferredAt}>
              <Input
                id="preferred-at"
                type="datetime-local"
                value={preferredAt}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPreferredAt(e.target.value)}
                invalid={Boolean(fieldErrors.preferredAt)}
              />
            </FormField>

            <FormField label={t('requestNew.urgencyLabel')} htmlFor="urgency">
              <Select
                id="urgency"
                value={urgency}
                onChange={(e) => setUrgency(e.target.value as RequestUrgency)}
                options={URGENCY_OPTIONS.map((option) => ({ value: option.value, label: t(option.label) }))}
              />
              {/* Spec 030 AC-6 — adjacent to the control and always visible while urgent is
                  selectable, never behind a tooltip or fine print. */}
              <UrgencyEmergencyNotice />
            </FormField>
          </div>

          {addresses.length === 0 ? (
            <FormField label={t('requestNew.address')} required error={fieldErrors.addressId} help={t('requestNew.addressHelp')}>
              <Link href="/account/addresses">
                <Button variant="secondary" iconLeft="map-pin">
                  {t('requestNew.addAddress')}
                </Button>
              </Link>
            </FormField>
          ) : (
            <FormField label={t('requestNew.address')} htmlFor="address" required error={fieldErrors.addressId}>
              <Select
                id="address"
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                placeholder={t('requestNew.chooseAddress')}
                options={addresses.map((address) => ({
                  value: address.id,
                  label: t('requestNew.addressOption', { label: address.label, area: address.approxAreaLabel }),
                }))}
                invalid={Boolean(fieldErrors.addressId)}
              />
            </FormField>
          )}
        </section>

        <div className={styles.formActions}>
          <Link href="/requests">
            <Button variant="ghost" type="button">
              {t('requestNew.cancel')}
            </Button>
          </Link>
          <Button
            type="submit"
            variant="primary"
            loading={submitting}
            disabled={addresses.length === 0 || !online}
            aria-describedby={online ? undefined : offlineNoticeId}
          >
            {t('requestNew.send')}
          </Button>
        </div>
        <OfflineWriteNotice id={offlineNoticeId} />
      </form>
    </main>
  );
}
