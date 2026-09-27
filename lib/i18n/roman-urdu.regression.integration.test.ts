/**
 * Spec 042 AC-2 / §3.10 (D-10) — Roman Urdu (or any script) typed into search, interpretation or AI chat
 * reaches the existing pipeline BYTE-FOR-BYTE under any UI locale. No locale code blocks, transliterates,
 * normalizes or requires a locale switch.
 *
 * Each pipeline ENTRY (`searchServices`, `interpretSearchQuery`, `sendTurn`) is wrapped to record exactly
 * what the route handed it; how well the text is then UNDERSTOOD stays with specs 013, 033 and 034.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { IDEMPOTENCY_KEY_HEADER } from '@/lib/api/idempotency';
import { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import { isDatabaseReachable, useUrduLocaleFlag } from './i18n-test-support';

const captured = vi.hoisted(() => ({ search: [] as unknown[], interpret: [] as unknown[], turn: [] as unknown[] }));

vi.mock('@/lib/search/query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/search/query')>();
  return {
    ...actual,
    searchServices: vi.fn(async (params: { q?: string }) => {
      captured.search.push(params.q);
      return { items: [], total: 0 };
    }),
  };
});
vi.mock('@/lib/search/interpret', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/search/interpret')>();
  return {
    ...actual,
    interpretSearchQuery: vi.fn(async (text: string) => {
      captured.interpret.push(text);
      return { confidence: 'high' };
    }),
  };
});
vi.mock('@/lib/ai-assistant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-assistant')>();
  return {
    ...actual,
    sendTurn: vi.fn(async (_context: unknown, _key: string, body: { body?: unknown }) => {
      captured.turn.push(body.body);
      return { message: { id: randomUUID() }, replayed: false };
    }),
  };
});

const search = await import('@/app/api/v1/search/route');
const interpret = await import('@/app/api/v1/search/interpret/route');
const turns = await import('@/app/api/v1/ai/conversations/[id]/messages/route');

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

/** Roman Urdu, Nastaliq Urdu, mixed script, odd spacing/casing and punctuation — none of it may change. */
const INPUTS = [
  'mujhe kal subah AC theek karwana hai',
  'Plumber chahiye  jaldi!!  DHA phase 5 mein',
  'مجھے الیکٹریشن چاہیے',
  'bijli wala — 2000 tak, Karāchi',
  'ghar ki safai\tkarwani hai ',
];

const LOCALE_CONDITIONS = {
  en: { cookie: 'apuriva_locale=en', 'accept-language': 'en' },
  ur: { cookie: 'apuriva_locale=ur', 'accept-language': 'ur-PK,ur;q=0.9' },
} as const;

describe.skipIf(!dbReachable)('AC-2: Roman Urdu input is byte-identical through search, interpret and AI turns (spec 042 §3.10)', () => {
  const { setUrduLocale } = useUrduLocaleFlag();
  let session: TestSession;

  beforeAll(async () => {
    // The interpret route's own flag gate (spec 041 X-2) must be open to reach the pipeline at all.
    process.env.SEARCH_NL_INTERPRETATION_ENABLED = 'true';
    await setUrduLocale(true); // `ur` is a real, usable locale for these requests
    session = await registerAndLogin();
  });

  beforeEach(() => {
    resetRateLimitState();
    captured.search.length = 0;
    captured.interpret.length = 0;
    captured.turn.length = 0;
  });

  for (const [locale, headers] of Object.entries(LOCALE_CONDITIONS)) {
    it(`GET /search?q= under ${locale}`, async () => {
      for (const text of INPUTS) {
        const res = await search.GET(new Request(`${BASE}/search?q=${encodeURIComponent(text)}`, { headers: { ...headers, 'x-forwarded-for': '198.51.100.7' } }));
        expect(res.status, text).toBe(200);
      }
      expect(captured.search).toEqual(INPUTS);
    });

    it(`POST /search/interpret under ${locale}`, async () => {
      for (const text of INPUTS) {
        const res = await interpret.POST(
          new Request(`${BASE}/search/interpret`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
            body: JSON.stringify({ text }),
          }),
        );
        expect(res.status, text).toBe(200);
      }
      expect(captured.interpret).toEqual(INPUTS);
    });

    it(`POST /ai/conversations/{id}/messages under ${locale}`, async () => {
      for (const text of INPUTS) {
        const res = await turns.POST(
          new Request(`${BASE}/ai/conversations/${randomUUID()}/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}; ${headers.cookie}`,
              'accept-language': headers['accept-language'],
              [CSRF_HEADER_NAME]: session.csrfToken,
              [IDEMPOTENCY_KEY_HEADER]: randomUUID(),
            },
            body: JSON.stringify({ body: text }),
          }),
        );
        expect(res.status, text).toBe(201);
      }
      expect(captured.turn).toEqual(INPUTS);
    });
  }
});
