/** Spec 011 §3 Request and response types. */
import type { CategoryDto, PricingModel, ServiceDto, SubcategoryDto } from './catalog';

export type ServiceFieldType = 'text' | 'select' | 'number' | 'boolean' | 'media';

export interface ServiceFieldDto {
  id: string;
  serviceId: string;
  key: string;
  label: string;
  type: ServiceFieldType;
  required: boolean;
  options?: string[];
  validation?: { maxLength?: number; pattern?: string };
  sortOrder: number;
}

/** `POST /api/v1/admin/services/{id}/fields` body. */
export interface CreateServiceFieldRequest {
  key: string;
  label: string;
  type: ServiceFieldType;
  required?: boolean;
  options?: string[];
  validation?: { maxLength?: number; pattern?: string };
  sortOrder?: number;
}

export type ServiceRequirementKind = 'media' | 'duration' | 'buffer' | 'verification';

export interface ServiceRequirementDto {
  id: string;
  serviceId: string;
  kind: ServiceRequirementKind;
  /** Free-form per-kind detail — for `kind: 'media'`, `detail.helpText` is the "why this helps"
   * guidance AC-4 requires be shown without blocking submission. */
  detail: Record<string, unknown>;
}

export type PriceDisplayType = 'exact' | 'starting' | 'range' | 'quote' | 'hourly';

export interface PriceDisplay {
  type: PriceDisplayType;
  amountMinorUnits?: number;
  currencyCode?: string;
}

export interface ServicePackageDto {
  id: string;
  serviceId: string;
  providerId: string | null;
  name: string;
  description: string | null;
  amountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
}

/** `POST /api/v1/admin/services/{id}/faqs` and `POST /api/v1/providers/me/services/{id}/faqs`
 * body — `source` is implied by which endpoint is called, never client-supplied. */
export interface CreateServiceFaqRequest {
  question: string;
  answer: string;
}

export type ServiceFaqStatus = 'published' | 'pending_review';

/** The full admin-visible shape of a `ServiceFAQ` row, including `ai_suggested`/`pending_review`
 * rows an admin must review — distinct from `ServicePageDto.faqs[]`, which is customer-facing and
 * never exposes an unpublished or raw `ai_suggested` source (§3: once published, an approved
 * AI-suggested FAQ displays as `official`, per AC-5). */
export interface ServiceFaqAdminDto {
  id: string;
  serviceId: string;
  providerId: string | null;
  question: string;
  answer: string;
  source: 'official' | 'provider' | 'ai_suggested';
  status: ServiceFaqStatus;
}

export interface ServicePageDto {
  id: string;
  name: string;
  pricingModel: PricingModel;
  priceDisplay: PriceDisplay;
  packages: ServicePackageDto[];
  fields: ServiceFieldDto[];
  requirements: ServiceRequirementDto[];
  faqs: Array<{ id: string; question: string; answer: string; source: 'official' | 'provider'; providerId?: string }>;
}

/** AC-1's category page — `header`/`filters`/`popularServices` are real (from spec 010's
 * `Category`/`Service`); the AI-assist entry point, provider-recommendation ranking (spec 017),
 * and nearby-availability data (spec 016) are out of this spec's scope (§7) and render as
 * structural placeholders on the page rather than fabricated data here. */
export interface CategoryPageDto {
  id: string;
  name: string;
  slug: string;
  /** Relevant filters — this category's published subcategories. Real search/filter logic
   * remains spec 013's job (§7 Out of scope). */
  filters: SubcategoryDto[];
  /** A simple, unranked listing of this category's published services — real
   * popularity/ranking logic remains spec 017's job (§7 Out of scope). */
  popularServices: ServiceDto[];
}
