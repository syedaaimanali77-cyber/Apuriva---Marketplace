import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { getExportDownload } from '@/lib/privacy/export';

/** Path is `.../data-export/{id}/download` — the id is the second-to-last segment. */
function exportIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 008 §3/§6 — the private, signed, time-limited download link `downloadUrl` points to.
 * Deliberately not session-gated: authorization is the signature + expiry alone (verified
 * against the export id in the path), matching real signed-URL semantics (spec 027 §3's
 * eventual `GET /api/v1/files/{id}` presigned equivalent) rather than requiring the browser
 * that requested the export to still be logged in when the link is used.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const exportRequestId = exportIdFromUrl(request);
  const url = new URL(request.url);
  const download = await getExportDownload(exportRequestId, url.searchParams.get('exp'), url.searchParams.get('sig'));

  const res = new NextResponse(download.body, {
    status: 200,
    headers: {
      'content-type': download.contentType,
      'content-disposition': `attachment; filename="${download.filename}"`,
      'cache-control': 'private, no-store',
    },
  });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
