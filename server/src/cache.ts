// Tiny TTL LRU cache, zero deps. Owned by perf agent.
// Backend/api agents: import the singleton (default) or named fns.
//   import cache, { get, set, keyOf } from '../cache.js';

const MAX_ENTRIES = 500;

type Entry = { val: unknown; exp: number };

const store = new Map<string, Entry>();

function isExpired(e: Entry): boolean {
  return Date.now() > e.exp;
}

function evictIfNeeded(): void {
  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

export function get<T>(key: string): T | undefined {
  const e = store.get(key);
  if (!e) return undefined;
  if (isExpired(e)) {
    store.delete(key);
    return undefined;
  }
  // LRU refresh: re-insert to mark most-recently-used.
  store.delete(key);
  store.set(key, e);
  return e.val as T;
}

export function set(key: string, val: unknown, ttlMs: number): void {
  if (store.has(key)) store.delete(key);
  else evictIfNeeded();
  store.set(key, { val, exp: Date.now() + ttlMs });
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function keyOf(obj: unknown): string {
  return stableStringify(obj);
}

const cache = { get, set, keyOf, max: MAX_ENTRIES };
export default cache;
