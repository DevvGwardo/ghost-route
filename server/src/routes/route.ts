import { Router } from 'express';
import { fetchRoutes, fetchRoutesFor, type RoutingAttempt } from '../services/osrm.js';
import { rankByExposure } from '../avoid.js';
import { searchCleanRoute } from '../cleanroute.js';
import { confidenceThreshold } from '../jev.js';
import { deterministicBundle, rankAndEstimate, type JevBundle } from '../jevCache.js';
import { scoreRoute, exposurePForPoints, isPlausibleRoute } from '../services/scoring.js';
import { camerasInBbox, type CameraQueryFilter } from '../store.js';
import { logEvent } from '../logger.js';
import type { TravelProfile } from '../security.js';

const router = Router();

const MAX_COORDS = 4000;
const DEFAULT_ROUTE_BUDGET_MS = 12_000;

/**
 * Overall wall-clock ceiling for one route request's clean-route search
 * (additive v1.2, spec P2-1). A bounded partial answer beats an unbounded
 * wait; `cleanSearch.aborted` tells the client the search was cut short.
 */
function routeBudgetMs(): number {
  const v = Number(process.env.ROUTE_BUDGET_MS);
  if (!Number.isFinite(v)) return DEFAULT_ROUTE_BUDGET_MS;
  return Math.min(60_000, Math.max(500, Math.floor(v)));
}

/** Clean-route summary as returned in the response envelope. */
interface CleanSearch {
  cleanFound: boolean;
  rounds: number;
  osrmCalls: number;
  attempts?: number;
  detourRatio?: number;
  aborted?: boolean;
  skipped?: 'avoid-disabled';
}

// Lifetime observability for the plausibility guard (surfaced on
// GET /api/system/status). Plain counters — no PII, no per-request data.
let implausibleDropped = 0;
let implausibleExhausted = 0;

export function plausibilityStats(): {
  implausibleDropped: number;
  implausibleExhausted: number;
} {
  return { implausibleDropped, implausibleExhausted };
}

export interface PlausibleBase {
  routes: any[];
  /** True when routes existed but none survived the guard, even after retry. */
  exhausted: boolean;
}

// Fetch OSRM base routes with the plausibility guard applied. Transient
// backend garbage (all routes implausible) gets exactly one refetch before
// giving up — the same trip often returns sane routes seconds later.
// Throws when OSRM itself fails. fetchFn is injectable for tests.
export async function fetchPlausibleBase(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  fetchFn: (
    o: { lat: number; lon: number },
    d: { lat: number; lon: number },
  ) => Promise<any[]> = fetchRoutes,
): Promise<PlausibleBase> {
  const attempt = async (): Promise<any[]> => {
    const geoms = await fetchFn(origin, destination);
    if (!Array.isArray(geoms)) throw new Error("routing-unavailable");
    // OSRM geometries carry no ids — assign stable ones for ranking/response.
    return geoms.map((r: any, i: number) => ({ id: `route-${i}`, ...r }));
  };
  const gate = (routes: any[]): any[] => {
    const kept = routes.filter((r: any) =>
      isPlausibleRoute(Number(r?.distanceM), origin, destination),
    );
    implausibleDropped += routes.length - kept.length;
    return kept;
  };
  const firstRaw = await attempt();
  let routes = gate(firstRaw);
  if (routes.length === 0 && firstRaw.length > 0) {
    // Non-empty but all implausible → exactly one retry: transient OSRM
    // garbage often clears run to run. (Deliberately no delay.)
    // An empty OSRM response skips the retry (legacy 200-empty path).
    const retry = gate(await attempt());
    if (retry.length > 0) return { routes: retry, exhausted: false };
    implausibleExhausted += 1;
    return { routes: [], exhausted: true };
  }
  return { routes, exhausted: false };
}

function isLatLon(v: unknown): v is { lat: number; lon: number } {
  if (typeof v !== 'object' || v === null) return false;
  const { lat, lon } = v as { lat: unknown; lon: unknown };
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lon === 'number' && Number.isFinite(lon) && lon >= -180 && lon <= 180
  );
}

