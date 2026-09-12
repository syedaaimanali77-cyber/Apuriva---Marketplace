import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  addresses,
  customerProfiles,
  fileAssets,
  requestAttachments,
  requestFieldValues,
  requests,
  requestsStatusHistory,
  services,
} from '@/lib/db/schema';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { listServiceFields, validateFieldSubmission } from '@/lib/service-page/fields';
import type { CreateRequestRequest, RequestDto, RequestUrgency } from '@/lib/types/requests';
import { parseBudget } from './budget';
import { idempotencyKeyConflictError, validationError } from './errors';
import { toRequestDto } from './read';

const URGENCIES: RequestUrgency[] = ['normal', 'urgent'];
const MAX_DESCRIPTION_LENGTH = 4000;

/**
 * Spec 015 AC-1/AC-2/AC-3/AC-6 — the **single authoritative request-creation path**. The HTTP route
 * (`app/api/v1/requests/route.ts`) is a thin transport wrapper around this function and holds no
 * validation of its own, and a future MCP tool (spec 036) calls this same function: there is
 * deliberately no second, weaker path (master spec §132.9, §132.18).
 *
 * Validation reuses spec 011's shared validator (`validateFieldSubmission`) verbatim rather than
 * re-deriving field rules here, so "missing a required field" is rejected identically regardless of
 * which caller submitted it.
 *
 * The whole create is one transaction: insert `draft`, write field values and attachment links,
 * `UPDATE ... SET status = 'submitted'` (which the `requests_status_transition_trg` DB trigger
 * checks against `requests_status_transitions`), and record both history rows. Any failure rolls
 * everything back, so AC-2's "no request record is created" holds literally.
 */
export async function createRequest(
  userId: string,
  idempotencyKey: string,
  body: Partial<CreateRequestRequest>,
): Promise<{ request: RequestDto; replayed: boolean }> {
  const db = getDb();

  const [customerProfile] = await db
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));
  // Every authenticated account gets a `CustomerProfile` on register/login (spec 006's
  // `ensureCustomerProfile`), so this is a genuine invariant breach rather than a user error.
  if (!customerProfile) throw validationError([{ field: 'customerProfile', message: 'is missing for this account' }]);

  const fingerprint = idempotencyFingerprint(body);

  // §3 Idempotency — checked before any validation work so a retry of an already-accepted request
  // is cheap and can never produce a second row.
  const existing = await findByIdempotencyKey(customerProfile.id, idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw idempotencyKeyConflictError();
    return { request: await toRequestDto(existing.id), replayed: true };
  }

  const errors: { field: string; message: string }[] = [];

  if (typeof body.serviceId !== 'string' || body.serviceId.trim().length === 0) {
    errors.push({ field: 'serviceId', message: 'is required' });
  }
  if (typeof body.description !== 'string' || body.description.trim().length === 0) {
    errors.push({ field: 'description', message: 'is required' });
  } else if (body.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push({ field: 'description', message: `must be at most ${MAX_DESCRIPTION_LENGTH} characters` });
  }
  if (typeof body.addressId !== 'string' || body.addressId.trim().length === 0) {
    errors.push({ field: 'addressId', message: 'is required' });
  }
  if (!URGENCIES.includes(body.urgency as RequestUrgency)) {
    errors.push({ field: 'urgency', message: 'must be one of normal, urgent' });
  }

  const preferred = parsePreferredTime(body, errors);
  const budget = parseBudget(body.budget);
  errors.push(...budget.errors);

  if (errors.length > 0) throw validationError(errors);

  // Resolves only for a `published` service — the same customer-facing visibility rule spec 010's
  // `getServicePublic` and spec 013's search apply. A draft/pending/retired service is reported as
  // an invalid `serviceId`, never as a 404, so catalog existence isn't probeable here.
  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, body.serviceId!), eq(services.status, 'published')));
  if (!service) throw validationError([{ field: 'serviceId', message: 'does not match a published service' }]);

  // §5 address integration: ownership is the caller's own `addresses.user_id` (spec 012's model) —
  // no second address model, and not-owned is reported exactly like not-found.
  const [address] = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.id, body.addressId!), eq(addresses.userId, userId)));
  if (!address) throw validationError([{ field: 'addressId', message: 'does not match one of your saved addresses' }]);

  const fields = await listServiceFields(service.id);
  const fieldValues = (body.fieldValues ?? {}) as Record<string, string | number | boolean>;

  const unknownKeys = Object.keys(fieldValues).filter((key) => !fields.some((field) => field.key === key));
  const fieldErrors = [
    ...validateFieldSubmission(fields, fieldValues),
    ...unknownKeys.map((key) => ({ field: key, message: 'is not a field of this service' })),
  ];
  if (fieldErrors.length > 0) throw validationError(fieldErrors);

  const attachmentIds = await validateAttachments(userId, body.attachmentIds);

  const fieldIdByKey = new Map(fields.map((field) => [field.key, field.id]));

  const requestId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(requests)
      .values({
        customerProfileId: customerProfile.id,
        serviceId: service.id,
        status: 'draft',
        description: body.description!.trim(),
        ...budget.columns,
        preferredAt: preferred.preferredAt,
        preferredTimezone: preferred.preferredTimezone,
        addressId: address.id,
        urgency: body.urgency as RequestUrgency,
        idempotencyKey,
        idempotencyFingerprint: fingerprint,
      })
      .returning({ id: requests.id });
    const id = created!.id;

    const valueRows = Object.entries(fieldValues)
      .filter(([key]) => fieldIdByKey.has(key))
      .map(([key, value]) => ({ requestId: id, serviceFieldId: fieldIdByKey.get(key)!, value }));
    if (valueRows.length > 0) await tx.insert(requestFieldValues).values(valueRows);

    if (attachmentIds.length > 0) {
      await tx.insert(requestAttachments).values(attachmentIds.map((fileAssetId) => ({ requestId: id, fileAssetId })));
    }

    await tx.insert(requestsStatusHistory).values({ requestId: id, fromStatus: null, toStatus: 'draft', actorUserId: userId });

    // AC-1: the real, DB-checked `draft -> submitted` transition (spec 003's trigger validates it
    // against `requests_status_transitions`, which this spec's migration seeds).
    await tx
      .update(requests)
      .set({ status: 'submitted', version: 2, updatedAt: new Date() })
      .where(and(eq(requests.id, id), eq(requests.version, 1)));

    await tx
      .insert(requestsStatusHistory)
      .values({ requestId: id, fromStatus: 'draft', toStatus: 'submitted', actorUserId: userId });

    return id;
  });

  return { request: await toRequestDto(requestId), replayed: false };
}

