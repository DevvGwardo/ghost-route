// Camera write hardening + moderation (spec P1-5).
//
// Runs against a tiny fixture seed in a temp dir (CAMERA_DATA_FILE) with the
// append-only journal redirected to the same temp dir, so the suite is fast
// and never touches the shipped 18MB dataset or the repo working tree.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'gr-mod-'));
const dataFile = join(dir, 'seed.json');
const userFile = join(dir, 'user.ndjson');

writeFileSync(
  dataFile,
  JSON.stringify([
    { id: 'cam-001', lat: 30.3, lon: -97.7, source: 'deflock', verified: true, brand: 'Flock Safety' },
    { id: 'cam-002', lat: 30.4, lon: -97.8, source: 'deflock', verified: false },
  ]),
);
process.env.CAMERA_DATA_FILE = dataFile;
process.env.CAMERA_USER_FILE = userFile;
delete process.env.CAMERA_WRITE_TOKEN;

import { startServer, fetchJson } from './helpers';

let base = '';
let close: (() => Promise<void>) | null = null;

const BBOX = '-98,29,-96,31';
const json = { 'content-type': 'application/json' };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetchJson(base, path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  });
}

async function listedIds(): Promise<string[]> {
  const { body } = await fetchJson(base, `/api/cameras?bbox=${BBOX}&limit=500`);
  return (body as { cameras: Array<{ id: string }> }).cameras.map((c) => c.id).sort();
}

beforeAll(async () => {
  const { app } = await import('../server/src/index');
  ({ base, close } = await startServer(app));
});

afterAll(async () => {
  delete process.env.CAMERA_DATA_FILE;
  delete process.env.CAMERA_USER_FILE;
  delete process.env.CAMERA_WRITE_TOKEN;
  await close?.();
});

beforeEach(() => {
  delete process.env.CAMERA_WRITE_TOKEN;
});

describe('camera writes without a configured token (documented dev default)', () => {
  it('POST /api/cameras accepts an anonymous node and marks it unverified', async () => {
    const { res, body } = await post('/api/cameras', { lat: 30.6, lon: -97.9 });
    expect(res.status).toBe(200);
    const camera = (body as { camera: { id: string; verified: boolean; source: string } }).camera;
    expect(camera.verified).toBe(false);
    expect(camera.source).toBe('user');
    expect(await listedIds()).toContain(camera.id);
  });

  it('still validates coordinates', async () => {
    const { res } = await post('/api/cameras', { lat: 999, lon: -97.7 });
    expect(res.status).toBe(400);
  });
});

describe('camera writes with CAMERA_WRITE_TOKEN configured', () => {
  it('rejects a missing token with 401', async () => {
    process.env.CAMERA_WRITE_TOKEN = 'secret-token';
    const { res, body } = await post('/api/cameras', { lat: 30.7, lon: -97.95 });
    expect(res.status).toBe(401);
    expect((body as { error: string }).error).toBe('camera-token-required');
  });

  it('rejects a wrong token with 401 and accepts the right one', async () => {
    process.env.CAMERA_WRITE_TOKEN = 'secret-token';
    const bad = await post('/api/cameras', { lat: 30.71, lon: -97.96 }, { 'x-camera-token': 'nope' });
    expect(bad.res.status).toBe(401);
    const good = await post(
      '/api/cameras',
      { lat: 30.71, lon: -97.96 },
      { 'x-camera-token': 'secret-token' },
    );
    expect(good.res.status).toBe(200);
  });

  it('guards report and delete the same way', async () => {
    process.env.CAMERA_WRITE_TOKEN = 'secret-token';
    expect((await post('/api/cameras/cam-001/report', { reason: 'gone' })).res.status).toBe(401);
    const del = await fetchJson(base, '/api/cameras/cam-001', { method: 'DELETE' });
    expect(del.res.status).toBe(401);
  });
});

describe('POST /api/cameras/:id/report', () => {
  it('records a reason and accumulates on repeat', async () => {
    const first = await post('/api/cameras/cam-001/report', { reason: 'gone' });
    expect(first.res.status).toBe(200);
    expect((first.body as { reports: number }).reports).toBe(1);
    expect((first.body as { reasons: Record<string, number> }).reasons.gone).toBe(1);
    expect((first.body as { camera: { id: string } }).camera.id).toBe('cam-001');

    const second = await post('/api/cameras/cam-001/report', { reason: 'wrong-location' });
    expect((second.body as { reports: number }).reports).toBe(2);
  });

  it('rejects an unknown reason with 400 and lists the allowed ones', async () => {
    const { res, body } = await post('/api/cameras/cam-001/report', { reason: 'i-dislike-it' });
    expect(res.status).toBe(400);
    expect((body as { allowed: string[] }).allowed).toContain('gone');
  });

  it('404s for an unknown camera', async () => {
    const { res } = await post('/api/cameras/nope/report', { reason: 'gone' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/cameras/:id', () => {
  it('removes the node from the store and from bbox queries', async () => {
    expect(await listedIds()).toContain('cam-002');
    const { res, body } = await fetchJson(base, '/api/cameras/cam-002', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((body as { deleted: { id: string } }).deleted.id).toBe('cam-002');
    expect(await listedIds()).not.toContain('cam-002');
    expect((await fetchJson(base, '/api/cameras/cam-002', { method: 'DELETE' })).res.status).toBe(404);
  });

  it('records the deletion in the append-only journal (survives restart)', () => {
    expect(existsSync(userFile)).toBe(true);
    const journal = readFileSync(userFile, 'utf8');
    expect(journal).toContain('"op":"delete"');
    expect(journal).toContain('cam-002');
    // The fixture seed itself is never rewritten.
    expect(JSON.parse(readFileSync(dataFile, 'utf8'))).toHaveLength(2);
  });
});
