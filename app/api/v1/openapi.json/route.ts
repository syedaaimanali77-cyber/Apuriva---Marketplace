import { NextResponse } from 'next/server';
import { buildOpenApiDocument } from '@/lib/api/openapi';

export const dynamic = 'force-dynamic';

/**
 * Spec 004 §3, AC-7: generated OpenAPI 3.x document, not hand-written. See
 * lib/api/openapi.ts / lib/api/openapi-registry.ts for the source of truth this is built from.
 */
export async function GET() {
  return NextResponse.json(buildOpenApiDocument());
}
