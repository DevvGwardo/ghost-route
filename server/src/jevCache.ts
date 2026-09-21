// JEV orchestration: result cache + a single shared time budget (spec P2-1).
//
// Before this, every /api/route call made TWO uncached network round-trips to
// TypeSafe (ranking + exposure), each with its own 10s timeout — so a slow
// upstream could block a route for 20s. Now:
//   - identical candidate sets within TTL are served from cache (zero calls),
//   - ranking and exposure share ONE deadline,
//   - when the budget is gone we answer deterministically instead of waiting.
import { get as cacheGet, keyOf, set as cacheSet } from "./cache.js";
import {
  estimateExposure,
  fallbackResult,
  geometricFallback,
  rankRoutes,
  resolveKey,
  type EstimateExposureResult,
  type ExposureInput,
  type RankInput,
  type RankResult,
} from "./jev.js";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_BUDGET_MS = 10_000;

export function jevCacheTtlMs(): number {
  const v = Number(process.env.JEV_CACHE_TTL_MS);
  if (!Number.isFinite(v)) return DEFAULT_TTL_MS;
  return Math.min(600_000, Math.max(0, Math.floor(v)));
}

export function jevBudgetMs(): number {
  const v = Number(process.env.JEV_BUDGET_MS);
  if (!Number.isFinite(v)) return DEFAULT_BUDGET_MS;
  return Math.min(30_000, Math.max(0, Math.floor(v)));
}

export interface JevInput {
  rank: RankInput[];
  exposure: ExposureInput[];
}

export interface JevBundle {
  rank: RankResult;
  exposure: EstimateExposureResult;
  /** True when both parts came from cache (no upstream call this request). */
  cacheHit: boolean;
}

/**
 * Cache identity. Deliberately hashes only NON-SECRET routing facts plus the
 * mode: the key itself is never stored, and a request without a key can never
 * reuse an authenticated result (different `mode`, different fingerprint).
 */
export function jevFingerprint(input: JevInput, mode: string, threshold: number): string {
  return `jev|${mode}|${threshold}|${keyOf({
    rank: input.rank.map((r) => [
      r.id,
      r.score,
      Math.round(r.distanceM),
      Math.round(r.durationS),
      r.exposureCount,
      typeof r.exposurePGeo === "number" ? Math.round(r.exposurePGeo * 1000) : -1,
      r.highRiskSteps ?? -1,
      r.cameraIds ?? [],
    ]),
    exposure: input.exposure.map((e) => [
      e.id,
      Math.round(e.exposurePGeo * 1000),
      e.exposureCount,
      Math.round(e.distanceM),
    ]),
  })}`;
}

/**
 * Rank + estimate under ONE deadline, serving both from cache when the
 * candidate set repeats. Never throws: any failure degrades to the
 * deterministic path so a route request can't 500 on JEV trouble.
 */
export async function rankAndEstimate(
  input: JevInput,
  opts?: { apiKey?: string; threshold?: number; budgetMs?: number; now?: () => number },
): Promise<JevBundle> {
  const mode = resolveKey(opts?.apiKey) ? "jev" : "fake";
  const threshold = opts?.threshold ?? 0.4;
  const fingerprint = jevFingerprint(input, mode, threshold);

  if (jevCacheTtlMs() > 0) {
    const hit = cacheGet<{ rank: RankResult; exposure: EstimateExposureResult }>(fingerprint);
    if (hit) return { ...hit, cacheHit: true };
  }

  const budget = opts?.budgetMs ?? jevBudgetMs();
  const now = opts?.now ?? Date.now;
  const deadline = now() + budget;
  const remaining = (): number => Math.max(0, deadline - now());

  const rank = await rankRoutes(input.rank, {
    ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}),
    threshold,
    timeoutMs: remaining(),
  });
  const exposure = await estimateExposure(input.exposure, {
    ...(opts?.apiKey ? { apiKey: opts.apiKey } : {}),
    threshold,
    timeoutMs: remaining(),
  });

  // Cache only real answers: a deterministic (keyless) result is free to
  // recompute, and a DEGRADED one is a transport failure — caching it would
  // make a momentary blip stick for the whole TTL.
  if (jevCacheTtlMs() > 0 && mode === 'jev' && !rank.degraded) {
    cacheSet(fingerprint, { rank, exposure }, jevCacheTtlMs());
  }
  return { rank, exposure, cacheHit: false };
}

/** Deterministic answers, for when there is no budget left at all. */
export function deterministicBundle(input: JevInput, apiKey?: string): JevBundle {
  return {
    rank: fallbackResult(input.rank, 0.9, apiKey, true),
    exposure: geometricFallback(input.exposure),
    cacheHit: false,
  };
}
