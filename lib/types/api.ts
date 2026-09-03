/**
 * Shared `/api/v1/*` response envelope — docs/specs/2026-08-28-004-api-foundation-response-standards.md §3.
 * Every domain endpoint (spec 005 onward) responds with one of these three shapes; `lib/api/*`
 * builds them so individual routes never hand-assemble the envelope themselves.
 */
export interface ApiResponse<T> {
  data: T;
  correlationId: string;
}

export interface PagedResponse<T> {
  data: T[];
  page: { limit: number; offset: number; total: number; nextOffset: number | null };
  correlationId: string;
}

export interface ApiError {
  status: number;
  code: string; // SCREAMING_SNAKE_CASE, stable
  message: string;
  errors?: { field: string; message: string }[];
  correlationId: string;
}
