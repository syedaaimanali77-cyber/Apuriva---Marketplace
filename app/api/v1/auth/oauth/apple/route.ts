import { withApiRoute } from '@/lib/api/handler';
import { handleOAuthCallback } from '@/lib/auth/oauth-route-handler';

/** Spec 005 AC-4, `POST /api/v1/auth/oauth/apple` — exchanges the provider auth code server-side. */
export const POST = withApiRoute((request, correlationId) => handleOAuthCallback(request, correlationId, 'apple'));
