# Ghost Route — Free / Open-Source Stack (v1)

Mission: zero paid or keyed dependencies **except** the TypeSafe key (`TYPESAFE_API_KEY` / `x-typesafe-key`).
Verified 2026-09-18 by grepping every `fetch`/`axios`/`https?://` in `client/src`, `server/src`, `scripts`.

## 1. Dependency inventory (runtime network calls)

| # | Service | Used in | Purpose | Cost | Key? | License / terms |
|---|---|---|---|---|---|---|
| 1 | TypeSafe SystemOne `POST https://api.typesafe.ai/v1/systemone` | `server/src/jev.ts:38,55,220,279` | Jev exposure scoring (live mode) | Paid/keyed — **the one allowed exception** | Proprietary; BYOK header or env, fake-mode fallback without key |
| 2 | OSRM demo `https://router.project-osrm.org` | `server/src/security.ts:71`, `server/src/services/osrm.ts:100,138`, `server/src/routes/system.ts:14` | Default routing backend (`ROUTING_BACKEND=demo`) | Free | BSD-2-Clause (OSRM); demo server is a free public instance, rate-limited |
| 3 | FOSSGIS routing `https://routing.openstreetmap.de` | `server/src/security.ts:72` (preset `fosssgis`) | Alt routing backend | Free | ODbL data + free public instance run by FOSSGIS e.V. |
| 4 | Self-host OSRM (`custom` + `OSRM_BASE`, loopback opt-in) | `server/src/security.ts:83-125` | Operator-run routing, no third party | Free (own infra) | Same OSRM BSD license; Docker path documented, unavailable on this box |
| 5 | Nominatim `https://nominatim.openstreetmap.org/search` | `client/src/lib/geocode.ts` (via `DirectionsCard.tsx`) | Client-side geocode **fallback** (Photon-miss/throw only) | Free | ODbL; ≤1 req/s policy — fallback-only, debounced upstream |
| 6 | Photon `https://photon.komoot.io/api` | `client/src/lib/geocode.ts` (via `DirectionsCard.tsx`) | Geocode autocomplete **primary** | Free, no key, `CORS: *`, GeoJSON `features[].properties{name,county,state,country}`, coords `[lon,lat]` | Apache-2.0 (Photon) + ODbL data |
| 7 | CARTO Voyager `https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json` | `client/src/components/MapView.tsx:50` | Basemap tiles/style | Free, no key | ODbL data (OSM), CARTO free tier for basemaps |
| 8 | Same-origin backend (`VITE_API_URL` or `''`) | `client/src/lib/api.ts:29-42` | All app API traffic stays first-party | Free (own backend) | N/A — no third party |
| 9 | Camera snapshot `https://data.dontgetflocked.com/cameras.geojson.gz` + Overpass mirrors (`overpass-api.de`, `overpass.kumi.systems`, `overpass.nchc.org.tw`) | `scripts/import-deflock.mjs:28-32,275-353` — **build-time only, never runtime** | 141K OSM camera import → `server/data/` | Free | ODbL (OSM nodes via deflock/Overpass) |

Notes:
- `@mapbox/*` strings in `package-lock.json` are **transitive npm libs of maplibre-gl** (vector-tile parsing), not the Mapbox API — no key, no network, no cost. MapLibre itself is BSD-3-Clause, community OSS fork.
- No Mapbox API, no OpenRouteService, no Google Maps, no other keyed/paid call found anywhere in `client/src`, `server/src`, `scripts`.

## 2. Target free-stack (in words)

```
[Browser: MapLibre GL + CARTO Voyager tiles (free, no key)]
   │ geocode (Photon primary, Nominatim fallback — both client-side direct fetch)
   │ API calls (same-origin only)
   ▼
[Ghost Route server (own infra)]
   ├─ routing: OSRM protocol → demo (default) │ fosssgis (alt) │ custom self-host (operator)
   ├─ cameras: local R2 snapshot in server/data/ (build-time import, zero runtime deps)
   └─ scoring: TypeSafe SystemOne (ONLY keyed dep) → deterministic fake mode without key
```

## 3. Decision log

1. **Photon-primary / Nominatim-fallback.** Photon (`photon.komoot.io`) is purpose-built for autocomplete: `CORS: *`, generous free use, structured `properties` + `[lon,lat]` GeoJSON, no usage-policy rate anxiety. Nominatim stays as fallback because its relevance ranking is battle-tested — but its ≤1 req/s policy makes it the worse primary under typing bursts. (Wired in `client/src/lib/geocode.ts`, consumed by `DirectionsCard.tsx`.)
2. **FOSSGIS-alt + self-host path, demo default.** Demo (`router.project-osrm.org`) stays default for zero-config dev; FOSSGIS (`routing.openstreetmap.de`) is the no-Docker production alt — both free public instances behind the existing `ROUTING_BACKEND` switch (`security.ts:115-125`). `custom` + `OSRM_BASE` preserves the operator self-host escape hatch (Docker unavailable on this box, so it is documented, not exercised).
3. **Tiles stay CARTO Voyager.** Free, keyless, OSM-data basemap already wired (`MapView.tsx:50`); switching tile providers buys nothing and risks keyed-vendor creep. No change.

## 4. Ownership map (this crew's tracks)

Per `docs/OWNERSHIP.md` (brief authoritative on conflicts):

| Track | Owns (exclusive) |
|---|---|
| frontend | Geocode swap (Photon primary / Nominatim fallback in `DirectionsCard.tsx`), tile/style changes |
| backend | Routing backend selection, OSRM service (`server/src/services/osrm.ts`, `server/src/jev.ts`) |
| security | `server/src/security.ts` allowlist, `.env.example`, key handling |
| data | `server/data/*`, `scripts/import-deflock.mjs`, snapshot freshness |
| api | `shared/types.ts`, route contracts, `client/src/lib/api.ts` |
| test / debug / perf | Tests, avoidance engine, caching — read this doc, don't duplicate it |
| architect (this file) | `docs/STACK.md` — inventory + decisions only, no code |

## 5. Explicitly OUT of scope

- Keyed routing/geocode providers: **Mapbox Directions/Geocoding, OpenRouteService, Google Maps Platform, HERE, TomTom, Stadia/Thunderforest-keyed tiers** — never to be added; any PR introducing a key以外の `*_API_KEY` fails review.
- Native apps (iOS/Android) — web-only stack; no native SDKs, no store keys.
- Self-host Docker exercises on this box (Docker unavailable) — path stays documented/config-only.
- Any change to scoring outside TypeSafe-allowed-key + existing fake mode.
