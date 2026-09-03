import { describe, expect, it } from 'vitest';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';

/**
 * Spec 004 AC-3, integration-level: a real Route-Handler-shaped function (built from the shared
 * lib/api/* helpers, the same way a domain spec's route would be) rejects a malformed request
 * with 400 VALIDATION_ERROR and an errors[] array naming each invalid field. This spec itself
 * introduces no domain endpoints (§3), so the handler is constructed inline here rather than
 * registered under app/api/v1/ — see api-foundation.integration.test.ts for the same contract
 * exercised end-to-end alongside the real /api/v1/health route.
 */
interface CreateWidgetBody {
  name?: unknown;
  quantity?: unknown;
}

const createWidget = withApiRoute(async (request, correlationId) => {
  const body = (await request.json()) as CreateWidgetBody;
  const errors: { field: string; message: string }[] = [];

  if (typeof body.name !== 'string' || body.name.trim() === '') {
    errors.push({ field: 'name', message: 'is required' });
  }
  if (typeof body.quantity !== 'number' || body.quantity <= 0) {
    errors.push({ field: 'quantity', message: 'must be a positive number' });
  }
  if (errors.length > 0) throw validationError(errors);

  return apiSuccess({ name: body.name, quantity: body.quantity }, correlationId);
});

describe('POST-shaped handler validation (spec 004 AC-3, integration)', () => {
  it('returns 400 VALIDATION_ERROR naming every invalid field', async () => {
    const req = new Request('http://localhost/api/v1/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: '', quantity: -1 }),
    });

    const res = await createWidget(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual(
      expect.arrayContaining([
        { field: 'name', message: 'is required' },
        { field: 'quantity', message: 'must be a positive number' },
      ]),
    );
    expect(typeof body.correlationId).toBe('string');
  });

  it('accepts a well-formed request and returns the standard success envelope', async () => {
    const req = new Request('http://localhost/api/v1/widgets', {
      method: 'POST',
      body: JSON.stringify({ name: 'Widget', quantity: 3 }),
    });

    const res = await createWidget(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ name: 'Widget', quantity: 3 });
    expect(typeof body.correlationId).toBe('string');
  });
});
