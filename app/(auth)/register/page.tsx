'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, FormField, Input } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
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
  const { t, errorText } = useLocale();
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
        setEmailError(t('auth.register.emailTaken'));
        return;
      }
      // Spec 042 X-3: a known code is shown in the reader's locale; otherwise the generic line.
      setGenericError(errorText(result.error?.code, null, t('auth.register.failed')));
      return;
    }

    router.push('/');
  }

  return (
    <AuthShell
      brandHeadline={t('auth.register.headline')}
      footer={
        <>
          {t('auth.register.haveAccount')}{' '}
          <a href="/login" className={styles.footerLink}>
            {t('auth.register.logIn')}
          </a>
        </>
      }
    >
      <div>
        <span className={styles.eyebrow}>{t('auth.register.eyebrow')}</span>
        <h1 className={styles.title}>{t('auth.register.title')}</h1>
        <p className={styles.subtitle}>{t('auth.register.subtitle')}</p>
      </div>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <FormField label={t('auth.email')} htmlFor="email" error={emailError ?? undefined} required>
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
          label={t('auth.password')}
          htmlFor="password"
          error={passwordError ?? undefined}
          help={passwordError ? undefined : t('auth.register.passwordHelp')}
          required
        >
          <Input
            id="password"
            type="password"
            size="lg"
            iconLeft="lock"
            autoComplete="new-password"
            placeholder={t('auth.register.passwordPlaceholder')}
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
          {t('auth.register.submit')}
        </Button>
      </form>

      <div className={styles.divider}>
        <hr className={styles.dividerLine} />
        <span className={styles.dividerLabel}>{t('auth.or')}</span>
        <hr className={styles.dividerLine} />
      </div>

      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled
          style={{ height: 'var(--auth-btn-h)', minHeight: 'var(--auth-btn-h)' }}
          title={t('auth.googleUnavailable')}
        >
          {t('auth.google')}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          disabled
          style={{ height: 'var(--auth-btn-h)', minHeight: 'var(--auth-btn-h)' }}
          title={t('auth.appleUnavailable')}
        >
          {t('auth.apple')}
        </Button>
      </div>
    </AuthShell>
  );
}
