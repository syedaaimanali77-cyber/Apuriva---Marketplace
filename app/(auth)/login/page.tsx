'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, FormField, Input, OtpInput } from '@/components';
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

/** The CSRF cookie (spec 005 §3) is deliberately not httpOnly — the client reads it to echo back. */
function readCsrfCookie(): string | undefined {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1];
}

async function postJsonWithCsrf(url: string, body: unknown): Promise<{ ok: boolean; data?: any; error?: ApiErrorBody }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() ?? '' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return res.ok ? { ok: true, data: json.data } : { ok: false, error: json as ApiErrorBody };
}

/**
 * Spec 005 §5. Phone+OTP is the primary path (Pakistan-market expectation, §1); email+password
 * is the fallback. Google/Apple are rendered per the UI states description but disabled — spec
 * 005 §8 risk #1's decision ships only a sandbox OAuth adapter server-side (no real provider
 * credentials exist in this environment for a real browser redirect flow).
 *
 * Visual presentation only lives in this file and `../_components/AuthShell.tsx` /
 * `../auth.module.css` — every handler, API call, and validation rule below is unchanged from
 * the original implementation.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'phone' | 'password'>('phone');

  // Phone + OTP
  const [phoneNumber, setPhoneNumber] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);

  // Email + password
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [genericError, setGenericError] = useState<string | null>(null);

  // AC-5: admin login pending its second factor.
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [verifyingMfa, setVerifyingMfa] = useState(false);

  async function handleSendOtp() {
    setPhoneError(null);
    setSendingOtp(true);
    const result = await postJson('/api/v1/auth/otp/request', { phoneNumber });
    setSendingOtp(false);
    if (!result.ok) {
      setPhoneError(fieldError(result.error?.errors, 'phoneNumber') ?? result.error?.message ?? 'Something went wrong.');
      return;
    }
    setRequestId(result.data.requestId);
    setAttemptsLeft(5);
  }

  async function handleVerifyOtp(code: string) {
    if (!requestId) return;
    setOtpError(null);
    setVerifyingOtp(true);
    const result = await postJson('/api/v1/auth/otp/verify', { requestId, code });
    setVerifyingOtp(false);
    if (!result.ok) {
      if (result.error?.code === 'RATE_LIMITED') {
        setOtpError("Too many incorrect attempts. Request a new code.");
        setAttemptsLeft(0);
      } else if (result.error?.code === 'OTP_EXPIRED') {
        setOtpError('That code expired. Request a new one.');
      } else {
        setAttemptsLeft((n) => (n === null ? null : Math.max(0, n - 1)));
        setOtpError(`That code didn't work. ${attemptsLeft !== null ? `You have ${Math.max(0, (attemptsLeft ?? 1) - 1)} attempts left.` : ''}`);
      }
      return;
    }
    router.push('/');
  }

  async function handlePasswordLogin() {
    setEmailError(null);
    setPasswordError(null);
    setGenericError(null);
    setLoggingIn(true);
    const result = await postJson('/api/v1/auth/login', { email, password });
    setLoggingIn(false);
    if (!result.ok) {
      const missingEmail = fieldError(result.error?.errors, 'email');
      const missingPassword = fieldError(result.error?.errors, 'password');
      if (missingEmail || missingPassword) {
        setEmailError(missingEmail ?? null);
        setPasswordError(missingPassword ?? null);
        return;
      }
      // AC-3: never reveal whether the email exists — one generic message either way.
      setGenericError("We couldn't sign you in. Check your email and password and try again.");
      return;
    }
    if (result.data.mfaRequired) {
      setMfaPending(true);
      return;
    }
    router.push('/');
  }

  async function handleMfaVerify(code: string) {
    setMfaError(null);
    setVerifyingMfa(true);
    const result = await postJsonWithCsrf('/api/v1/auth/mfa/verify', { code });
    setVerifyingMfa(false);
    if (!result.ok) {
      setMfaError(result.error?.message ?? 'That code didn\'t work.');
      return;
    }
    router.push('/');
  }

  return (
    <AuthShell
      footer={
        <>
          No account?{' '}
          <a href="/register" className={styles.footerLink}>
            Register
          </a>
        </>
      }
    >
      {mfaPending ? (
        <>
          <div>
            <span className={styles.eyebrow}>Almost there</span>
            <h1 className={styles.title}>Verify it&rsquo;s you</h1>
            <p className={styles.subtitle}>Enter the code from your authenticator app to finish signing in.</p>
          </div>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              handleMfaVerify(mfaCode);
            }}
          >
            <FormField label="Authenticator code" htmlFor="mfa-code" error={mfaError ?? undefined}>
              <OtpInput
                id="mfa-code"
                value={mfaCode}
                onChange={setMfaCode}
                onComplete={handleMfaVerify}
                invalid={Boolean(mfaError)}
                disabled={verifyingMfa}
              />
            </FormField>
            <Button type="submit" variant="primary" size="lg" fullWidth loading={verifyingMfa} disabled={mfaCode.length !== 6}>
              Verify
            </Button>
          </form>
        </>
      ) : (
        <>
          <div>
            <span className={styles.eyebrow}>Welcome back</span>
            <h1 className={styles.title}>Log in</h1>
            <p className={styles.subtitle}>Pick up right where you left off.</p>
          </div>

          <div role="tablist" aria-label="Login method" className={styles.segmented}>
            <Button
              role="tab"
              aria-selected={mode === 'phone'}
              variant={mode === 'phone' ? 'primary' : 'ghost'}
              fullWidth
              className={styles.segmentedButton}
              onClick={() => setMode('phone')}
            >
              Phone
            </Button>
            <Button
              role="tab"
              aria-selected={mode === 'password'}
              variant={mode === 'password' ? 'primary' : 'ghost'}
              fullWidth
              className={styles.segmentedButton}
              onClick={() => setMode('password')}
            >
              Email
            </Button>
          </div>

          {mode === 'phone' ? (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                requestId ? handleVerifyOtp(otpCode) : handleSendOtp();
              }}
            >
              <FormField label="Phone number" htmlFor="phone" error={phoneError ?? undefined} required>
                <Input
                  id="phone"
                  type="tel"
                  size="lg"
                  iconLeft="phone"
                  autoComplete="tel"
                  placeholder="+92 300 1234567"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  invalid={Boolean(phoneError)}
                  disabled={Boolean(requestId)}
                />
              </FormField>

              {requestId ? (
                <FormField
                  label="Verification code"
                  htmlFor="otp"
                  help={otpError ? undefined : 'Enter the 6-digit code we sent you.'}
                  error={otpError ?? undefined}
                >
                  <OtpInput
                    id="otp"
                    value={otpCode}
                    onChange={setOtpCode}
                    onComplete={handleVerifyOtp}
                    invalid={Boolean(otpError)}
                    disabled={verifyingOtp || attemptsLeft === 0}
                  />
                </FormField>
              ) : null}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={requestId ? verifyingOtp : sendingOtp}
                disabled={requestId ? otpCode.length !== 6 || attemptsLeft === 0 : phoneNumber.length === 0}
              >
                {requestId ? 'Verify code' : 'Send code'}
              </Button>
            </form>
          ) : (
            <form
              className={styles.form}
              onSubmit={(e) => {
                e.preventDefault();
                handlePasswordLogin();
              }}
            >
              <FormField label="Email" htmlFor="email" error={emailError ?? undefined} required>
                <Input
                  id="email"
                  type="email"
                  size="lg"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  invalid={Boolean(emailError)}
                />
              </FormField>
              <FormField label="Password" htmlFor="password" error={passwordError ?? undefined} required>
                <Input
                  id="password"
                  type="password"
                  size="lg"
                  iconLeft="lock"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  invalid={Boolean(passwordError)}
                />
              </FormField>
              {genericError ? <Alert tone="error">{genericError}</Alert> : null}
              <Button type="submit" variant="primary" size="lg" fullWidth loading={loggingIn}>
                Log in
              </Button>
            </form>
          )}

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
              title="Real Google sign-in needs provider credentials — spec 005 §8 risk #1 ships a sandbox adapter only"
            >
              Continue with Google
            </Button>
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              disabled
              title="Real Apple sign-in needs provider credentials — spec 005 §8 risk #1 ships a sandbox adapter only"
            >
              Continue with Apple
            </Button>
          </div>
        </>
      )}
    </AuthShell>
  );
}
