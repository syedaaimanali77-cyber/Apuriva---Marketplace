import { describe, expect, it } from 'vitest';
import { en } from './dictionaries/en';
import { ur } from './dictionaries/ur';
import { apiErrorKey, translateApiError, translateApiErrorWith } from './errors';
import { createTranslator } from './translator';

/** Spec 042 §3.7 (D-4) — client translation by stable code, with the server message as the fallback. */
describe('translateApiError (spec 042 §3.7)', () => {
  it('a known code renders the dictionary text for the locale', () => {
    expect(translateApiError('ur', 'BOOKING_NOT_FOUND', 'The requested booking does not exist.')).toBe(ur.errors.BOOKING_NOT_FOUND);
    expect(translateApiError('en', 'BOOKING_NOT_FOUND', 'whatever the server said')).toBe(en.errors.BOOKING_NOT_FOUND);
  });

  it('English entries are the platform’s canonical server messages, so English is unchanged', () => {
    expect(en.errors.VALIDATION_ERROR).toBe('The request failed validation.');
    expect(en.errors.NETWORK_ERROR).toBe('We could not reach the server.');
  });

  it('an unknown code renders the server’s message as sent', () => {
    expect(translateApiError('ur', 'PROFILE_NOT_FOUND_FOR_MODE', 'No provider profile exists for this account.')).toBe(
      'No provider profile exists for this account.',
    );
  });

  it('with neither a known code nor a message, it renders the fallback, else the generic line', () => {
    const t = createTranslator('ur', ur);
    expect(translateApiErrorWith(t, 'UNKNOWN', null, 'fallback text')).toBe('fallback text');
    expect(translateApiErrorWith(t, undefined, '')).toBe(ur.common.somethingWentWrong);
    expect(translateApiError('en', null, undefined)).toBe(en.common.somethingWentWrong);
  });

  it('apiErrorKey only names codes the dictionary knows', () => {
    expect(apiErrorKey('LOCALE_UNAVAILABLE')).toBe('errors.LOCALE_UNAVAILABLE');
    expect(apiErrorKey('NOT_A_CODE')).toBeNull();
    expect(apiErrorKey('')).toBeNull();
    expect(apiErrorKey(null)).toBeNull();
  });
});
