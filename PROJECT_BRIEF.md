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
  `GET /api/system/verify` (header `x-typesafe-key`) → `{ mode, valid, confidence?, error? }`
  where `error` is `key-required` | `unauthorized` | `unreachable`. Never echoes the key.

## Jev integration (server/src/jev.ts owned by backend)

- Live: `POST https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`,
  one `choice` question over candidate route ids, criteria = minimize camera
  exposure first, then travel time. Gate at `CONFIDENCE_THRESHOLD` (default
  0.40, same as ~/jev-mcp): below threshold → fallback to heuristic best.
- No key: deterministic `fake` scorer, same return shape, `jevMode:'fake'`.
- Never log the API key. Never commit `.env`.

## Routing (OSRM public demo, no key)

`https://router.project-osrm.org/route/v1/driving/{lon,lat};{lon,lat}?overview=full&geometries=geojson&alternatives=3`
Avoidance: score alternatives by cameras within `bufferMeters` of the polyline;
if all exposed, build waypoint-detour candidates (offset midpoints
perpendicular, re-query OSRM) and re-score. Haversine for distances.

## Camera data (server/data/flock-cameras.json owned by data agent)

Seed from deflock.me (crowd-sourced Flock map) + synthetic Austin TX cluster
for offline tests. Import script `scripts/import-deflock.mjs` re-runnable.

## Client (Vite + React 18 + MapLibre GL)

- `MapView.tsx`: Leaflet map, OSM tiles, click sets origin/dest.
- `SearchBar.tsx`: Nominatim geocode.
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
