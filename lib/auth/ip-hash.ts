import { createHmac } from 'node:crypto';
import { deriveKey } from './secret';

/** `sessions.ip_hash` (spec 005 §4) stores a hash, never the raw IP — privacy by construction. */
export function hashRequestIp(request: Request): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const ip = forwardedFor?.split(',')[0]?.trim();
  if (!ip) return null;
  return createHmac('sha256', deriveKey('ip-hash')).update(ip).digest('hex');
}
