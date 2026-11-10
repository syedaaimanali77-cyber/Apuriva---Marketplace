/**
 * Spec 042 §6 "Route-level" — the Urdu journey through the real route handlers:
 *
 *   `urdu-locale` on → a customer saves `ur` → the locale list resolves `ur` and names the market currency →
 *   a search → a request with a budget in that currency → error codes on the way resolve to Urdu text.
 *
 * Vitest, not Playwright: this repository has no browser runner, and `e2e/*.spec.ts` is the filename
 * convention spec 005 §6 established for end-to-end coverage (spec 042 §6 claims no browser E2E).
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { platformCurrencyCode } from '@/lib/config/currency';
import { ur } from '@/lib/i18n/dictionaries/ur';
import { translateApiError } from '@/lib/i18n/errors';
import { formatMoney } from '@/lib/i18n/format';
import { translate } from '@/lib/i18n/translate';
import { useUrduLocaleFlag } from '@/lib/i18n/i18n-test-support';
import { GET as LOCALES } from '@/app/api/v1/locales/route';
import { PATCH as SET_LOCALE } from '@/app/api/v1/users/me/locale/route';
import { GET as SEARCH } from '@/app/api/v1/search/route';
import { POST as CREATE_REQUEST } from '@/app/api/v1/requests/route';
import { GET as REQUEST_DETAIL } from '@/app/api/v1/requests/[id]/route';
import {
  authenticatedRequest,
  createRequestHttp,
  isDatabaseReachable,
  registerCustomerWithAddress,
  seedPublishedService,
  validRequestBody,
  type TestService,
} from '@/app/api/v1/requests/requests-test-support';
import type { TestSession } from '@/app/api/v1/users/me/privacy-test-support';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

describe.skipIf(!dbReachable)('spec 042 Urdu journey, end to end (route level)', () => {
  const { setUrduLocale } = useUrduLocaleFlag();
  let customer: TestSession & { addressId: string };
  let service: TestService;

  beforeAll(async () => {
    await setUrduLocale(true);
    customer = await registerCustomerWithAddress();
    service = await seedPublishedService();
  });

  beforeEach(() => resetRateLimitState());

  const withSession = (url: string, init?: RequestInit) =>
    new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${customer.sessionId}` } });

  it('switches to ur, searches, creates a request in the market currency, and resolves error codes in Urdu', async () => {
    // 1. Save ur (L2).
    const saved = await SET_LOCALE(authenticatedRequest(`${BASE}/users/me/locale`, customer.sessionId, customer.csrfToken, { method: 'PATCH', body: { locale: 'ur' } }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).data).toEqual({ locale: 'ur', resolvedLocale: 'ur', direction: 'rtl' });

    // 2. The locale list (L1): ur resolved, and the market default currency for the request form.
    const locales = await LOCALES(withSession(`${BASE}/locales`));
    const localesBody = (await locales.json()).data as { resolvedLocale: string; platformCurrencyCode: string };
    expect(localesBody.resolvedLocale).toBe('ur');
    expect(localesBody.platformCurrencyCode).toBe(platformCurrencyCode());

    // 3. Search, under ur — the query reaches search unchanged (AC-2 is asserted byte-for-byte elsewhere).
    const found = await SEARCH(withSession(`${BASE}/search?q=${encodeURIComponent(service.name)}`, { headers: { 'x-forwarded-for': '192.0.2.10' } }));
    expect(found.status).toBe(200);

    // 4. Create a request whose budget is in L1's currency (X-8: no client-side PKR literal).
    const currencyCode = localesBody.platformCurrencyCode;
    const created = await CREATE_REQUEST(
      createRequestHttp(customer, randomUUID(), validRequestBody(service, customer.addressId, { budget: { amountMinorUnits: 350_000, currencyCode } })),
    );
    expect(created.status).toBe(201);
    const request = (await created.json()).data as { id: string; status: string; budget: { amountMinorUnits: number; currencyCode: string } };
    expect(request.budget).toEqual({ amountMinorUnits: 350_000, currencyCode });
    // The client renders it with the value's own currency, in Urdu, and translates the step by status code.
    expect(formatMoney(request.budget.amountMinorUnits, request.budget.currencyCode, 'ur')).toMatch(/3,?500/);
    expect(translate('ur', `requestDetail.step.${request.status}` as never)).toBe(ur.requestDetail.step.submitted);

    // 5. Error codes on the journey are resolvable to Urdu (§3.7); the API envelope itself stays English.
    const invalid = await CREATE_REQUEST(createRequestHttp(customer, randomUUID(), { serviceId: service.id }));
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json();
    expect(invalidBody.code).toBe('VALIDATION_ERROR');
    expect(translateApiError('ur', invalidBody.code, invalidBody.message)).toBe(ur.errors.VALIDATION_ERROR);

    const missing = await REQUEST_DETAIL(withSession(`${BASE}/requests/${randomUUID()}`));
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody.code).toBe('REQUEST_NOT_FOUND');
    expect(translateApiError('ur', missingBody.code, missingBody.message)).toBe(ur.errors.REQUEST_NOT_FOUND);
    expect(ur.errors.REQUEST_NOT_FOUND).not.toBe(missingBody.message);

    // An unknown code falls back to the server's own message.
    expect(translateApiError('ur', 'SOME_FUTURE_CODE', 'Server says so')).toBe('Server says so');
  });

  it('turning the flag off takes effect on the next request, with no deploy (AC-8)', async () => {
    await setUrduLocale(false);
    const locales = await LOCALES(withSession(`${BASE}/locales`));
    const body = (await locales.json()).data as { resolvedLocale: string; locales: Array<{ code: string }> };
    expect(body.resolvedLocale).toBe('en');
    expect(body.locales.map((l) => l.code)).toEqual(['en']);
    await setUrduLocale(true);
  });
});
