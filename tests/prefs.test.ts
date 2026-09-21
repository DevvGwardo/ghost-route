// Browser-side persistence (spec P1-3). Uses an injected fake store so the
// suite is DOM-free and deterministic — and so the failure modes (corrupt
// JSON, throwing setItem) can be exercised without a real browser.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PREFS,
  MAX_RECENTS,
  MAX_SAVED,
  PREFS_KEY,
  RECENT_KEY,
  SAVED_KEY,
  addRecent,
  createMemoryStore,
  isSaved,
  loadPrefs,
  loadRecents,
  loadSaved,
  savePrefs,
  toggleSaved,
  type Place,
  type PrefsStore,
} from '../client/src/lib/prefs';

const place = (label: string, lat = 30.2672, lon = -97.7431): Place => ({ label, lat, lon });

describe('preferences', () => {
  it('falls back to the defaults on an empty store', () => {
    expect(loadPrefs(createMemoryStore())).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('round-trips every preference', () => {
    const store = createMemoryStore();
    const prefs = {
      avoidFlock: false,
      bufferMeters: 320,
      profile: 'walking' as const,
      respectDirection: false,
      verifiedOnly: true,
      brands: ['Flock Safety'],
      voice: true,
    };
    expect(savePrefs(prefs, store)).toBe(true);
    expect(loadPrefs(store)).toEqual(prefs);
  });

  it('clamps a stored buffer into the servable range', () => {
    const store = createMemoryStore({ [PREFS_KEY]: JSON.stringify({ bufferMeters: 999_999 }) });
    expect(loadPrefs(store).bufferMeters).toBe(5000);
    const tiny = createMemoryStore({ [PREFS_KEY]: JSON.stringify({ bufferMeters: 1 }) });
    expect(loadPrefs(tiny).bufferMeters).toBe(50);
  });

  it('drops unknown profiles, wrong types and junk brands', () => {
    const store = createMemoryStore({
      [PREFS_KEY]: JSON.stringify({
        profile: 'hovercraft',
        avoidFlock: 'yes',
        respectDirection: 1,
        brands: ['ok', '', 42, 'x'.repeat(200)],
      }),
    });
    const prefs = loadPrefs(store);
    expect(prefs.profile).toBe(DEFAULT_PREFS.profile);
    expect(prefs.avoidFlock).toBe(DEFAULT_PREFS.avoidFlock);
    expect(prefs.respectDirection).toBe(DEFAULT_PREFS.respectDirection);
    expect(prefs.brands).toEqual(['ok']);
  });

  it('survives corrupt JSON instead of throwing', () => {
    const store = createMemoryStore({ [PREFS_KEY]: '{not json' });
    expect(loadPrefs(store)).toEqual(DEFAULT_PREFS);
  });

  it('never throws when storage rejects writes (private mode)', () => {
    const hostile: PrefsStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };
    expect(() => savePrefs(DEFAULT_PREFS, hostile)).not.toThrow();
    expect(savePrefs(DEFAULT_PREFS, hostile)).toBe(false);
    expect(loadPrefs(hostile)).toEqual(DEFAULT_PREFS);
  });
});

describe('recent trips', () => {
  it('stores newest first and remembers the timestamp', () => {
    const store = createMemoryStore();
    addRecent({ origin: place('A'), destination: place('B') }, store);
    addRecent({ origin: place('C'), destination: place('D') }, store);
    const recents = loadRecents(store);
    expect(recents.map((r) => r.origin.label)).toEqual(['C', 'A']);
    expect(recents[0].at).toBeGreaterThan(0);
  });

  it('de-duplicates by origin+destination and moves the repeat to the front', () => {
    const store = createMemoryStore();
    addRecent({ origin: place('A'), destination: place('B') }, store);
    addRecent({ origin: place('C'), destination: place('D') }, store);
    addRecent({ origin: place('A'), destination: place('B') }, store);
    const recents = loadRecents(store);
    expect(recents).toHaveLength(2);
    expect(recents[0].origin.label).toBe('A');
  });

  it('caps the list', () => {
    const store = createMemoryStore();
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      addRecent({ origin: place(`A${i}`), destination: place(`B${i}`) }, store);
    }
    expect(loadRecents(store)).toHaveLength(MAX_RECENTS);
  });

  it('drops malformed entries rather than failing the whole list', () => {
    const store = createMemoryStore({
      [RECENT_KEY]: JSON.stringify([
        { origin: place('good'), destination: place('also good'), at: 5 },
        { origin: { label: '', lat: 0, lon: 0 }, destination: place('bad origin') },
        { origin: place('no destination') },
        'nonsense',
      ]),
    });
    const recents = loadRecents(store);
    expect(recents).toHaveLength(1);
    expect(recents[0].origin.label).toBe('good');
  });

  it('an empty or corrupt store yields an empty list', () => {
    expect(loadRecents(createMemoryStore())).toEqual([]);
    expect(loadRecents(createMemoryStore({ [RECENT_KEY]: 'oops' }))).toEqual([]);
  });
});

describe('saved places', () => {
  it('stars and unstars without duplicating', () => {
    const store = createMemoryStore();
    expect(isSaved(place('Home'), store)).toBe(false);
    expect(toggleSaved(place('Home'), store).map((p) => p.label)).toEqual(['Home']);
    expect(isSaved(place('Home'), store)).toBe(true);
    // Same place again (id label + coords) removes it.
    expect(toggleSaved(place('Home'), store)).toEqual([]);
    expect(isSaved(place('Home'), store)).toBe(false);
  });

  it('keeps distinct places and caps the list', () => {
    const store = createMemoryStore();
    for (let i = 0; i < MAX_SAVED + 10; i++) {
      toggleSaved(place(`P${i}`, 30 + i * 0.001, -97), store);
    }
    expect(loadSaved(store)).toHaveLength(MAX_SAVED);
    expect(loadSaved(store).some((p) => p.label === `P${MAX_SAVED + 9}`)).toBe(true);
  });

  it('ignores junk rows', () => {
    const store = createMemoryStore({
      [SAVED_KEY]: JSON.stringify([place('ok'), { label: 'bad', lat: 'x', lon: null }, 7]),
    });
    expect(loadSaved(store).map((p) => p.label)).toEqual(['ok']);
  });
});
