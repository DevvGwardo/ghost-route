import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startServer, fetchJson } from './helpers';

let base = '';
let close: (() => Promise<void>) | null = null;
const REAL_FETCH = globalThis.fetch;

beforeAll(async () => {
  const { app } = await import('../server/src/index');
  ({ base, close } = await startServer(app));
});

afterAll(async () => {
  await close?.();
  globalThis.fetch = REAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.TYPESAFE_API_KEY;
});

function stubTypesafe(status: number, body: unknown) {
  const real = REAL_FETCH;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    if (String(url).includes('api.typesafe.ai'))
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    return real(url as string, init as RequestInit);
  }) as typeof fetch;
}

describe('oss byok verify + hardening', () => {
  it('GET /api/system/status cameraCount matches store total', async () => {
    const { res, body } = await fetchJson(base, '/api/system/status');
    expect(res.status).toBe(200);
    const { allCameras } = await import('../server/src/store');
    expect((body as { cameraCount: number }).cameraCount).toBe(allCameras().length);
  });

  it('GET /api/system/verify without key → 400 valid:false, no leak', async () => {
    const { res, body } = await fetchJson(base, '/api/system/verify');
    expect(res.status).toBe(400);
    expect((body as { valid: boolean }).valid).toBe(false);
  });

  it('GET /api/system/verify with 401 upstream → valid:false unauthorized', async () => {
    stubTypesafe(401, { error: 'bad key' });
    const { res, body } = await fetchJson(base, '/api/system/verify', {
      headers: { 'x-typesafe-key': 'bad-key' },
    });
    expect(res.status).toBe(200);
    const b = body as { valid: boolean; error: string; mode: string };
    expect(b.valid).toBe(false);
    expect(b.error).toBe('unauthorized');
    expect(JSON.stringify(body)).not.toContain('bad-key');
  });

  it('GET /api/system/verify with 200 choice → valid:true', async () => {
    stubTypesafe(200, { choice: 'r1', confidence: 0.9 });
    const { res, body } = await fetchJson(base, '/api/system/verify', {
      headers: { 'x-typesafe-key': 'good-key' },
    });
    expect(res.status).toBe(200);
    expect((body as { valid: boolean }).valid).toBe(true);
  });

  it('POST /api/cameras rejects 501-char address with 400', async () => {
    const { res } = await fetchJson(base, '/api/cameras', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 30.27, lon: -97.74, address: 'x'.repeat(501) }),
    });
    expect(res.status).toBe(400);
  });
});
