import packageJson from '@/package.json';
import { OPENAPI_ROUTES } from './openapi-registry';

/**
 * Builds the OpenAPI 3.1 document served at `GET /api/v1/openapi.json` (spec 004 §3, AC-7).
 * Paths are generated from `OPENAPI_ROUTES` so the document can't drift from the registry that
 * `scripts/check-openapi-drift.ts` also checks against the actual route files. The envelope
 * schemas mirror `lib/types/api.ts` by hand — kept in sync manually, the same tradeoff spec 003
 * makes for its generated-SQL-vs-schema.ts pairing, since this repo has no TS-to-JSON-Schema
 * generator wired in yet.
 */
const ENVELOPE_SCHEMAS = {
  ApiError: {
    type: 'object',
    properties: {
      status: { type: 'integer' },
      code: { type: 'string' },
      message: { type: 'string' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: { field: { type: 'string' }, message: { type: 'string' } },
          required: ['field', 'message'],
        },
      },
      correlationId: { type: 'string' },
    },
    required: ['status', 'code', 'message', 'correlationId'],
  },
} as const;

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const route of OPENAPI_ROUTES) {
    const pathKey = route.path;
    const pathItem = (paths[pathKey] ??= {}) as Record<string, unknown>;
    pathItem[route.method.toLowerCase()] = {
      summary: route.summary,
      tags: route.tags,
      responses: {
        '200': { description: 'Success' },
        default: {
          description: 'Error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Apuriva API',
      version: packageJson.version,
      description: 'Generated from lib/api/openapi-registry.ts — see spec 004 AC-7.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: { schemas: ENVELOPE_SCHEMAS },
  };
}
