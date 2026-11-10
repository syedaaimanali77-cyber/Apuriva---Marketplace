import { describe, expect, it } from 'vitest';
import { hasValidMonitoringToken, MONITORING_TOKEN_MIN_LENGTH } from './access';

const TOKEN = 'm'.repeat(MONITORING_TOKEN_MIN_LENGTH);
const req = (authorization?: string) =>
  new Request('http://localhost/api/v1/health/detailed', { headers: authorization === undefined ? {} : { authorization } });

describe('hasValidMonitoringToken (spec 046 §3.7)', () => {
  it('accepts exactly "Bearer <MONITORING_TOKEN>"', () => {
    expect(hasValidMonitoringToken(req(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['a wrong token', `Bearer ${'x'.repeat(MONITORING_TOKEN_MIN_LENGTH)}`],
    ['a prefix', `Bearer ${TOKEN.slice(1)}`],
    ['no Bearer scheme', TOKEN],
  ])('refuses %s', (_label, header) => {
    expect(hasValidMonitoringToken(req(header), TOKEN)).toBe(false);
  });

  it('authorizes nothing while the configured token is unset or shorter than 32 characters', () => {
    expect(hasValidMonitoringToken(req('Bearer '), undefined)).toBe(false);
    expect(hasValidMonitoringToken(req('Bearer short'), 'short')).toBe(false);
  });
});
