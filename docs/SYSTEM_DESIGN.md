# Ghost Route — System Design (v1)

Source of truth for shapes: `PROJECT_BRIEF.md` (API contract §9-18). This doc adds module boundaries and data flow only.

## 1. Modules (repo paths)

| Module | Files | Owns |
|---|---|---|
| Client UI | `client/src/App.tsx`, `client/src/components/*.tsx` | Map, panels, toggles; no routing math |
| API client | `client/src/lib/api.ts` + `shared/types.ts` | Typed fetch; mirrors contract exactly |
| Routes (HTTP) | `server/src/routes/*.ts` | Validation (zod), status codes, rate limits |
| Routing svc | `server/src/services/*.ts` | OSRM fetch, polyline decode, haversine |
| Avoidance | `server/src/avoid.ts` | Buffer scoring, waypoint-detour candidates |
| Jev rank | `server/src/jev.ts` | `system_one` call, threshold gate, fake fallback |
| Store/data | `server/src/store.ts`, `server/data/*` | Camera CRUD, bbox query |
| Cross-cutting | `server/src/security.ts`, `server/src/cache.ts` | Headers/rate-limit, OSRM+Nominatim cache |

## 2. Data flow — `POST /api/route`

1. Client (`RoutePanel.tsx` → `lib/api.ts`) sends `{ origin, destination, avoidFlock, bufferMeters }`.
2. Routes layer validates via zod (400 on bad lat/lon), applies rate limit.
3. Routing svc queries OSRM (`alternatives=3`), returns polylines + distance/duration.
4. Avoidance scores each alternative: cameras within `bufferMeters` of polyline (haversine point-to-segment) → `exposures[]`, `exposureCount`.
5. If `avoidFlock` and all alternatives exposed → avoidance builds detour candidates (offset midpoints perpendicular ~250/500m, re-query OSRM), re-scores.
6. Jev ranks: one `choice` question over candidate ids (criteria: exposure first, time second). Confidence ≥ `CONFIDENCE_THRESHOLD` (0.40) wins; below → heuristic (lowest exposure, then shortest duration). Returns `rankedBy`, per-route `jev` block, top-level `jevMode`.

`GET /api/cameras?bbox` short-circuits at store (no OSRM/Jev). `POST /api/cameras` validates → store append.

## 3. Failure modes

- **No `TYPESAFE_API_KEY` → fake mode.** `jev.ts` returns deterministic scorer, same shape, `jevMode:'fake'`, `fallbackUsed:true`. `GET /api/health` reports `{ ok:true, jev:{ mode:'fake', threshold } }`. Never 500 for missing key.
- **OSRM down / timeout → 502.** Shape: `{ error:{ code:'UPSTREAM_ROUTING_UNAVAILABLE', message:string } }`. No partial `routes` array; client shows retry. Cache (`server/src/cache.ts`) serves nothing stale for POST — GET-only caching.
- **Jev API error / low confidence → heuristic.** Same response shape, `rankedBy:'heuristic'`, winning route `jev.fallbackUsed:true`. Never fail the route request because ranking failed.
- **Bad input → 400** with zod detail; **rate-limit → 429**. Client surfaces inline, no retry storm.

## 4. Interfaces other agents MUST NOT break

### (a) Camera record — `shared/types.ts`, store, both camera endpoints
`{ id:string, lat:number, lon:number, source:string, address?:string, verified:boolean }` — fields additive-only; `lat`/`lon` stay numbers (no string coercion); bbox stays `minLon,minLat,maxLon,maxLat`.

### (b) Route response — `POST /api/route` (§17-18)
`{ routes:[{ id, coordinates:[[lat,lon],...], distanceM, durationS, exposures:[{cameraId,lat,lon,distM}], exposureCount, score, jev:{ choice, confidence, fallbackUsed } }], rankedBy, jevMode }` — coordinate order is **[lat,lon]** end-to-end (OSRM `[lon,lat]` flipped at service boundary); `rankedBy`/`jevMode` literals exact.

### (c) Jev verdict — `server/src/jev.ts` return
`{ choice:string(routeId), confidence:number(0..1), fallbackUsed:boolean }` + module-level `jevMode:'jev'|'fake'`. Same shape in fake mode; threshold default 0.40 via env `CONFIDENCE_THRESHOLD`; never log key.

## 5. Constraints recap

Node 22, TS strict, zod server-side, no secrets in code/logs, no `.env` commits. OSRM + Nominatim need no keys; OSM tiles need no keys.
