/** Spec 010 §3 Request and response types. */

/** Catalog entity lifecycle (Category, Subcategory, Service) — see Lifecycle, §4. */
export type CatalogEntityStatus = 'draft' | 'published' | 'pending_review' | 'retired';

/** AI `CatalogSuggestion` lifecycle — deliberately separate from `CatalogEntityStatus` even
 * though both use the term `pending_review`: a suggestion is a proposal that may or may not
 * ever become a catalog entity, never a catalog entity itself (see Lifecycle, §4). */
export type CatalogSuggestionStatus = 'pending_review' | 'approved' | 'rejected';

export type PricingModel = 'fixed' | 'package' | 'hourly' | 'quote' | 'custom';

export type CatalogSuggestionEntityType = 'category' | 'subcategory' | 'service';

export interface CategoryDto {
  id: string;
  name: string;
  slug: string;
  status: CatalogEntityStatus;
  sortOrder: number;
  subcategories: SubcategoryDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SubcategoryDto {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  status: CatalogEntityStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDto {
  id: string;
  categoryId: string;
  subcategoryId: string | null;
  name: string;
  slug: string;
  pricingModel: PricingModel;
  status: CatalogEntityStatus;
  metadata: Record<string, unknown>;
  /**
   * Spec 028 §4 — whether a booking for this service may be completed only once completion
   * evidence exists. The catalog is the SOLE source of this requirement; spec 028's gate reads it
   * through `bookings.service_id` and no booking-side input can override it.
   */
  completionEvidenceRequired: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogSuggestionDto {
  id: string;
  entityType: CatalogSuggestionEntityType;
  proposedName: string;
  proposedSlug: string;
  categoryId: string | null;
  subcategoryId: string | null;
  pricingModel: PricingModel | null;
  metadata: Record<string, unknown>;
  rationale: string | null;
  source: string;
  status: CatalogSuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  resultingEntityId: string | null;
}

/** `POST /api/v1/admin/categories` body. */
export interface CreateCategoryRequest {
  name: string;
  slug: string;
  status?: CatalogEntityStatus;
  sortOrder?: number;
}

/** `PATCH /api/v1/admin/categories/{id}` body — every field optional (partial update);
 * `expectedVersion` triggers the optimistic-concurrency check (§3 Versioning) when supplied. */
export interface EditCategoryRequest {
  name?: string;
  slug?: string;
  status?: CatalogEntityStatus;
  sortOrder?: number;
  expectedVersion?: number;
}

/** `POST /api/v1/admin/categories/{categoryId}/subcategories` body. */
export interface CreateSubcategoryRequest {
  name: string;
  slug: string;
  status?: CatalogEntityStatus;
}

/** `PATCH /api/v1/admin/subcategories/{id}` body. */
export interface EditSubcategoryRequest {
  categoryId?: string;
  name?: string;
  slug?: string;
  status?: CatalogEntityStatus;
  expectedVersion?: number;
}

/** `POST /api/v1/admin/services` body. */
export interface CreateServiceRequest {
  categoryId: string;
  subcategoryId?: string | null;
  name: string;
  slug: string;
  pricingModel: PricingModel;
  status?: CatalogEntityStatus;
  metadata?: Record<string, unknown>;
}

/** `PATCH /api/v1/admin/services/{id}` body. */
export interface EditServiceRequest {
  categoryId?: string;
  subcategoryId?: string | null;
  name?: string;
  slug?: string;
  pricingModel?: PricingModel;
  status?: CatalogEntityStatus;
  metadata?: Record<string, unknown>;
  /** Spec 028 §4 "Admin surface" — the one place the completion-evidence requirement is set. */
  completionEvidenceRequired?: boolean;
  expectedVersion?: number;
}

/** `POST /api/v1/admin/catalog/suggestions` body — spec 034's AI assistant, via spec 035's MCP
 * tool pipeline. */
export interface CreateCatalogSuggestionRequest {
  entityType: CatalogSuggestionEntityType;
  proposedName: string;
  proposedSlug: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
  pricingModel?: PricingModel | null;
  metadata?: Record<string, unknown>;
  rationale?: string | null;
  source: string;
}
