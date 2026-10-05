# Ghost Route — System Design (v1)

Source of truth for shapes: `PROJECT_BRIEF.md` (API contract §9-18). This doc adds module boundaries and data flow only.

<p align="center">
  <img src="repo-architecture.png" alt="Ghost Route System Architecture" width="100%">
</p>

## 1. Modules (repo paths)

| Module | Files | Owns |
|---|---|---|
| Client UI | `client/src/App.tsx`, `client/src/components/*.tsx` | Map, panels, toggles; no routing math |
| API client | `client/src/lib/api.ts` + `shared/types.ts` | Typed fetch; mirrors contract exactly |
| Routes (HTTP) | `server/src/routes/*.ts` | Validation (zod), status codes, rate limits |
| Routing svc | `server/src/services/*.ts` | OSRM fetch, polyline decode, haversine |
| Avoidance | `server/src/avoid.ts` | Buffer scoring, waypoint-detour candidates |
| Jev rank | `server/src/jev.ts` | `system_one` call, threshold gate, fake fallback |
| Jev cache/budget | `server/src/jevCache.ts` | Result cache keyed by candidate fingerprint; one shared deadline |
| Store/data | `server/src/store.ts`, `server/data/*` | `Store` interface (memory + JSON impls), bbox query, moderation, append-only user journal |
| Cross-cutting | `server/src/security.ts`, `server/src/cache.ts` | Headers/rate-limit/write token, profile→OSRM path map, TTL LRU cache |
| Client memory | `client/src/lib/prefs.ts`, `client/src/lib/deeplink.ts` | localStorage prefs/recents/saved places (DOM-free, injectable store); URL-hash route links |

## 2. Data flow — `POST /api/route`

1. Client (`App.tsx` → `lib/api.ts`) sends `{ origin, destination, avoidFlock, bufferMeters, respectDirection?, profile?, cameraFilter? }`. Requests are superseded via `lib/requestGuard.ts` (monotonic seq + `AbortController`); only the newest may write UI state. Boot hydration order: a shared `#r=…` link (`lib/deeplink.ts`) overrides stored preferences (`lib/prefs.ts`), and both are resolved once at mount.
2. Routes layer validates via zod (400 on bad lat/lon), applies rate limit.
3. Routing svc queries OSRM (`alternatives=3`) at the path for the requested profile (`security.routePathFor`: demo `/route/v1/{driving,foot,bike}`, FOSSGIS `/routed-{car,foot,bike}/route/v1/…`, custom always driving), returns polylines + distance/duration. Cache keys include the profile. A profile failure falls back to driving with `profileFallback:true` rather than erroring.
4. Avoidance scores each alternative: cameras within `bufferMeters` of polyline (haversine point-to-segment) → `exposures[]`, `exposureCount`. With `respectDirection` (default true), a camera carrying a known `direction` is only counted when the route's travel heading at the nearest point is within ~60° of that bearing (`headingAtNearest` / `angleDiffDeg` in `avoid.ts` + `services/scoring.ts`); directionless cameras are unaffected. `cameraFilter` is applied to the bbox query (via `store.camerasInBboxPage`), so every later stage — clean search, per-step exposure, JEV input — sees the same narrowed set; `maxDistM` is enforced by the scoring passes.

<p align="center">
  <img src="camera-proximity-avoidance.png" alt="Directional Facing & Buffer Zone Model" width="100%">
</p>

5. If `avoidFlock` and all alternatives exposed → avoidance builds detour candidates (offset midpoints perpendicular ~250/500m, re-query OSRM), re-scores.
6. Jev ranks: one `choice` question over candidate ids (criteria: exposure first, time second). Confidence ≥ `CONFIDENCE_THRESHOLD` (0.40) wins; below → heuristic (lowest exposure, then shortest duration). Returns `rankedBy`, per-route `jev` block, top-level `jevMode`.

   Ranking and exposure now go through `jevCache.rankAndEstimate`: a fingerprint of the candidate facts (`ids`, exposure counts, rounded durations, geometric risk, mode, threshold — never the key itself) is cached for `JEV_CACHE_TTL_MS`, both calls share one `JEV_BUDGET_MS` deadline, and a *degraded* result (timeout/network/non-2xx, flagged `rank.degraded`) is deliberately **not** cached so a transient blip cannot stick for the TTL. The clean-route search receives `{ deadlineMs }` from `ROUTE_BUDGET_MS` and returns partial results with `aborted:true` instead of running unbounded.

