'use client';

/**
 * Spec 032 §5 — raising a ticket (AC-2, AC-4).
 *
 * THE ERROR STATE IS THE ONE THAT MATTERS MOST. §5 requires a failed submission to preserve
 * everything entered: someone describing a problem must never be made to type it a second time
 * because a request failed. So the draft lives in component state and nothing is cleared until the
 * server has accepted it — the same rule `app/support/report/page.tsx` already implements.
 *
 * THERE IS NO PRIORITY CONTROL, deliberately. Priority is derived from the category by the platform
 * (AC-4) and the API rejects the field outright, so offering a picker here would promise the user
 * something the server would refuse.
 *
 * CONTEXT IS PRE-FILLED FROM THE QUERY STRING and shown read-only. That is what makes AC-2's "not
 * requiring the user to re-explain it" true in practice — and it is never editable, because the
 * server re-authorizes whatever is sent and a hand-typed id would simply be refused.
 */
import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, ErrorState, Select, Textarea } from '@/components';
import { apiFetch, fieldErrorMap, mutateHeaders } from '@/app/requests/api-client';
import { SUPPORT_CATEGORIES, type SupportCategory, type SupportTicketDto } from '@/lib/types/support';
import styles from '../support.module.css';

const CATEGORY_LABELS: Record<SupportCategory, string> = {
  booking: 'A booking',
  payment: 'A payment or charge',
  account: 'My account or sign-in',
  provider_quality: 'The quality of a service I received',
  technical: 'Something is broken or not working',
  safety: 'A safety concern',
  other: 'Something else',
};

const CONTEXT_LABELS: Record<string, string> = {
  booking: 'this booking',
  payment: 'this payment',
  dispute: 'this dispute',
};

function NewTicketForm() {
  const router = useRouter();
  const params = useSearchParams();
  const contextType = params.get('contextType');
  const contextId = params.get('contextId');

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<SupportCategory>('booking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = { subject, description, category };
    if (contextType && contextId) {
      body.contextType = contextType;
      body.contextId = contextId;
    }

    const result = await apiFetch<SupportTicketDto>('/api/v1/support/tickets', {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify(body),
    });

    if (result.ok && result.data) {
      // Only now is the draft allowed to disappear.
      router.push(`/support/tickets/${result.data.id}`);
      return;
    }

    setFieldErrors(fieldErrorMap(result.error));
    setError(
      result.error?.code === 'SUPPORT_CONTEXT_NOT_AVAILABLE'
        ? 'We could not attach that item to your request. You can still describe it below and send it without the link.'
        : 'We could not send your request. Your message has been kept — please try again.',
    );
    setBusy(false);
  }, [subject, description, category, contextType, contextId, router]);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Talk to a human</h1>
      <p className={styles.body}>
        Tell us what is going on and a support admin will reply in your ticket.
      </p>

      {error ? <ErrorState title="We could not send that" description={error} /> : null}

      <Card>
        {contextType && contextId ? (
          <p className={styles.help}>
            This request is about {CONTEXT_LABELS[contextType] ?? 'the item you came from'}. We have
            attached it, so you do not need to explain which one.
          </p>
        ) : null}

        <label className={styles.label} htmlFor="support-category">
          What is this about?
        </label>
        <Select
          id="support-category"
          value={category}
          onChange={(event) => setCategory(event.target.value as SupportCategory)}
        >
          {SUPPORT_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {CATEGORY_LABELS[value]}
            </option>
          ))}
        </Select>
        {fieldErrors.category ? <p className={styles.help}>{fieldErrors.category}</p> : null}

        <label className={styles.label} htmlFor="support-subject">
          A short summary
        </label>
        <Textarea
          id="support-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          rows={1}
          maxLength={200}
        />
        {fieldErrors.subject ? <p className={styles.help}>{fieldErrors.subject}</p> : null}

        <label className={styles.label} htmlFor="support-description">
          What happened?
        </label>
        <Textarea
          id="support-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={6}
          maxLength={4000}
        />
        {fieldErrors.description ? <p className={styles.help}>{fieldErrors.description}</p> : null}

        <div className={styles.actions}>
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Sending…' : 'Send to support'}
          </Button>
        </div>
      </Card>
    </main>
  );
}

export default function NewSupportTicketPage() {
  return (
    <Suspense fallback={<main className={styles.page} />}>
      <NewTicketForm />
    </Suspense>
  );
}
