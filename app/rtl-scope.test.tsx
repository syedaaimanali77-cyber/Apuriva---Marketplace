// @vitest-environment jsdom
/**
 * Spec 042 §6 "Component" (AC-1, AC-6) — a representative page per §5.1 in-scope area renders Urdu under
 * `ur`: Urdu platform text, no raw dictionary key, and none of the English strings the `ur` dictionary
 * translates. Every API call fails with a KNOWN stable code, so each page is driven into its translated
 * error/empty state with no authored (untranslated-by-design, §7) content on screen.
 */
import type { ComponentType } from 'react';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from './_components/LocaleProvider';
import { en } from '@/lib/i18n/dictionaries/en';
import { ur } from '@/lib/i18n/dictionaries/ur';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ category: 'cleaning', service: 'deep-clean', id: '00000000-0000-4000-8000-000000000001' }),
}));

/** Every `[key, en, ur]` leaf, flattened. */
function leaves(node: unknown, urNode: unknown, prefix = ''): Array<[string, string, string | undefined]> {
  if (typeof node === 'string') return [[prefix, node, typeof urNode === 'string' ? urNode : undefined]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) =>
    leaves(v, urNode && typeof urNode === 'object' ? (urNode as Record<string, unknown>)[k] : undefined, prefix ? `${prefix}.${k}` : k),
  );
}
const ALL = leaves(en, ur);
const KEYS = ALL.map(([key]) => key);
/** Long enough to be unambiguous, and actually translated (a brand name or `{amount}` alone is not). */
const TRANSLATED_ENGLISH = ALL.filter(([, e, u]) => u !== undefined && u !== e && e.length >= 12 && !/\{/.test(e)).map(([, e]) => e);

const URDU_SCRIPT = /[؀-ۿ]/;

class NoopIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ code: 'INTERNAL_ERROR', message: 'server english message', correlationId: 'c' }),
      text: async () => '',
    })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGES: Array<[string, () => Promise<{ default: ComponentType }>]> = [
  ['auth: /login', () => import('./(auth)/login/page')],
  ['auth: /register', () => import('./(auth)/register/page')],
  ['home: /', () => import('./page')],
  ['explore: /explore', () => import('./explore/page')],
  ['explore: /explore/[category]', () => import('./explore/[category]/page')],
  ['search: /search', () => import('./search/page')],
  ['requests: /requests', () => import('./requests/page')],
  ['bookings: /bookings', () => import('./bookings/page')],
  ['account: /account', () => import('./account/page')],
  ['account: /account/notifications', () => import('./account/notifications/page')],
  ['support: /support', () => import('./support/page')],
  ['chrome: not-found', () => import('./not-found')],
];

describe('in-scope areas render Urdu under ur (spec 042 §5.1, AC-1)', () => {
  it.each(PAGES)('%s', async (_name, load) => {
    const { default: Page } = await load();
    const { container } = render(
      <LocaleProvider locale="ur" messages={ur}>
        <div dir="rtl">
          <Page />
        </div>
      </LocaleProvider>,
    );
    // Let the page's first round of (failing) requests settle into its error/empty state.
    await waitFor(() => expect(container.textContent ?? '').toMatch(URDU_SCRIPT));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const text = container.textContent ?? '';
    const attributes = Array.from(container.querySelectorAll('[aria-label],[placeholder],[title],[alt]'))
      .flatMap((el) => ['aria-label', 'placeholder', 'title', 'alt'].map((a) => el.getAttribute(a) ?? ''))
      .join('\n');
    const visible = `${text}\n${attributes}`;

    expect(visible).toMatch(URDU_SCRIPT);
    expect(KEYS.filter((key) => key.includes('.') && visible.includes(key))).toEqual([]);
    expect(TRANSLATED_ENGLISH.filter((english) => visible.includes(english))).toEqual([]);
    expect(visible).not.toContain('server english message');
  });
});
