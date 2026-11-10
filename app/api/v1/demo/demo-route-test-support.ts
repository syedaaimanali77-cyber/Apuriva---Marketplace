/** Spec 045 §6 — shared helpers for the demo route integration tests. */
import type { NextResponse } from 'next/server';
import { csrfCookieFrom, sessionCookieFrom } from '@/app/api/v1/auth/test-support';
import { POST as DEMO_LOGIN } from './login/route';

export const BASE = 'http://localhost/api/v1';

/** A guest request from a fixed address, so the `auth` rate-limit key is predictable per test. */
export function demoLoginRequest(body: unknown, ip = '203.0.113.10'): Request {
  return new Request(`${BASE}/demo/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

export interface DemoVisitor {
  userId: string;
  sessionId: string;
  csrfToken: string;
}

export async function loginAs(persona: 'customer' | 'provider', ip?: string): Promise<DemoVisitor> {
  const res = (await DEMO_LOGIN(demoLoginRequest({ persona }, ip))) as NextResponse;
  if (res.status !== 200) throw new Error(`demo login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { userId: string } };
  return { userId: body.data.userId, sessionId: sessionCookieFrom(res)!, csrfToken: csrfCookieFrom(res)! };
}
