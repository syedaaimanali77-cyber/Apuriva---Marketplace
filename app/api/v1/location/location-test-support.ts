import { POST as register } from '@/app/api/v1/auth/register/route';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { authenticatedRequest, isDatabaseReachable, uniqueEmail } from '@/app/api/v1/auth/test-support';

export { authenticatedRequest, isDatabaseReachable, uniqueEmail };

/** Same register-and-extract-session pattern as app/api/v1/users/provider-profile.integration.test.ts. */
export async function registerAndLogin(): Promise<{ sessionId: string; csrfToken: string; userId: string }> {
  const res = await register(
    new Request('http://localhost/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail(), password: 'correct horse battery staple' }),
    }),
  );
  const { data } = await res.json();
  const csrfToken = res.cookies.get(CSRF_COOKIE_NAME)?.value!;
  return { sessionId: data.sessionId, csrfToken, userId: data.userId };
}
