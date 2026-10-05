# Ghost Route blueprint harness

Browser runs that produce every screenshot, video and number in the blueprint
(`docs/blueprint/ghost-route-blueprint.html`, published at https://claude.ai/artifact/Bw3VcP4MoGz6MtKuu9t1hw).
They drive the real app in Chrome (Playwright) against the Vite dev server and write raw
evidence to `blueprint-out/` (gitignored; override with `BP_OUT=/path`, the app with `APP_URL=...`).

Route responses come from recorded fixtures in `fixtures/` (served by `lib.mjs` through
`context.route`), so every run plans the same trips. Map tiles and `/api/cameras` stay live.
Reverse geocoding (Nominatim) is stubbed with fixed street names.

| Script | What it checks and captures |
|---|---|
| `lib.mjs` | shared plumbing: fixtures, trips, Chrome launch, app-ready wait, layout/geometry probes |
| `sweep.mjs` | planning UI on desktop (1440×900) and phone (390×844): idle states, labels, suggestion lists, route drawing order, chips, alternative selection, camera taps, panel-aware fit, Start button, sheet layout, phone compact summary, FAB/attribution placement, perf (fps while rotating in 3D, heap) |
| `routes.mjs` | route-look matrix: 3 trips × {desktop, phone} × {2D, 3D} = 12 measured frames (route in view, endpoints visible, chip clashes, line rendered) |
| `navigation.mjs` | feature pass: a phone drives the 2.3 km fixture route with emulated GPS that reports no heading or speed; checks the driving camera, computed heading, distances, camera alerts, reroute, pan/re-center, arrival, wake lock; records `video/navigation.webm` |
| `fixtures/*.json` | `/api/route` responses recorded from the local server (public OSRM demo backend, heuristic ranking) |

The repo's older CDP check, `scripts/verify-nav-browser.mjs` (`npm run verify:nav`), runs alongside these.

Run them one after another (never in parallel: perf numbers skew and logs clobber):

```sh
npm run dev:server &   # :8801
npm run dev:client &   # :5174
npm test && npm run typecheck && npm run build
for s in sweep routes navigation; do node tools/blueprint/$s.mjs || echo "$s FAILED"; done
npm run verify:nav
```

Each script writes `blueprint-out/data/report-<script>.json` (`{checks, perf, errors}`) and exits
non-zero on any failed check. The app exposes a dev-only automation hook, `window.__ghost`
(read-only state: routes, selection, navigation numbers), next to `window.__grMap`.

To re-record a fixture (needs the server and network):

```sh
curl -s -X POST localhost:8801/api/route -H 'content-type: application/json' \
  -d '{"origin":{"lat":30.256,"lon":-97.74},"destination":{"lat":30.27,"lon":-97.73},"avoidFlock":false,"respectDirection":false}' \
  > tools/blueprint/fixtures/trip-drive.json
```
