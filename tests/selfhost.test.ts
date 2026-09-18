import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Offline + deterministic: file reads, JSON-shape pins, one local spawn of
// scripts/import-deflock.mjs --list-metros (no network). setup script is
// never executed (needs docker). Suites skip if their artifact hasn't
// landed yet from the parallel track (PENDING, not failure).
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS_DIR, '..');
const REGIONS = path.join(ROOT, 'scripts/regions.json');
const COMPOSE =
  [path.join(ROOT, 'docker-compose.osrm.yml'), path.join(ROOT, 'scripts/docker-compose.osrm.yml')].find(
    existsSync,
  ) ?? null;
const SETUP =
  [path.join(ROOT, 'setup-routing-selfhost.sh'), path.join(ROOT, 'scripts/setup-routing-selfhost.sh')].find(
    existsSync,
  ) ?? null;

const GEOFABRIK_RE = /^https:\/\/download\.geofabrik\.de\/.+\.osm\.pbf$/;

type RegionEntry = { metro: string; state: string; geofabrikUrl: string; bbox: unknown };

function regionEntries(): RegionEntry[] {
  const raw = JSON.parse(readFileSync(REGIONS, 'utf8')) as
    | RegionEntry[]
    | Record<string, Omit<RegionEntry, 'metro'>>;
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([metro, v]) => ({ metro, ...(v as object) }) as RegionEntry);
}

function listMetros(): string[] {
  const out = execFileSync('node', [path.join(ROOT, 'scripts/import-deflock.mjs'), '--list-metros'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
}

describe.skipIf(!existsSync(REGIONS))('selfhost regions.json', () => {
  it('parses with ≥1 entry, each having metro/state/geofabrikUrl/bbox', () => {
    const entries = regionEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.metro).toBe('string');
      expect(e.metro.length).toBeGreaterThan(0);
      expect(typeof e.state).toBe('string');
      expect((e.state as string).length).toBeGreaterThan(0);
      expect(typeof e.geofabrikUrl).toBe('string');
      expect(Array.isArray(e.bbox)).toBe(true);
    }
  });

  it('geofabrikUrl matches geofabrik .osm.pbf pattern', () => {
    for (const e of regionEntries()) expect(e.geofabrikUrl).toMatch(GEOFABRIK_RE);
  });

  it('bbox is 4 sane numbers (minLon<maxLon, minLat<maxLat, lon/lat ranges)', () => {
    for (const e of regionEntries()) {
      const b = e.bbox as number[];
      expect(b).toHaveLength(4);
      expect(b.every(Number.isFinite)).toBe(true);
      const [minLon, minLat, maxLon, maxLat] = b;
      expect(minLon).toBeLessThan(maxLon);
      expect(minLat).toBeLessThan(maxLat);
      for (const lon of [minLon, maxLon]) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
      }
      for (const lat of [minLat, maxLat]) {
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
    }
  });

  it('metro keys ⊆ import-deflock --list-metros set', () => {
    const allowed = new Set(listMetros());
    expect(allowed.size).toBeGreaterThan(0);
    for (const e of regionEntries()) expect(allowed.has(e.metro)).toBe(true);
  });
});

describe.skipIf(!COMPOSE)('selfhost docker-compose.osrm.yml', () => {
  it('binds 127.0.0.1:5000 and publishes NO 0.0.0.0', () => {
    const text = readFileSync(COMPOSE as string, 'utf8');
    expect(text).toContain('127.0.0.1:5000');
    expect(text).not.toContain('0.0.0.0');
  });
});

describe.skipIf(!SETUP)('selfhost setup-routing-selfhost.sh', () => {
  it('exists and is non-empty (never executed here)', () => {
    expect(statSync(SETUP as string).size).toBeGreaterThan(0);
    expect(readFileSync(SETUP as string, 'utf8').length).toBeGreaterThan(0);
  });
});
