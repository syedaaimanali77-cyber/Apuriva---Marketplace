import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerProfiles, providerServices, serviceFaqs, services } from '@/lib/db/schema';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { requireCatalogPermission } from '@/lib/catalog/authorization';
import { ApiRouteError } from '@/lib/api/errors';
import type { CreateServiceFaqRequest, ServiceFaqAdminDto } from '@/lib/types/service-page';
import { faqOwnershipForbiddenError, servicePageNotFoundError, validationError } from './errors';

type ServiceFaqRow = typeof serviceFaqs.$inferSelect;

function toAdminDto(row: ServiceFaqRow): ServiceFaqAdminDto {
  return {
    id: row.id,
    serviceId: row.serviceId,
    providerId: row.providerProfileId,
    question: row.question,
    answer: row.answer,
    source: row.source,
    status: row.status,
  };
}

/** Spec 011 §3 `ServicePageDto.faqs[]` — customer-facing, published only, and never exposes the
 * raw `ai_suggested` source: once approved/published, an AI-drafted FAQ displays as `official`
 * (AC-5 — "never shown to customers as official until an admin publishes it" implies it *is*
 * shown as official once published). A `provider`-sourced FAQ stays visibly `provider` (AC-6). */
export function toPublicFaqDto(row: ServiceFaqRow): { id: string; question: string; answer: string; source: 'official' | 'provider'; providerId?: string } {
  const source = row.source === 'provider' ? 'provider' : 'official';
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    source,
    providerId: row.providerProfileId ?? undefined,
  };
}

/** §3 `ServicePageDto.faqs[]` data source. */
export async function listPublicFaqs(serviceId: string): Promise<ReturnType<typeof toPublicFaqDto>[]> {
  const rows = await getDb()
    .select()
    .from(serviceFaqs)
    .where(and(eq(serviceFaqs.serviceId, serviceId), eq(serviceFaqs.status, 'published')));
  return rows.map(toPublicFaqDto);
}

function validateFaqBody(body: Partial<CreateServiceFaqRequest>): void {
  const errors: { field: string; message: string }[] = [];
  if (typeof body.question !== 'string' || body.question.trim().length === 0) errors.push({ field: 'question', message: 'is required' });
  if (typeof body.answer !== 'string' || body.answer.trim().length === 0) errors.push({ field: 'answer', message: 'is required' });
  if (errors.length > 0) throw validationError(errors);
}

/** §3 `POST /api/v1/admin/services/{id}/faqs` — an official FAQ, published immediately (an admin
 * is already authoritative; no review gate applies to admin-authored content, only to
 * `ai_suggested` rows — see approveAiSuggestedFaq). */
export async function createOfficialFaq(actorUserId: string, serviceId: string, body: Partial<CreateServiceFaqRequest>): Promise<ServiceFaqAdminDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.service_faq', 'create');
  validateFaqBody(body);

  const [service] = await getDb().select({ id: services.id }).from(services).where(eq(services.id, serviceId));
  if (!service) throw servicePageNotFoundError('The referenced service does not exist.');

  const [row] = await getDb()
    .insert(serviceFaqs)
    .values({ serviceId, providerProfileId: null, question: body.question!, answer: body.answer!, source: 'official', status: 'published' })
    .returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'service_page.faq_created',
    resource: 'catalog.service_faq',
    action: 'create',
    targetType: 'service_faq',
    targetId: row!.id,
    approvalChain: [],
  });

  return toAdminDto(row!);
}

/** §3 `POST /api/v1/providers/me/services/{id}/faqs` — session (provider, ownership-checked):
 * the caller must have an active `ProviderProfile` actually offering this service
 * (`provider_services`), never an admin permission grant. Published immediately — providers
 * self-publish their own FAQ content; AC-6 keeps it visibly distinguished (`source: 'provider'`). */
export async function createProviderFaq(userId: string, serviceId: string, body: Partial<CreateServiceFaqRequest>): Promise<ServiceFaqAdminDto> {
  validateFaqBody(body);

  const [provider] = await getDb().select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId));
  if (!provider) throw faqOwnershipForbiddenError('Only a provider offering this service may add a FAQ for it.');

  const [service] = await getDb().select({ id: services.id }).from(services).where(eq(services.id, serviceId));
  if (!service) throw servicePageNotFoundError('The referenced service does not exist.');

  const [offering] = await getDb()
    .select({ id: providerServices.id })
    .from(providerServices)
    .where(and(eq(providerServices.providerProfileId, provider.id), eq(providerServices.serviceId, serviceId)));
  if (!offering) throw faqOwnershipForbiddenError('Only a provider offering this service may add a FAQ for it.');

  const [row] = await getDb()
    .insert(serviceFaqs)
    .values({ serviceId, providerProfileId: provider.id, question: body.question!, answer: body.answer!, source: 'provider', status: 'published' })
    .returning();

  return toAdminDto(row!);
}

/** §3 `POST /api/v1/admin/services/{id}/faqs/ai-suggestions/{suggestionId}/approve` —
 * `suggestionId` addresses the `ServiceFAQ` row itself (the one already-defined entity spec 011
 * §4 gives this state machine; there is no separate suggestion-staging table). Publishes the
 * AI-drafted FAQ — the one path that moves an `ai_suggested` row out of `pending_review`; the AI
 * itself never calls this. */
export async function approveAiSuggestedFaq(actorUserId: string, suggestionId: string): Promise<ServiceFaqAdminDto> {
  const actorRoles = await requireCatalogPermission(actorUserId, 'catalog.service_faq', 'approve');

  const [row] = await getDb().select().from(serviceFaqs).where(eq(serviceFaqs.id, suggestionId));
  if (!row) throw servicePageNotFoundError('The requested FAQ suggestion does not exist.');
  if (row.source !== 'ai_suggested') {
    throw new ApiRouteError('DOMAIN_RULE_VIOLATION', 'Only an AI-suggested FAQ can be approved through this endpoint.');
  }
  if (row.status === 'published') {
    throw new ApiRouteError('CONFLICT', 'This suggestion has already been approved.');
  }

  const [updated] = await getDb().update(serviceFaqs).set({ status: 'published', updatedAt: new Date() }).where(eq(serviceFaqs.id, suggestionId)).returning();

  await recordAdminAuditEvent({
    actorUserId,
    actorRoles,
    eventType: 'service_page.faq_ai_suggestion_approved',
    resource: 'catalog.service_faq',
    action: 'approve',
    targetType: 'service_faq',
    targetId: suggestionId,
    approvalChain: { approvedBy: actorUserId },
  });

  return toAdminDto(updated!);
}
