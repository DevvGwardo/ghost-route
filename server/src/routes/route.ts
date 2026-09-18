import { Router } from 'express';
import { fetchRoutes } from '../services/osrm.js';
import { rankByExposure, buildDetours } from '../avoid.js';
import { rankRoutes, estimateExposure } from '../jev.js';
import { scoreRoute, exposurePForPoints } from '../services/scoring.js';
import { camerasInBbox } from '../store.js';

const router = Router();

const MAX_COORDS = 2000;

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
    const geoms = await fetchRoutes(origin, destination);
    // OSRM geometries carry no ids — assign stable ones for ranking/response.
    baseRoutes = geoms.map((r: any, i: number) => ({ id: `route-${i}`, ...r }));
  } catch {
    res.status(502).json({ error: 'routing-unavailable' });
    return;
  }
  if (!Array.isArray(baseRoutes)) {
    res.status(502).json({ error: 'routing-unavailable' });
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
  const cameras =
    minLon <= maxLon && minLat <= maxLat
      ? camerasInBbox(minLon, minLat, maxLon, maxLat, 2000).filter((c) =>
          isLatLon(c),
        )
      : [];

  // Score by camera exposure (guarded: one corrupt row must not 500 the route).
  let scored: any[];
  let jev: any;
  try {
    if (avoidFlock) {
      scored = rankByExposure(baseRoutes, cameras, bufferMeters);
      if (
        Array.isArray(scored) &&
        scored.length > 0 &&
        scored.every((r: any) => (r?.exposureCount ?? 0) > 0)
      ) {
        let detourN = 0;
        const detours = await buildDetours(
          origin,
          destination,
          baseRoutes,
          async (o, d, v) =>
            (await fetchRoutes(o, d, v)).map((r: any) => ({
              id: `detour-${detourN++}`,
              ...r,
            })),
        );
        if (Array.isArray(detours) && detours.length > 0) {
          scored = rankByExposure(
            [...baseRoutes, ...detours],
            cameras,
            bufferMeters,
          );
        }
      }
    } else {
      scored = baseRoutes.map((r: any) => ({
        ...r,
        ...scoreRoute(r, cameras, bufferMeters),
      }));
    }

    jev = await rankRoutes(scored, { apiKey });
  } catch {
    res.status(500).json({ error: "route-scoring-failed" });
    return;
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

  // Turn-by-turn steps + JEV exposure (additive). Any failure here falls back
  // to steps:[] + exposureP:0 + geometric jevExposure — never 500s scored routes.
  const STEP_CAP = 100;
  const enrich = new Map<string, { steps: any[]; exposureP: number }>();
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
        });
      } catch {
        enrich.set(r?.id, { steps: [], exposureP: 0 });
      }
    }
  } catch {
    for (const r of scored) {
      if (!enrich.has(r?.id)) enrich.set(r?.id, { steps: [], exposureP: 0 });
    }
  }

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
      const e = enrich.get(r?.id) ?? { steps: [], exposureP: 0 };
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
        },
      };
    });

  res.json({
    routes,
    rankedBy: verdictList.some((v: any) => v?.fallbackUsed === false)
      ? "jev"
      : "heuristic",
    jevMode: mode,
  });
});

export default router;
