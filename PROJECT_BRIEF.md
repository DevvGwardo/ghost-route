# Ghost Route — Flock-camera-aware routing (Google-Maps clone)

Privacy navigation web app: shows Flock Safety ALPR cameras near the user and
routes around them. Map UI (Leaflet + OSM, no API key needed for tiles),
Node/Express API, real road routing via public OSRM, route ranking via
TypeSafe Jev (`system_one` choice head) with a deterministic fallback when no
`TYPESAFE_API_KEY` is set.

## API contract (v1 — DO NOT change shapes without orchestrator approval)

- `GET /api/health` → `{ ok:true, jev:{ mode:'jev'|'fake', threshold:number } }`
- `GET /api/cameras?bbox=minLon,minLat,maxLon,maxLat&limit=500`
  → `{ cameras:[{ id:string, lat:number, lon:number, source:string, address?:string, verified:boolean }] }`
- `POST /api/cameras` body `{ lat:number, lon:number, address?:string }`
  → `{ camera }` (validated; 400 on bad input; rate-limited)
- `POST /api/route` body
  `{ origin:{lat,lon}, destination:{lat,lon}, avoidFlock?:boolean=true, bufferMeters?:number=150 }`
  → `{ routes:[{ id:string, coordinates:[[lat,lon],...], distanceM:number, durationS:number, exposures:[{cameraId:string,lat:number,lon:number,distM:number}], exposureCount:number, score:number, jev:{ choice:string, confidence:number, fallbackUsed:boolean } }], rankedBy:'jev'|'heuristic', jevMode:'jev'|'fake' }`
- Additive (v1.1, shapes above unchanged):
  `GET /api/system/status` → `{ mode, threshold, cameraCount, osrm }`;
  `GET /api/system/verify` (header `x-typesafe-key`) → `{ mode, valid, confidence?, error?, status?, detail? }`
  where `error` is `key-required` | `invalid-key` | `unauthorized` | `invalid-request` |
  `rate-limited` | `upstream-error` | `timeout` | `unreachable`. The kinds are
  kept distinct so a rejected request, a slow call, and an unreachable host
  are not all reported the same way; `status` carries the upstream HTTP code,
  `detail` a key-scrubbed upstream message. Never echoes the key.
- Additive (v1.2, shapes above unchanged): `POST /api/route` accepts
  `respectDirection?:boolean` (default **true**). When true, a camera whose
  `direction` (OSM convention: compass bearing the camera points at, 0=N) is
  known only counts as an exposure when the route's travel heading where it
  passes nearest that camera is within ~60° of it. Cameras without a
  `direction` stay omnidirectional, so the legacy result is unchanged for
  them; `respectDirection:false` restores the fully omnidirectional model.
  Non-boolean → 400 `respectDirection-invalid`. Applies to base scoring,
  clean-route search and per-step exposure alike.

- Additive (v1.2, shapes above unchanged) — remaining fields:
  - `POST /api/route` also accepts
    `profile?:'driving'|'walking'|'cycling'` (default `driving`; anything else
    → 400 `profile-invalid`) and
    `cameraFilter?:{ verifiedOnly?:boolean, brands?:string[], sources?:string[], maxDistM?:number }`
    (malformed → 400 `cameraFilter-invalid`). `maxDistM` is a hard distance
    ceiling; `verifiedOnly`/`brands`/`sources` narrow the camera set **before**
    scoring, so counts and the clean-route search see one consistent set.
    Absent fields never restrict. A profile the backend has no graph for falls
    back to driving and says so via `profileFallback:true` (routes are still a
    200 — never a 502 for an unsupported mode).
  - `POST /api/route` response gains optional `profile` (the profile that
    actually served the routes), `profileFallback?:true`, and
    `cleanSearch` is now **always** present:
    `{ cleanFound, rounds, osrmCalls, attempts?, detourRatio?, aborted?, skipped? }`
    where `skipped:'avoid-disabled'` means the search did not run
    (`avoidFlock:false`) and `aborted:true` means it stopped at the
    `ROUTE_BUDGET_MS` deadline with partial results.
  - `GET /api/cameras?bbox=…` also accepts `verifiedOnly=1`, `brand=`, `source=`
    (repeatable or comma-separated). Filters apply before decimation, so
    `total`/`truncated` describe the filtered set. Response shape unchanged.