`GET /api/cameras?bbox` short-circuits at store (no OSRM/Jev) — now with optional trust/brand/source filters applied before decimation. `POST /api/cameras` validates → token check → store append; `report`/`DELETE` go through the same token + limiter.

### Navigation follow mode (client-only, no contract change)

`lib/useGeoPosition.ts` owns the single `watchPosition` stream (injectable core: `geoFixFromPosition`, `startGeoWatch`, `getGeoProvider`). `lib/useNavigation.ts` derives the locked step (`locateStep`), remaining distance, imminent cameras inside `CAMERA_ALERT_M`, and off-route state (`createOffRouteTracker`: >`OFF_ROUTE_M` for `OFF_ROUTE_FIXES` consecutive fixes). `App.tsx` owns the reroute cooldown (`REROUTE_COOLDOWN_MS`) and re-plans through the same `POST /api/route` from the live fix — the planned origin/destination are untouched, so navigation is not exited.

## 3. Failure modes

- **No `TYPESAFE_API_KEY` → fake mode.** `jev.ts` returns deterministic scorer, same shape, `jevMode:'fake'`, `fallbackUsed:true`. `GET /api/health` reports `{ ok:true, jev:{ mode:'fake', threshold } }`. Never 500 for missing key.
- **OSRM down / timeout → 502.** Shape: `{ error:{ code:'UPSTREAM_ROUTING_UNAVAILABLE', message:string } }`. No partial `routes` array; client shows retry. Cache (`server/src/cache.ts`) serves nothing stale for POST — GET-only caching.
- **Jev API error / low confidence → heuristic.** Same response shape, `rankedBy:'heuristic'`, winning route `jev.fallbackUsed:true`. Never fail the route request because ranking failed.
- **Bad input → 400** with zod detail; **rate-limit → 429**. Client surfaces inline, no retry storm.

## 4. Interfaces other agents MUST NOT break

### (a) Camera record — `shared/types.ts`, store, both camera endpoints
`{ id:string, lat:number, lon:number, source:string, address?:string, verified:boolean }` — fields additive-only; `lat`/`lon` stay numbers (no string coercion); bbox stays `minLon,minLat,maxLon,maxLat`. Optional `brand?`/`direction?` are carried but never required.

All client contract shapes are imported from `shared/src/types.ts` — no component declares its own copy. `npm run typecheck` runs shared → server → client so a contract change breaks consumers at compile time.

Camera persistence is behind the `Store` interface (`allCameras`, `cameraCounts`, `cameraById`, `camerasInBbox(Page)`, `addCamera`, `deleteCamera`, `reportCamera`) with two shipped implementations — `createMemoryStore(seed)` and `createJsonStore({ dataFile, userFile })` — both covered by one behavioral suite (`tests/store-impl.test.ts`). The JSON implementation loads the shipped seed **read-only** and appends one JSON line per mutation to `CAMERA_USER_FILE`, replaying it at boot: the 18MB seed is never rewritten, and concurrent appends cannot lose earlier writes (a torn final line is tolerated).

### (b) Route response — `POST /api/route` (§17-18)
`{ routes:[{ id, coordinates:[[lat,lon],...], distanceM, durationS, exposures:[{cameraId,lat,lon,distM}], exposureCount, score, jev:{ choice, confidence, fallbackUsed } }], rankedBy, jevMode }` — coordinate order is **[lat,lon]** end-to-end (OSRM `[lon,lat]` flipped at service boundary); `rankedBy`/`jevMode` literals exact.

### (c) Jev verdict — `server/src/jev.ts` return
`{ choice:string(routeId), confidence:number(0..1), fallbackUsed:boolean }` + module-level `jevMode:'jev'|'fake'`. Same shape in fake mode; threshold default 0.40 via env `CONFIDENCE_THRESHOLD`; never log key.

## 5. Constraints recap

Node 22, TS strict, zod server-side, no secrets in code/logs, no `.env` commits. OSRM + Nominatim need no keys; OSM tiles need no keys.
