// Store interface conformance + append-only durability (spec P2-2).
//
// The same behavior suite runs against the in-memory and JSON-backed stores,
// so a future SQLite implementation can be dropped in behind the same tests.
// The JSON store must also never rewrite the shipped seed file.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore, createMemoryStore, type Camera, type Store } from '../server/src/store';

const SEED: Camera[] = [
  { id: 'cam-001', lat: 30.3, lon: -97.7, source: 'deflock', verified: true, brand: 'Flock Safety' },
  { id: 'cam-002', lat: 30.4, lon: -97.8, source: 'deflock', verified: false },
];

const BBOX: [number, number, number, number] = [-98, 29, -96, 31];

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gr-store-'));
}

function jsonStoreIn(dir: string): { store: Store; dataFile: string; userFile: string } {
  const dataFile = join(dir, 'seed.json');
  const userFile = join(dir, 'user.ndjson');
  writeFileSync(dataFile, JSON.stringify(SEED));
  return { store: createJsonStore({ dataFile, userFile }), dataFile, userFile };
}

function conformance(name: string, make: () => Store): void {
  describe(`Store conformance: ${name}`, () => {
    let store: Store;
    beforeEach(() => {
      store = make();
    });

    it('starts from the seed', () => {
      expect(store.allCameras().map((c) => c.id).sort()).toEqual(['cam-001', 'cam-002']);
      expect(store.cameraById('cam-001')?.lat).toBeCloseTo(30.3, 6);
    });

    it('addCamera assigns a new unverified id and is immediately queryable', () => {
      const created = store.addCamera(30.35, -97.75, 'Somewhere');
      expect(created.verified).toBe(false);
      expect(created.id).not.toBe('cam-001');
      expect(store.cameraById(created.id)?.address).toBe('Somewhere');
      expect(store.camerasInBbox(...BBOX, 500).map((c) => c.id)).toContain(created.id);
      expect(store.cameraCounts().verified).toBe(1);
    });

    it('rejects a second node within ~10m of an existing one', () => {
      const first = store.addCamera(30.5, -97.6);
      const again = store.addCamera(30.5, -97.6);
      expect(again.id).toBe(first.id);
      expect(store.allCameras().filter((c) => c.id === first.id)).toHaveLength(1);
    });

    it('rejects invalid coordinates and blank addresses', () => {
      expect(() => store.addCamera(999, -97.7)).toThrow(RangeError);
      expect(() => store.addCamera(30.5, -197.7)).toThrow(RangeError);
      expect(() => store.addCamera(30.5, -97.7, '')).toThrow(RangeError);
    });

    it('deleteCamera removes the node and is not idempotent-successful twice', () => {
      expect(store.deleteCamera('cam-002')?.id).toBe('cam-002');
      expect(store.cameraById('cam-002')).toBeUndefined();
      expect(store.deleteCamera('cam-002')).toBeUndefined();
    });

    it('reportCamera requires a known id and returns cumulative counts', () => {
      expect(store.reportCamera('ghost', 'gone')).toBeUndefined();
      expect(store.reportCamera('cam-001', 'gone')?.reports).toBe(1);
      expect(store.reportCamera('cam-001', 'wrong-location')?.reasons).toEqual({
        gone: 1,
        'wrong-location': 1,
      });
    });

    it('never reuses an id it already handed out', () => {
      const a = store.addCamera(31, -98);
      const b = store.addCamera(31.1, -98.1);
      expect(a.id).not.toBe(b.id);
    });
  });
}

conformance('memory', () => createMemoryStore(SEED));

conformance('json', () => jsonStoreIn(tmpDir()).store);

describe('JSON store durability', () => {
  it('appends one journal line per mutation and never rewrites the seed', () => {
    const dir = tmpDir();
    const { store, dataFile, userFile } = jsonStoreIn(dir);
    const before = statSync(dataFile).size;

    const ids = Array.from({ length: 25 }, (_, i) => store.addCamera(30 + i * 0.01, -97).id);
    store.deleteCamera(ids[0]);
    store.reportCamera(ids[1], 'gone');

    // The shipped seed is input-only: it must not grow or be rewritten.
    expect(statSync(dataFile).size).toBe(before);
    expect(JSON.parse(readFileSync(dataFile, 'utf8'))).toHaveLength(SEED.length);

    const lines = readFileSync(userFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(27); // 25 adds + 1 delete + 1 report
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('a fresh store replays the journal into the same state (no lost writes)', () => {
    const dir = tmpDir();
    const { store, dataFile, userFile } = jsonStoreIn(dir);
    const added = Array.from({ length: 30 }, (_, i) => store.addCamera(31 + i * 0.01, -97).id);
    store.deleteCamera(added[0]);

    const reloaded = createJsonStore({ dataFile, userFile });
    expect(reloaded.allCameras()).toHaveLength(SEED.length + added.length - 1);
    for (const id of added.slice(1)) expect(reloaded.cameraById(id)).toBeDefined();
    expect(reloaded.cameraById(added[0])).toBeUndefined();
  });

  it('a torn final journal line (crash mid-append) does not discard earlier records', () => {
    const dir = tmpDir();
    const { store, dataFile, userFile } = jsonStoreIn(dir);
    const a = store.addCamera(31.5, -98.5);
    const b = store.addCamera(31.6, -98.6);
    appendFileSync(userFile, '{"op":"add","camera":{"id":"cam-');

    const reloaded = createJsonStore({ dataFile, userFile });
    expect(reloaded.cameraById(a.id)).toBeDefined();
    expect(reloaded.cameraById(b.id)).toBeDefined();
  });

  it('an unreadable seed degrades to an empty store instead of throwing', () => {
    const dir = tmpDir();
    const store = createJsonStore({
      dataFile: join(dir, 'does-not-exist.json'),
      userFile: join(dir, 'user.ndjson'),
    });
    expect(store.allCameras()).toEqual([]);
  });
});