// POST / { origin, destination, avoidFlock=true, bufferMeters=150 }
// (mounted at /api/route by index.ts)
router.post('/', async (req, res) => {
  const startedAt = Date.now();
  const { origin, destination } = req.body ?? {};
  if (!isLatLon(origin) || !isLatLon(destination)) {
    res.status(400).json({ error: 'origin-destination-required' });
    return;
  }

  let avoidFlock = true;
  if (req.body.avoidFlock !== undefined) {
    if (typeof req.body.avoidFlock !== 'boolean') {
      res.status(400).json({ error: 'avoidFlock-invalid' });
      return;
    }
    avoidFlock = req.body.avoidFlock;
  }

  let bufferMeters = 150;
  if (req.body.bufferMeters !== undefined) {
    const b = req.body.bufferMeters;
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 5000) {
      res.status(400).json({ error: 'bufferMeters-invalid' });
      return;
    }
    bufferMeters = b;
  }

  // Direction-aware exposure (additive v1.2). When a camera carries a known
  // `direction`, it only counts if the route travels through that bearing.
  // Cameras without a direction are unaffected. Default on.
  let respectDirection = true;
  if (req.body.respectDirection !== undefined) {
    if (typeof req.body.respectDirection !== 'boolean') {
      res.status(400).json({ error: 'respectDirection-invalid' });
      return;
    }
    respectDirection = req.body.respectDirection;
  }

  // Travel profile (additive v1.2). Unknown values are rejected rather than
  // silently coerced — a typo'd profile should not quietly become "driving".
  let profile: TravelProfile = 'driving';
  if (req.body.profile !== undefined) {
    const p = req.body.profile;
    if (p !== 'driving' && p !== 'walking' && p !== 'cycling') {
      res.status(400).json({ error: 'profile-invalid' });
      return;
    }
    profile = p;
  }

  // Camera filter (additive v1.2). Split in two: `storeFilter` narrows the
  // candidate set before scoring; `maxDistM` is a hard distance ceiling the
  // scoring passes apply.
  const parsedFilter = parseCameraFilter(req.body.cameraFilter);
  if (!parsedFilter.ok) {
    res.status(400).json({ error: 'cameraFilter-invalid' });
    return;
  }
  const { storeFilter, maxDistM } = parsedFilter;

  const exposureOpts = {
    respectDirection,
    ...(maxDistM !== undefined ? { maxDistM } : {}),
  };

  const requestDeadline = Date.now() + routeBudgetMs();

  let baseRoutes: any[];
  // The profile that actually served the base route, and whether we fell back
  // to driving because this backend has no graph for the requested one.
  let usedProfile: TravelProfile = profile;
  let profileFallback = false;
  // BYOK: per-request user key (header > env > none); never log it.
  const headerVal = req.header('x-typesafe-key');
  const apiKey = (Array.isArray(headerVal) ? headerVal[0] : headerVal)?.trim() || undefined;
  try {
    const base = await fetchPlausibleBase(origin, destination, async (o, d) => {
      const attempt: RoutingAttempt = await fetchRoutesFor(o, d, undefined, profile);
      usedProfile = attempt.profile;
      profileFallback = attempt.degraded;
      return attempt.routes;
    });
    if (base.exhausted) {
      logEvent('route_error', { reason: 'implausible-routes', ms: Date.now() - startedAt });
      res.status(502).json({ error: 'routing-unavailable', reason: 'implausible-routes' });
      return;
    }
    baseRoutes = base.routes;
  } catch {
    logEvent('route_error', { reason: 'osrm-error', ms: Date.now() - startedAt });
    res.status(502).json({ error: 'routing-unavailable', reason: 'osrm-error' });
    return;
  }

  // Bbox enclosing every candidate route, used to fetch nearby cameras.
  let minLon = 180;
  let minLat = 90;
  let maxLon = -180;
  let maxLat = -90;
  for (const r of baseRoutes) {
    const coords = (r as any)?.coordinates;
    if (!Array.isArray(coords)) continue;
    for (const c of coords) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const lat = Number(c[0]);
      const lon = Number(c[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  // Pad the bbox by bufferMeters + 3000m so cameras also cover detour/clean
  // legs fetched later (old bug: detours were scored against base-only bbox).
  const midLat = minLon <= maxLon && minLat <= maxLat ? (minLat + maxLat) / 2 : 0;
  const padLat = (bufferMeters + 3000) / 111320;
  const padLon =
    (bufferMeters + 3000) /
    (111320 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const cameras =
    minLon <= maxLon && minLat <= maxLat
      ? camerasInBbox(
          Math.max(-180, minLon - padLon),
          Math.max(-90, minLat - padLat),
          Math.min(180, maxLon + padLon),
          Math.min(90, maxLat + padLat),
          2000,
          storeFilter,
        ).filter((c) => isLatLon(c))
      : [];

  // Score by camera exposure (guarded: one corrupt row must not 500 the route).
  let scored: any[];
  let cleanSearch: CleanSearch | undefined;
  try {
    if (avoidFlock) {
      scored = rankByExposure(baseRoutes, cameras, bufferMeters, exposureOpts);
      if (
        Array.isArray(scored) &&
        scored.length > 0 &&
        scored.every((r: any) => (r?.exposureCount ?? 0) > 0)
      ) {
        // No clean base route — iterative clean-route search (worst-step
        // bypass, widening radii). Jev stays outside the loop: ranking
        // happens below, now with a possibly-clean candidate.
        // searchCleanRoute returns the full set (base + newcomers), scored.
        try {
          const result = await searchCleanRoute(
            origin,
            destination,
            scored,
            cameras,
            bufferMeters,
            // Vias follow the profile that actually served the base route, so
            // a driving fallback never mixes modes inside one plan.
            async (o, d, v) =>
              (await fetchRoutesFor(o, d, v, usedProfile)).routes,
            exposureOpts,
            { deadlineMs: requestDeadline },
          );
          if (result && Array.isArray(result.routes) && result.routes.length > 0) {
            scored = result.routes;
            const baseMin = Math.min(
              ...baseRoutes.map((r: any) => Number(r?.distanceM ?? Infinity)),
            );
            const cleanMin = Math.min(
              ...scored
                .filter((r: any) => Number(r?.exposureCount ?? 0) === 0)
                .map((r: any) => Number(r?.distanceM ?? Infinity)),
            );
            cleanSearch = {
              cleanFound: Boolean(result.cleanFound),
              rounds: Number(result.rounds ?? 0),
              osrmCalls: Number(result.osrmCalls ?? 0) + 1,
              attempts: Number(result.attempts ?? 0),
              ...(result.aborted ? { aborted: true } : {}),
              ...(Number.isFinite(baseMin) &&
              baseMin > 0 &&
              Number.isFinite(cleanMin)
                ? { detourRatio: Math.round((cleanMin / baseMin) * 1000) / 1000 }
                : {}),
            };
          }
        } catch {
          // Clean search failed → keep base scoring (never 500s).
        }
      } else if (
        Array.isArray(scored) &&
        scored.length > 0 &&
        scored.some((r: any) => (r?.exposureCount ?? 0) === 0)
      ) {
        // Base already has a zero-exposure route — no search needed.
        cleanSearch = { cleanFound: true, rounds: 0, osrmCalls: 1 };
      }
    } else {
      scored = baseRoutes.map((r: any) => ({
        ...r,
        ...scoreRoute(r, cameras, bufferMeters, exposureOpts),
      }));
    }
  } catch {
    res.status(500).json({ error: "route-scoring-failed" });
    return;
  }

  // Edge-case sweep (spec P2-3): cleanSearch is ALWAYS described, so the UI
  // never has to guess between "no search ran" and "search found nothing".
  if (!cleanSearch) {
    cleanSearch = avoidFlock
      ? {
          cleanFound: scored.some((r: any) => Number(r?.exposureCount ?? 0) === 0),
          rounds: 0,
          osrmCalls: 0,
        }
      : {
          cleanFound: scored.some((r: any) => Number(r?.exposureCount ?? 0) === 0),
          rounds: 0,
          osrmCalls: 0,
          skipped: 'avoid-disabled',
        };
  }

  // Turn-by-turn steps + geometric seen-risk, computed BEFORE Jev ranking
  // so Jev gets exposureP / high-risk-step counts as input. Never 500s.
  const STEP_CAP = 100;
  const enrich = new Map<string, { steps: any[]; exposureP: number; highRiskSteps: number }>();
  try {
    for (const r of scored) {
      try {
        const raw = Array.isArray((r as any)?.steps)
          ? (r as any).steps.slice(0, STEP_CAP)
          : [];
        const steps = raw.map((s: any, index: number) => {
          const res = exposurePForPoints(
            s?.coordinates ?? [],
            cameras,
            bufferMeters,
            exposureOpts,
          );
          const p =
            typeof res?.p === 'number' && Number.isFinite(res.p)
              ? Math.min(1, Math.max(0, res.p))
              : 0;
          return {
            index,
            instruction: String(s?.instruction ?? ''),
            maneuver: String(s?.maneuver ?? ''),
            distanceM: Number(s?.distanceM ?? 0),
            durationS: Number(s?.durationS ?? 0),
            exposureP: Math.round(p * 1000) / 1000,
            cameraIds: Array.isArray(res?.cameraIds) ? res.cameraIds : [],
            // Step geometry for client-side navigation (locate-on-route).
            // Additive: omitted when the backend didn't carry steps.
            ...(Array.isArray(s?.coordinates) ? { coordinates: s.coordinates } : {}),
            // Backend-enriched OSRM fields: pass through when present,
            // omit when absent (never synthesize).
            ...(typeof s?.roadName === 'string' && s.roadName ? { roadName: s.roadName } : {}),
            ...(typeof s?.maneuverKind === 'string' && s.maneuverKind ? { maneuverKind: s.maneuverKind } : {}),
          };
        });
        const combined =
          1 - steps.reduce((acc: number, s: any) => acc * (1 - s.exposureP), 1);
        enrich.set(r?.id, {
          steps,
          exposureP: Math.round(combined * 1000) / 1000,
          highRiskSteps: steps.filter((s: any) => s.exposureP > 0.1).length,
        });
      } catch {
        enrich.set(r?.id, { steps: [], exposureP: 0, highRiskSteps: 0 });
      }
    }
  } catch {
    for (const r of scored) {
      if (!enrich.has(r?.id)) enrich.set(r?.id, { steps: [], exposureP: 0, highRiskSteps: 0 });
    }
  }

  // Jev ranking + exposure now share one cached, budgeted round-trip.
  const jevInput = {
    rank: scored.map((r: any) => ({
      id: r?.id,
      score: typeof r?.score === 'number' ? r.score : (r?.exposureCount ?? 0) * 10000 + (r?.distanceM ?? 0),
      distanceM: Number(r?.distanceM ?? 0),
      durationS: Number(r?.durationS ?? 0),
      exposureCount: Number(r?.exposureCount ?? 0),
      exposurePGeo: enrich.get(r?.id)?.exposureP ?? 0,
      highRiskSteps: enrich.get(r?.id)?.highRiskSteps ?? 0,
      cameraIds: Array.isArray((r as any)?.exposures)
        ? (r as any).exposures.slice(0, 20).map((e: any) => String(e?.cameraId ?? ''))
        : [],
    })),
    exposure: scored.map((r: any) => ({
      id: r?.id,
      exposurePGeo: enrich.get(r?.id)?.exposureP ?? 0,
      exposureCount: r?.exposureCount ?? 0,
      distanceM: r?.distanceM ?? 0,
    })),
  };
  let bundle: JevBundle;
  try {
    bundle = await rankAndEstimate(jevInput, {
      ...(apiKey ? { apiKey } : {}),
      threshold: confidenceThreshold(),
    });
  } catch {
    bundle = deterministicBundle(jevInput, apiKey);
  }
  const jev = bundle.rank;
  const rankedIds: string[] = Array.isArray((jev as any)?.rankedIds)
    ? (jev as any).rankedIds
    : scored.map((r: any) => r?.id);
  const verdicts: Record<string, any> = (jev as any)?.verdicts ?? {};
  const verdictList: any[] = Array.isArray(verdicts)
    ? (verdicts as any[])
    : Object.values(verdicts);
  const mode = (jev as any)?.mode === 'jev' ? 'jev' : 'fake';

  const order = new Map(rankedIds.map((id: string, i: number) => [id, i]));

  const jevExposureById: Record<string, any> = bundle.exposure ?? {};

  const routes = [...scored]
    .sort(
      (a: any, b: any) =>
        (order.get(a?.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b?.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .map((r: any, i: number) => {
      const v =
        (r?.id !== undefined ? verdicts[r.id] : undefined) ??
        verdictList[i] ??
        verdictList.find((x: any) => x?.choice === r?.id);
      const e = enrich.get(r?.id) ?? { steps: [], exposureP: 0, highRiskSteps: 0 };
      const je =
        (r?.id !== undefined ? jevExposureById[r.id] : undefined) ?? {
          p: e.exposureP,
          confidence: 0,
          fallbackUsed: true,
          source: 'geometric',
        };
      return {
        ...r,
        coordinates: Array.isArray(r?.coordinates)
          ? r.coordinates.slice(0, MAX_COORDS)
          : [],
        steps: e.steps,
        exposureP: e.exposureP,
        isClean: Number((r as any)?.exposureCount ?? 0) === 0,
        jevExposure: {
          p: typeof je?.p === 'number' ? je.p : e.exposureP,
          confidence: typeof je?.confidence === 'number' ? je.confidence : 0,
          fallbackUsed: je?.fallbackUsed ?? true,
          source: String(je?.source ?? 'geometric'),
        },
        jev: {
          choice: v?.choice ?? r?.id ?? String(i),
          confidence: typeof v?.confidence === 'number' ? v.confidence : 0,
          fallbackUsed: v?.fallbackUsed ?? true,
          ...(typeof v?.rationale === 'string' ? { rationale: v.rationale } : {}),
          ...(v?.tradeoff && typeof v.tradeoff === 'object' ? { tradeoff: v.tradeoff } : {}),
        },
      };
    });

  const rankedBy =
    verdictList.some((v: any) => v?.fallbackUsed === false) ? 'jev' : 'heuristic';

  // Structured summary (spec P3): outcome only — no coordinates, no key.
  logEvent('route_request', {
    profile: usedProfile,
    ...(profileFallback ? { profileFallback: true } : {}),
    routes: routes.length,
    cleanFound: cleanSearch?.cleanFound ?? false,
    ...(cleanSearch?.aborted ? { searchAborted: true } : {}),
    rankedBy,
    jevMode: mode,
    ms: Date.now() - startedAt,
  });

  res.json({
    routes,
    rankedBy,
    jevMode: mode,
    profile: usedProfile,
    ...(profileFallback ? { profileFallback: true } : {}),
    cleanSearch,
  });
});

interface ParsedFilter {
  ok: boolean;
  storeFilter?: CameraQueryFilter;
  maxDistM?: number;
}

/** Validate `cameraFilter` from an untrusted body. Non-strict fields are ignored. */
function parseCameraFilter(v: unknown): ParsedFilter {
  if (v === undefined) return { ok: true };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false };
  const raw = v as Record<string, unknown>;
  const storeFilter: CameraQueryFilter = {};

  if (raw.verifiedOnly !== undefined) {
    if (typeof raw.verifiedOnly !== 'boolean') return { ok: false };
    storeFilter.verifiedOnly = raw.verifiedOnly;
  }
  for (const field of ['brands', 'sources'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > 20) return { ok: false };
    if (value.some((s) => typeof s !== 'string' || s.length === 0 || s.length > 100)) {
      return { ok: false };
    }
    storeFilter[field] = value as string[];
  }

  let maxDistM: number | undefined;
  if (raw.maxDistM !== undefined) {
    const n = raw.maxDistM;
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 20_000) {
      return { ok: false };
    }
    maxDistM = n;
  }

  return {
    ok: true,
    ...(Object.keys(storeFilter).length > 0 ? { storeFilter } : {}),
    ...(maxDistM !== undefined ? { maxDistM } : {}),
  };
}

export default router;
