# Ghost Route — Flock-camera-aware routing

A Google-Maps-style web app for privacy navigation: it shows Flock Safety
ALPR cameras near you and ranks driving routes by camera exposure, so you can
take paths with the fewest (ideally zero) Flock cameras. Route ranking goes
through TypeSafe Jev (`system_one` choice head) when `TYPESAFE_API_KEY` is set,
with a deterministic heuristic fallback otherwise.

Built by a 10-agent Muse Spark 1.3 Contributor crew
(architect, backend, frontend, api, data, test, debug, security, perf, reviewer).
Review gate: APPROVED. `npm run typecheck` clean, `npm test` 40/40 green.

## Quickstart (test it)

```sh
cd ~/ghost-route
npm install          # once
cp .env.example .env # optional; works without TYPESAFE_API_KEY (fake mode)

# Terminal 1 — API (http://127.0.0.1:8801)
npm run dev:server

# Terminal 2 — map UI (http://127.0.0.1:5174)
npm run dev:client
```

Open http://127.0.0.1:5174: click the map to set origin then destination
(Alt-click restarts), or use the From/To search (Nominatim). Hit **Find clean
route**. Green = zero camera exposures; amber = exposed. Each route shows
distance, time, exposure count, and the Jev confidence badge (`fallback` =
heuristic served, either no API key or low confidence).

Tap a route to expand it: a **Seen risk** header shows the JEV probability of
being observed by at least one Flock camera (green <10%, amber 10–40%, red
>40%), followed by a turn-by-turn **Steps** list — every step carries its own
exposure % and the camera IDs behind it. The map tilts into 3D (pitch 60° with
building extrusions) whenever routes are shown; the Mountain/Box button toggles
2D/3D manually.

## API

- `GET /api/health` → `{ ok, jev: { mode: 'jev'|'fake', threshold } }`
- `GET /api/cameras?bbox=minLon,minLat,maxLon,maxLat&limit=500`
- `POST /api/cameras` `{ lat, lon, address? }` — crowd-source a camera
- `POST /api/route` `{ origin, destination, avoidFlock=true, bufferMeters=150 }`
  → `{ routes: [{ id, coordinates, distanceM, durationS, exposures, exposureCount, score, jev }], rankedBy, jevMode }`
- `GET /api/system/status` → `{ mode, threshold, cameraCount, osrm }`
- `GET /api/system/verify` (header `x-typesafe-key`) → `{ mode, valid, confidence?, error? }`

## How avoidance works

1. OSRM public demo returns up to 3 alternative road routes.
2. Every route is scored: cameras within `bufferMeters` of the polyline dominate
   (`score = exposures × 10000 + distanceM`).
3. If all alternatives are exposed, two waypoint-detour candidates (±1000 m
   perpendicular offsets, re-routed via OSRM) are added and re-scored.
4. Jev picks the winner (exposure first, then time); below
   `CONFIDENCE_THRESHOLD` (default 0.40) the heuristic best is served instead.

## Camera data

`server/data/flock-cameras.json` — **650 real ALPR nodes** from OpenStreetMap
(`surveillance:type=ALPR`, Austin metro), 591 with `manufacturer=Flock Safety`
→ `verified:true`. No synthetic rows. Refresh from live OSM data anytime:

```sh
node scripts/import-deflock.mjs        # Overpass → normalize → merge, de-duped
node scripts/import-deflock.mjs --synthetic  # regenerate the seed
node scripts/repro-avoid.mjs           # avoidance proof: detour 3 → 0 exposures
```

## Live Jev mode (bring your own key)

No key ships with the repo. There are two ways to activate live JEV ranking:

1. **In the app (per user, recommended for open-source users):** open Route options → JEV key field, paste your
   key, Save, then **Test**. It's stored only in your browser's localStorage and sent as an
   `x-typesafe-key` header on route requests. The header chip shows
   "JEV live" only when the key verifies AND the last ranking was live (`rankedBy: jev`).
   Clear it anytime to go back to heuristic mode. Without a key, clean-route search still works via heuristic.
2. **On the server (default for all users):** set `TYPESAFE_API_KEY` in `.env`
   (see `.env.example`, `PORT=8801`; request a key at typesafe.ai early access).

Precedence per request: `x-typesafe-key` header → `TYPESAFE_API_KEY` env →
none (`fake` mode). Without any key, `jevMode: 'fake'` serves the same
response shape deterministically. The server never logs, persists, or echoes
keys; below `CONFIDENCE_THRESHOLD` (default 0.40) the heuristic best is served
instead, flagged `fallbackUsed: true`.

Troubleshooting a pasted key:
- `GET /api/system/verify` with `x-typesafe-key` header returns `{ valid, confidence?, error? }`
  (`unauthorized` = 401/403 from TypeSafe, `unreachable` = network/timeout). The UI Test button calls this.
- If routes show `fallback` + `heuristic`, the key was present but Jev was unreachable, low-confidence, or invalid — check Test output.
- `GET /api/system/status` shows `{ mode, threshold, cameraCount, osrm }` for the current key.

## Notes

- Ports: server defaults to **8801** (`PORT` in `.env`), client to **5174**.
  In dev the Vite proxy forwards `/api` to the server, so no extra config is
  needed. For split deploys set `VITE_API_URL` (e.g. `VITE_API_URL=https://api.example.com`)
  before `npm run build -w client`.
- MapLibre worker is self-hosted at `client/public/gr-map-worker.mjs` (+
  `gr-map-shared.mjs`) with `setWorkerUrl` in `MapView.tsx`: vite dev cannot
  resolve maplibre's default worker URL (and the original filename collides
  with the dep optimizer), which silently leaves tiles unrendered. Both files
  are gitignored and regenerated by `npm postinstall`
  (`scripts/copy-maplibre-worker.mjs`) — no manual step. Note: vite only picks
  up new `public/` files on restart.
- Tiles: CARTO Voyager (free, no key) + © OpenStreetMap contributors. Routing: OSRM demo (rate-limited, not for production).
  Geocoding: Nominatim (demo-grade volume; heavy use needs your own instance).
- Camera data: `server/data/flock-cameras.json` nodes are derived from
  OpenStreetMap (`surveillance:type=ALPR`, ODbL) — keep the OSM attribution
  when reusing the dataset.
- Privacy: origin/destination are POSTed to the server (and to OSRM for
  routing). Self-host both if that matters to you; the TypeSafe key is sent
  as a header and never logged or persisted server-side.
- Production hardening (defaults are local-dev grade): restrict CORS origins
  in `server/src/index.ts`, put auth in front of `POST /api/cameras` (open
  crowd-source endpoint), note rate limits + camera store are in-memory
  (single instance), and replace the OSRM demo + Nominatim with hosted
  instances before real traffic.
