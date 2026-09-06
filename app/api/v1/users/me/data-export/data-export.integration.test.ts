import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { runExportSweep } from '@/lib/privacy/export';
import { registerTestFileAssetStorage } from '@/lib/privacy/test-support';
import { POST } from './route';
import { GET as GET_STATUS } from './[id]/route';
import { GET as GET_DOWNLOAD } from './[id]/download/route';
import { authenticatedRequest, authenticatedRequestWithStepUp, getStepUpToken, isDatabaseReachable, registerAndLogin } from '../privacy-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('data export (spec 008 AC-3, integration)', () => {
  // Test double standing in for spec 027's not-yet-implemented FileAsset storage capability
  // (lib/privacy/file-asset-storage.ts) — spec 008 depends on it rather than implementing one.
  beforeAll(() => {
    registerTestFileAssetStorage();
  });

  beforeEach(() => {
    resetRateLimitState();
  });

  it('POST requires fresh step-up', async () => {
    const session = await registerAndLogin();
    const res = await POST(authenticatedRequest('http://localhost/api/v1/users/me/data-export', session.sessionId, session.csrfToken));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });

  it('AC-3: POST starts an export and repeating it returns the same exportRequestId (idempotent while pending)', async () => {
    const session = await registerAndLogin();
    const token1 = await getStepUpToken(session, 'request_data_export');
    const first = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/data-export', session, token1));
    expect(first.status).toBe(202);
    const firstId = (await first.json()).data.exportRequestId;

    const token2 = await getStepUpToken(session, 'request_data_export');
    const second = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/data-export', session, token2));
    expect((await second.json()).data.exportRequestId).toBe(firstId);
  });

  it("GET status: another user's export id returns 404, not that user's status", async () => {
    const owner = await registerAndLogin();
    const token = await getStepUpToken(owner, 'request_data_export');
    const created = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/data-export', owner, token));
    const { exportRequestId } = (await created.json()).data;

    const stranger = await registerAndLogin();
    const res = await GET_STATUS(
      authenticatedRequest(`http://localhost/api/v1/users/me/data-export/${exportRequestId}`, stranger.sessionId, stranger.csrfToken, { method: 'GET' }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('a nonexistent export id returns the identical 404', async () => {
    const session = await registerAndLogin();
    const res = await GET_STATUS(
      authenticatedRequest('http://localhost/api/v1/users/me/data-export/00000000-0000-0000-0000-000000000000', session.sessionId, session.csrfToken, {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('downloadUrl appears only once ready, and the download route serves the JSON payload for its owner', async () => {
    const session = await registerAndLogin();
    const token = await getStepUpToken(session, 'request_data_export');
    const created = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/data-export', session, token));
    const { exportRequestId } = (await created.json()).data;

    const pendingStatus = await GET_STATUS(
      authenticatedRequest(`http://localhost/api/v1/users/me/data-export/${exportRequestId}`, session.sessionId, session.csrfToken, { method: 'GET' }),
    );
    expect((await pendingStatus.json()).data.downloadUrl).toBeUndefined();

    await runExportSweep();

    const readyStatus = await GET_STATUS(
      authenticatedRequest(`http://localhost/api/v1/users/me/data-export/${exportRequestId}`, session.sessionId, session.csrfToken, { method: 'GET' }),
    );
    const { data } = await readyStatus.json();
    expect(data.status).toBe('ready');
    expect(data.downloadUrl).toBeTruthy();

    const downloadRes = await GET_DOWNLOAD(new Request(`http://localhost${data.downloadUrl}`));
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(await downloadRes.text());
    expect(body.profile.id).toBe(session.userId);
  });

  it('the download route rejects a tampered signature even for a real, ready export id', async () => {
    const session = await registerAndLogin();
    const token = await getStepUpToken(session, 'request_data_export');
    const created = await POST(authenticatedRequestWithStepUp('http://localhost/api/v1/users/me/data-export', session, token));
    const { exportRequestId } = (await created.json()).data;
    await runExportSweep();

    const res = await GET_DOWNLOAD(
      new Request(`http://localhost/api/v1/users/me/data-export/${exportRequestId}/download?exp=${Date.now() + 60000}&sig=${'0'.repeat(64)}`),
    );
    expect(res.status).toBe(404);
  });
});