- Additive (directions fix): internal camera records may carry
  `directions?:number[]` — additional compass bearings watched by multi-headed
  units (e.g. both directions of a road), sourced from the snapshot's
  `directions` property. Direction-aware exposure counts a camera when the
  route's travel heading is within tolerance of **any** known bearing
  (`direction` ∪ `directions`); `direction === 0` (due north) is a real
  bearing, never treated as unknown. Cameras with no bearings stay
  omnidirectional. Not exposed in any response shape.
  - `POST /api/cameras/:id/report` body `{ reason }` where reason ∈
    `gone | not-a-camera | wrong-location | other` →
    `{ camera, reports:number, reasons:Record<string,number> }`;
    400 `reason-invalid` (+ `allowed[]`), 404 `camera-not-found`.
  - `DELETE /api/cameras/:id` → `{ deleted:camera }`; 404 when absent.
  - `POST /api/cameras` and both moderation endpoints require the
    `x-camera-token` header when `CAMERA_WRITE_TOKEN` is set (401
    `camera-token-required` otherwise compared in constant time). **Unset =
    open**, which is the documented dev default.
  - `GET /api/system/status` gains `cameraCounts:{ total, verified }` and
    `routingBackend:'demo'|'fosssgis'|'custom'` (additive; `cameraCount` keeps
    its meaning).

  New server env knobs (all optional, all defaulted): `ROUTE_BUDGET_MS`
  (12000, ceiling for the clean-route search), `JEV_BUDGET_MS` (10000, shared
  ranking+exposure deadline), `JEV_CACHE_TTL_MS` (60000; `0` disables),
  `CAMERA_DATA_FILE` (seed path, read-only), `CAMERA_USER_FILE` (append-only
  user journal), `CAMERA_WRITE_TOKEN`.

## Jev integration (server/src/jev.ts owned by backend)

- Live: `POST https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`,
  one `choice` question over candidate route ids, criteria = minimize camera
  exposure first, then travel time. Gate at `CONFIDENCE_THRESHOLD` (default
  0.40, same as ~/jev-mcp): below threshold → fallback to heuristic best.
- No key: deterministic `fake` scorer, same return shape, `jevMode:'fake'`.
- Never log the API key. Never commit `.env`.

## Routing (OSRM-protocol backend, demo by default, swappable)

`ROUTING_BACKEND=demo|fosssgis|custom` (`server/src/services/osrm.ts`;
demo = public OSRM, fosssgis = higher-capacity public instance, custom =
self-hosted origin via `OSRM_BASE`, validated, fails-safe-to-demo).
Non-demo primaries fall back to demo once on hard failure; active backend on
`GET /api/system/status`.
`{origin}/<backend-path>/{lon,lat};{lon,lat}?overview=full&geometries=geojson&alternatives=3&steps=true` (`<backend-path>` = `/route/v1/driving`, fosssgis `/routed-car` prefix; instructions use refs/destinations + full step polylines, `roadName`/`maneuverKind` carried additively)
Avoidance: score alternatives by cameras within `bufferMeters` of the polyline;
base routes pass a plausibility gate first (length-aware multiple of
straight-line distance; one refetch on transient garbage, then 502 with
`reason: implausible-routes` vs `osrm-error`; counters on
`GET /api/system/status`). If none is clean, iterative clean-route search
(`server/src/cleanroute.ts`): worst-exposure step → paired perpendicular
bypass vias at 500m/1km/2km, re-query OSRM (max 3 rounds, 7 calls, 1.5x
distance cap; tune via `CLEAN_MAX_ROUNDS` / `CLEAN_VIA_TIMEOUT_MS`),
re-score, keep best. Haversine for distances.

## Camera data (server/data/flock-cameras.json owned by data agent)

Seed from deflock.me (crowd-sourced Flock map) + synthetic Austin TX cluster
for offline tests. Import script `scripts/import-deflock.mjs` re-runnable.

## Client (Vite + React 18 + MapLibre GL)

- Navigation state (GPS watch, current step, off-route detection) lives in
  `client/src/lib/useNavigation.ts` + `client/src/lib/useGeoPosition.ts` so the
  banner and the map share one fix; `NavigateBanner.tsx` is presentational.
- `MapView.tsx`: Leaflet map, OSM tiles, click sets origin/dest.
- `DirectionsCard.tsx`: Photon geocode (free, no key; Nominatim fallback),
  route options, avoid toggle + buffer slider, BYOK key field.
- `CameraLayer.tsx`: markers + buffer-radius circles.
- `RoutePanel.tsx`: ranked routes, exposure counts, Jev confidence badge,
  avoid toggle + buffer slider.
- `lib/api.ts` (api agent): typed fetch client for the contract above.

## File ownership (exclusive — never touch another agent's files)

- architect: `docs/SYSTEM_DESIGN.md`, `docs/OWNERSHIP.md`
- backend: `server/src/index.ts`, `server/src/jev.ts`, `server/src/services/*.ts`
- api: `shared/types.ts`, `server/src/routes/*.ts`, `client/src/lib/api.ts`
- frontend: `client/src/App.tsx`, `client/src/main.tsx`, `client/index.html`,
  `client/src/components/*.tsx`, `client/src/*.css`
- data: `server/src/store.ts`, `server/data/*`, `scripts/import-deflock.mjs`
- test: `tests/*.test.ts`, `tests/helpers.ts`
- debug: `server/src/avoid.ts`, `scripts/repro-avoid.mjs`
- security: `server/src/security.ts`, `.env.example`
- perf: `server/src/cache.ts`
- orchestrator (me): `package.json`, `server/package.json`,
  `client/package.json`, `*/tsconfig.json`, `client/vite.config.ts` — crew must
  NOT edit these; missing deps go in your report, I install them.

## Rules

- Node 22. TypeScript strict. Validate all inputs server-side (zod is
  installed). No secrets in code/logs. Behavioral tests over source-regex
  tests. Keep it minimal — no features outside this brief.
