'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, FormField, Input } from '@/components';
import { AuthShell } from '../_components/AuthShell';
import styles from '../auth.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data?: any; error?: ApiErrorBody }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return res.ok ? { ok: true, data: json.data } : { ok: false, error: json as ApiErrorBody };
}

function fieldError(errors: ApiErrorBody['errors'], field: string): string | undefined {
  return errors?.find((e) => e.field === field)?.message;
}

/**
 * Spec 005 §5, `app/(auth)/register` — email+password account creation. Visual presentation only
 * lives in this file and `../_components/AuthShell.tsx` / `../auth.module.css` — every handler,
 * API call, and validation rule below is unchanged from the original implementation.
 */
export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setEmailError(null);
    setPasswordError(null);
    setGenericError(null);
    setSubmitting(true);
    const result = await postJson('/api/v1/auth/register', { email, password });
    setSubmitting(false);

    if (!result.ok) {
      const missingEmail = fieldError(result.error?.errors, 'email');
      const missingPassword = fieldError(result.error?.errors, 'password');
      if (missingEmail || missingPassword) {
        setEmailError(missingEmail ?? null);
        setPasswordError(missingPassword ?? null);
        return;
      }
      if (result.error?.code === 'CONFLICT') {
        setEmailError('An account with this email already exists.');
        return;
      }
      setGenericError("We couldn't create your account. Please try again.");
      return;
    }

    router.push('/');
  }

  return (
    <AuthShell
      brandHeadline="Join the marketplace built for getting things done."
      footer={
        <>
          Already have an account?{' '}
          <a href="/login" className={styles.footerLink}>
            Log in
          </a>
        </>
      }
    >
      <div>
        <span className={styles.eyebrow}>Get started</span>
        <h1 className={styles.title}>Create your account</h1>
        <p className={styles.subtitle}>Post a request, get offers, and get it done — free to join.</p>
      </div>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <FormField label="Email" htmlFor="email" error={emailError ?? undefined} required>
          <Input
            id="email"
            type="email"
            size="lg"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={Boolean(emailError)}
          />
        </FormField>
        <FormField
          label="Password"
          htmlFor="password"
          error={passwordError ?? undefined}
          help={passwordError ? undefined : 'At least 8 characters.'}
          required
        >
          <Input
            id="password"
            type="password"
            size="lg"
            iconLeft="lock"
            autoComplete="new-password"
            placeholder="Create a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={Boolean(passwordError)}
          />
        </FormField>
        {genericError ? <Alert tone="error">{genericError}</Alert> : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          fullWidth
          loading={submitting}
          style={{ height: 'var(--auth-btn-h)', minHeight: 'var(--auth-btn-h)' }}
        >
          Create account
        </Button>
      </form>

      <div className={styles.divider}>
        <hr className={styles.dividerLine} />
        <span className={styles.dividerLabel}>or</span>
        <hr className={styles.dividerLine} />
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled
          style={{ height: 'var(--auth-btn-h)', minHeight: 'var(--auth-btn-h)' }}
          title="Real Google sign-in needs provider credentials — spec 005 §8 risk #1 ships a sandbox adapter only"
        >
          Continue with Google
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled
          style={{ height: 'var(--auth-btn-h)', minHeight: 'var(--auth-btn-h)' }}
          title="Real Apple sign-in needs provider credentials — spec 005 §8 risk #1 ships a sandbox adapter only"
        >
          Continue with Apple
        </Button>
      </div>
    </AuthShell>
  );
}