async function findByIdempotencyKey(
  customerProfileId: string,
  idempotencyKey: string,
): Promise<{ id: string; fingerprint: string } | null> {
  const [row] = await getDb()
    .select({ id: requests.id, fingerprint: requests.idempotencyFingerprint })
    .from(requests)
    .where(and(eq(requests.customerProfileId, customerProfileId), eq(requests.idempotencyKey, idempotencyKey)));
  return row ?? null;
}

function parsePreferredTime(
  body: Partial<CreateRequestRequest>,
  errors: { field: string; message: string }[],
): { preferredAt: Date | null; preferredTimezone: string | null } {
  if (body.preferredAt === undefined || body.preferredAt === null) {
    if (body.preferredTimezone !== undefined) {
      errors.push({ field: 'preferredAt', message: 'is required when preferredTimezone is supplied' });
    }
    return { preferredAt: null, preferredTimezone: null };
  }

  const parsed = new Date(body.preferredAt);
  if (Number.isNaN(parsed.getTime())) {
    errors.push({ field: 'preferredAt', message: 'must be an ISO-8601 date-time' });
    return { preferredAt: null, preferredTimezone: null };
  }

  // Spec 003 AC-2: the instant is stored with the original IANA zone so local wall-clock time
  // stays reconstructible. Validated against the platform's own zone database, never a hardcoded
  // list (master spec §132.19 — no Pakistan-specific assumption baked into core).
  if (body.preferredTimezone !== undefined && !isValidTimeZone(body.preferredTimezone)) {
    errors.push({ field: 'preferredTimezone', message: 'must be a valid IANA time zone identifier' });
    return { preferredAt: null, preferredTimezone: null };
  }

  return { preferredAt: parsed, preferredTimezone: body.preferredTimezone ?? null };
}

function isValidTimeZone(timeZone: unknown): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * §3/§8 #1: this spec ships the *linkage* only. Every supplied id must already exist in
 * `file_assets` and belong to the caller; count/size/type limits are spec 027's and are
 * deliberately not invented here.
 */
async function validateAttachments(userId: string, attachmentIds: unknown): Promise<string[]> {
  if (attachmentIds === undefined || attachmentIds === null) return [];
  if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string')) {
    throw validationError([{ field: 'attachmentIds', message: 'must be an array of file asset ids' }]);
  }
  const ids = [...new Set(attachmentIds as string[])];
  if (ids.length === 0) return [];

  const owned = await getDb()
    .select({ id: fileAssets.id })
    .from(fileAssets)
    .where(and(inArray(fileAssets.id, ids), eq(fileAssets.uploadedByUserId, userId)));
  const ownedIds = new Set(owned.map((row) => row.id));

  const invalid = ids.filter((id) => !ownedIds.has(id));
  if (invalid.length > 0) {
    throw validationError(invalid.map(() => ({ field: 'attachmentIds', message: 'does not match one of your files' })));
  }
  return ids;
}
