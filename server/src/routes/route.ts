import { Router } from 'express';
import { fetchRoutes } from '../services/osrm.js';
import { rankByExposure } from '../avoid.js';
import { searchCleanRoute } from '../cleanroute.js';
import { rankRoutes, estimateExposure } from '../jev.js';
import { scoreRoute, exposurePForPoints, isPlausibleRoute } from '../services/scoring.js';
import { camerasInBbox } from '../store.js';

const router = Router();

const MAX_COORDS = 2000;

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

  let baseRoutes: any[];
  // BYOK: per-request user key (header > env > none); never log it.
  const headerVal = req.header('x-typesafe-key');
  const apiKey = (Array.isArray(headerVal) ? headerVal[0] : headerVal)?.trim() || undefined;
  try {
    const base = await fetchPlausibleBase(origin, destination);
    if (base.exhausted) {
      res.status(502).json({ error: 'routing-unavailable', reason: 'implausible-routes' });
      return;
    }
    baseRoutes = base.routes;
  } catch {
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
        ).filter((c) => isLatLon(c))
      : [];

  // Score by camera exposure (guarded: one corrupt row must not 500 the route).
  let scored: any[];
  let cleanSearch:
    | { cleanFound: boolean; rounds: number; osrmCalls: number; attempts?: number; detourRatio?: number }
    | undefined;
  try {
    if (avoidFlock) {
      scored = rankByExposure(baseRoutes, cameras, bufferMeters);
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
            async (o, d, v) => await fetchRoutes(o, d, v),
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
        ...scoreRoute(r, cameras, bufferMeters),
      }));
    }
  } catch {
    res.status(500).json({ error: "route-scoring-failed" });
    return;
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

  // Jev ranking now receives geometric risk + step concentration data.
  let jev: any;
  try {
    jev = await rankRoutes(
      scored.map((r: any) => ({
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
      { apiKey },
    );
  } catch {
    jev = undefined;
  }
  const rankedIds: string[] = Array.isArray((jev as any)?.rankedIds)
    ? (jev as any).rankedIds
    : scored.map((r: any) => r?.id);
  const verdicts: Record<string, any> = (jev as any)?.verdicts ?? {};
  const verdictList: any[] = Array.isArray(verdicts)
    ? (verdicts as any[])
    : Object.values(verdicts);
  const mode = (jev as any)?.mode === 'jev' ? 'jev' : 'fake';

  const order = new Map(rankedIds.map((id: string, i: number) => [id, i]));

  let jevExposureById: Record<string, any> = {};
  try {
    jevExposureById =
      (await estimateExposure(
        scored.map((r: any) => ({
          id: r?.id,
          exposurePGeo: enrich.get(r?.id)?.exposureP ?? 0,
          exposureCount: r?.exposureCount ?? 0,
          distanceM: r?.distanceM ?? 0,
        })),
        { apiKey },
      )) ?? {};
  } catch {
    jevExposureById = {};
  }

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
        (r?.id !== undefined ? jevExposureById[r.id] : undefined) ??
        {
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

  res.json({
    routes,
    rankedBy: verdictList.some((v: any) => v?.fallbackUsed === false)
      ? "jev"
      : "heuristic",
    jevMode: mode,
    ...(cleanSearch ? { cleanSearch } : {}),
  });
});

export default router;
