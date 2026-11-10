import { asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { serviceFields, services } from '@/lib/db/schema';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { requireCatalogPermission } from '@/lib/catalog/authorization';
import type { CreateServiceFieldRequest, ServiceFieldDto } from '@/lib/types/service-page';
import { servicePageNotFoundError, validationError } from './errors';

type ServiceFieldRow = typeof serviceFields.$inferSelect;

export function toServiceFieldDto(row: ServiceFieldRow): ServiceFieldDto {
  return {
    id: row.id,
    serviceId: row.serviceId,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: (row.options as string[] | null) ?? undefined,
    validation: (row.validation as ServiceFieldDto['validation']) ?? undefined,
    sortOrder: row.sortOrder,
  };
}

/** §3 `GET /api/v1/services/{id}/fields` — public, consumed identically by the manual request
 * form and the AI conversational flow (spec 015/034). */
export async function listServiceFields(serviceId: string): Promise<ServiceFieldDto[]> {
  const rows = await getDb().select().from(serviceFields).where(eq(serviceFields.serviceId, serviceId)).orderBy(asc(serviceFields.sortOrder));
  return rows.map(toServiceFieldDto);
}

/** §3 `POST /api/v1/admin/services/{id}/fields` — `400 VALIDATION_ERROR` when the field
 * definition itself is malformed (e.g. `select` with no `options`). */
export async function createServiceField(actorUserId: string, serviceId: string, body: CreateServiceFieldRequest): Promise<ServiceFieldDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.service_field', 'create');

  const [service] = await getDb().select({ id: services.id }).from(services).where(eq(services.id, serviceId));
  if (!service) throw servicePageNotFoundError('The referenced service does not exist.');

  const errors: { field: string; message: string }[] = [];
  if (typeof body.key !== 'string' || body.key.trim().length === 0) errors.push({ field: 'key', message: 'is required' });
  if (typeof body.label !== 'string' || body.label.trim().length === 0) errors.push({ field: 'label', message: 'is required' });
  if (!['text', 'select', 'number', 'boolean', 'media'].includes(body.type as string)) {
    errors.push({ field: 'type', message: 'must be one of text, select, number, boolean, media' });
  }
  if (body.type === 'select' && (!Array.isArray(body.options) || body.options.length === 0)) {
    errors.push({ field: 'options', message: 'is required and must be non-empty for type "select"' });
  }
  if (errors.length > 0) throw validationError(errors);

  const [row] = await getDb()
    .insert(serviceFields)
    .values({
      serviceId,
      key: body.key,
      label: body.label,
      type: body.type,
      required: body.required ?? false,
      options: body.type === 'select' ? body.options : null,
      validation: body.validation ?? null,
      sortOrder: body.sortOrder ?? 0,
    })
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'service_page.field_created',
    resource: 'catalog.service_field',
    action: 'create',
    targetType: 'service_field',
    targetId: row!.id,
    approvalChain: [],
  });

  return toServiceFieldDto(row!);
}

/**
 * Spec 011 §2 AC-3 / §1 "the single shared contract" — the one validator both the manual request
 * form (spec 015) and the AI conversational flow (spec 034) call against a service's
 * `ServiceField` definitions, so "missing a required field" is rejected identically regardless of
 * which path submitted it. Returns every missing/invalid field, not just the first, so the
 * caller can name them all (AC-3: "rejected with the specific missing fields named").
 */
export function validateFieldSubmission(fields: ServiceFieldDto[], values: Record<string, unknown>): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];

  for (const field of fields) {
    const value = values[field.key];
    const isEmpty = value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);

    if (field.required && isEmpty) {
      errors.push({ field: field.key, message: `${field.label} is required` });
      continue;
    }
    if (isEmpty) continue;

    if (field.type === 'select' && field.options && !field.options.includes(String(value))) {
      errors.push({ field: field.key, message: `${field.label} must be one of: ${field.options.join(', ')}` });
    }
    if (field.type === 'number' && typeof value !== 'number' && Number.isNaN(Number(value))) {
      errors.push({ field: field.key, message: `${field.label} must be a number` });
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      errors.push({ field: field.key, message: `${field.label} must be true or false` });
    }
    if (field.validation?.maxLength !== undefined && typeof value === 'string' && value.length > field.validation.maxLength) {
      errors.push({ field: field.key, message: `${field.label} must be at most ${field.validation.maxLength} characters` });
    }
    if (field.validation?.pattern !== undefined && typeof value === 'string' && !new RegExp(field.validation.pattern).test(value)) {
      errors.push({ field: field.key, message: `${field.label} is not in the expected format` });
    }
  }

  return errors;
}
