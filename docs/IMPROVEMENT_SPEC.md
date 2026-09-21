# Ghost Route — Functional Improvement Spec (v2)

Status: **proposal / draft for orchestrator review**
Author: Buffy
Date: 2026-09-18
Companion docs: `PROJECT_BRIEF.md` (authoritative on contract + rules), `docs/SYSTEM_DESIGN.md`, `docs/STACK.md`, `docs/OWNERSHIP.md`

---

## 1. Purpose & scope

This spec improves **functionality** — what the product can do and how correctly it
does it — not visual polish. It is written against the current `master` tree
(9 commits, ~145 tests, server on Express 4, client on Vite + React 18 + MapLibre,
routing via OSRM, ranking via TypeSafe JEV with a deterministic fallback).

Guiding constraints from `PROJECT_BRIEF.md` (must hold):

- **No new keyed/paid providers** (STACK.md §5). TypeSafe remains the only keyed dep.
- **API shapes are additive-only** unless an orchestrator approves a breaking change.
- Node 22, TypeScript strict, zod server-side validation, no secrets in logs, behavioral tests.
- Respect the file-ownership table; the orchestrator owns `package.json`/tsconfigs.

Every proposal below is tagged with a priority and a workstream. **P0 items are
correctness/UX defects that undercut the core promise ("take the route with the
fewest cameras, ideally zero").**

---

## 2. Current-state analysis

### 2.1 What already works well

| Area | Evidence |
|---|---|
| Real road routing with alternatives | `server/src/services/osrm.ts` (`alternatives=3`, `steps=true`, geojson) |
| Exposure scoring + ranking | `server/src/avoid.ts` `rankByExposure` (`exposures × 10000 + distanceM`) |
| Iterative clean-route search (worst-step bypass vias, widening radii, spur stripping) | `server/src/cleanroute.ts` |
| JEV `system_one` choice head + threshold gate + deterministic fallback | `server/src/jev.ts` (`rankRoutes`, `estimateExposure`, `verifyKey`) |
| BYOK key passthrough, never logged | `route.ts` header → `jev.ts`; `security.ts` `noKeyLeak` |
| SSRF-safe routing backend selection | `server/src/security.ts` `resolveRoutingBackend` / `ssrfSafeUrl` |
| Plausibility guard against garbage OSRM routes | `services/scoring.ts` + `route.ts` `fetchPlausibleBase` |
| Rate limiting, TTL LRU routing cache | `security.ts`, `cache.ts` |
| Turn-by-turn steps with per-step exposure | `osrm.ts` `buildSteps`, `route.ts` enrichment, `TurnSteps.tsx` |
| GPS navigation banner with camera lookahead | `NavigateBanner.tsx`, `lib/navigate.ts` |
| Geocode autocomplete with Photon→Nominatim fallback | `lib/geocode.ts` |

### 2.2 Structural observations

1. **The client re-declares the API contract by hand** instead of consuming
   `shared/src/types.ts`. `App.tsx` defines its own `Camera`, `RankedRoute`,
   `RouteExposure`; `MapView.tsx`, `CameraLayer.tsx`, `DirectionsCard.tsx` each
   define yet more local copies. Drift here silently produces runtime bugs
   (e.g. `isClean` is recomputed client-side rather than trusted). This is a
   functional risk even though it is "only" duplication.
2. **Navigation and the map are decoupled.** `NavigateBanner` owns the GPS watch
   and step state; `MapView` receives only `origin`/`destination`/`recenter`.
   Nothing moves the map during navigation, and `MapRoute` carries only
   `coordinates` + `exposureCount` — no camera markers ahead, no heading.
3. **`Camera.direction` exists but is never used.** `shared/src/types.ts` and
   `store.ts` carry `direction?`, and the import script can populate it, but
   `avoid.ts`/`scoring.ts` treat every camera as omnidirectional.
4. **Camera trust is flat.** ~141k nodes are loaded once at boot; `verified` and
   `brand` are carried but never influence scoring or UI filtering. A user-submitted
   (unverified) node immediately affects every subsequent route for every user.
5. **No request supersession on the client.** `App.tsx` `findRoute()` has no
   sequence guard or `AbortController`. The endpoint-change effect debounces, but
   a manual **Find** or a slider-triggered refetch can race: a slower older
   response can land last and overwrite newer results.
6. **JEV is invoked twice per route request, uncached** (`rankRoutes` +
   `estimateExposure`), each with a 10s timeout. Two full network round-trips on
   the critical path of every route.

---

## 3. Gap register (prioritized)

| ID | Gap | Impact | Priority | Workstream |
|---|---|---|---|---|
| G1 | Map does not track the user during navigation; no off-route handling | Turn-by-turn is unusable in practice; core feature is half-built | **P0** | frontend |
| G2 | No request supersession/cancellation on route/camera fetches | Stale responses overwrite fresh ones; wrong route shown | **P0** | frontend/api |
| G3 | Exposure ignores camera direction | Over-avoids; "fewest cameras" is inaccurate when headers exist | **P0** | debug/backend |
| G4 | Contract duplicated across client files | Silent drift → runtime bugs; high change cost | **P0** | api/frontend |
| G5 | Camera trust/brand not filterable or weighted | Unverified nodes pollute routing for everyone | **P1** | data/api/backend |
| G6 | No shareable/deep-linkable routes | Cannot bookmark or share a route (Google-Maps baseline) | **P1** | frontend |
| G7 | No persistence of recents/saved places/preferences | Repeated manual re-entry | **P1** | frontend |
| G8 | Only driving profile; no walking/cycling | Narrower than a "maps clone" | **P1** | backend/api |
| G9 | `POST /api/cameras` unauthenticated; no edit/verify/delete | Abuse + permanently wrong data; single-instance JSON file | **P1** | security/data |
| G10 | JEV results uncached; two calls per request; no overall time budget | Latency, cost, thundering-herd under load | **P2** | perf/backend |
| G11 | Rate limits + camera store are per-process memory | Horizontal scaling silently breaks limits/persistence | **P2** | perf/data |
| G12 | Empty/edge inconsistencies (`cleanSearch` absent when `avoidFlock=false`; client slider 50–500 vs server 5000) | Confusing UI states | **P2** | api/frontend |
| G13 | No structured logging/metrics | Cannot diagnose prod | **P3** | backend |
| G14 | No PWA/offline, no voice guidance | Nice-to-have | **P3** | frontend |

---

## 4. Detailed proposals

### P0-1 — Navigation follow mode + off-route recovery (G1)

**Goal.** While navigating, the map follows the vehicle, rotates toward heading,
highlights the next maneuver, and escalates when the driver leaves the route.

**Changes**

- Lift the GPS watch out of `NavigateBanner.tsx` into a new `client/src/lib/useGeoPosition.ts`
  hook (or an `App.tsx` effect) so **both** the banner and `MapView` consume one fix.
  Banner keeps rendering maneuvers; map gains position.
- Extend `MapViewProps` with:
  ```ts
  userPosition?: { lat: number; lon: number; heading?: number; speedMps?: number } | null;
  followUser?: boolean;
  nextManeuver?: { lat: number; lon: number } | null;
  navCameras?: { lat: number; lon: number }[]; // cameras ahead within alert window
  ```
- Follow mode: when `followUser` is true and the map is not paused, `map.jumpTo`
  (or `easeTo` with `duration:0` on reduced-motion) to the fix with `bearing = heading`,
  keeping pitch. A "recenter / stop following" affordance lets the user pan away
  (pan sets `followUser=false` until tapped).
- Off-route detection in `lib/navigate.ts`: if `locateStep` returns `null` for
  `N` consecutive fixes (or distance-to-polyline > e.g. 80 m), emit `offRoute`.
  Banner shows "Rerouting…" and calls the existing route API with the current
  fix as origin to the same destination. Debounce to one reroute per 15 s.
- Add a next-turn marker (small chevron) at the start of the next step and
  emphasize the traveled portion of the route (split selected polyline into
  "driven" vs "remaining" under the same source).

**Contract impact.** None (client-only). Reuses `POST /api/route`.

**Acceptance criteria**
- Setting origin then starting navigation keeps the map centered on the simulator's
  GPS position, with bearing matching heading.
- Panning away pauses follow; a recenter control resumes it.
- Simulated off-route (teleport > 80 m from polyline) triggers exactly one reroute
  and resumes guidance on the new route.
- New pure-function tests for off-route detection + a `useGeoPosition` unit test
  using a mocked `navigator.geolocation`.

---

### P0-2 — Request supersession & cancellation (G2)

**Goal.** The last user intent always wins; stale network responses can never
mutate UI state.

**Changes**

- `client/src/lib/api.ts`: accept an optional `AbortSignal` on `req`, `postRoute`,
  `getCameras`.
- `App.tsx`:
  - Maintain a monotonically increasing `routeSeqRef`; only apply a response when
    its seq is current.
  - Keep an `AbortController` for the in-flight route request; abort it when a new
    request starts or endpoints change.
  - Same pattern for the camera bbox fetch (currently debounced but not aborted).
- On abort, do not set error state (classify `AbortError` / `ApiError(0)` as benign).

**Contract impact.** None.

**Acceptance criteria**
- Firing Find twice in quick succession renders only the second result when the
  first response is delayed past the second.
- Changing origin while a request is in flight never leaves a route for the old origin.
- Unit test with a mocked fetch resolving out of order asserts final state.

---

### P0-3 — Direction-aware exposure (G3)

**Goal.** A camera only counts as an exposure when the route travels *through*
the camera's monitored direction (when that direction is known).

**Model**

OSRM step geometry already gives us heading. For each camera with a known
`direction` (degrees, OSM convention = camera/road bearing), compute the route's
heading where it passes nearest the camera, then treat it as an exposure only if
the heading is within ±`DIR_TOLERANCE_DEG` (default 60° modelled as forward, or
also accept the opposite bearing within tolerance if the camera is known to be
bidirectional). Cameras without `direction` remain omnidirectional (current behavior).

**Changes**

- `server/src/services/scoring.ts`: add
  `exposurePForPoints(coords, cameras, bufferM, opts?: { respectDirection?: boolean; toleranceDeg?: number })`
  and a `headingAtNearest(coords, camera)` helper. Keep the current signature
  backward-compatible by making the new arg optional.
- `server/src/avoid.ts`: mirror the direction check in `rankByExposure` (default
  respects direction when `camera.direction` is present; a flag disables it).
- `RouteRequest` (additive): `respectDirection?: boolean = true`.
- Surface the effect in `TurnSteps`/`RouteSheet` implicitly (counts change), and
  optionally note "directional filtering on" in route options.

**Contract impact.** Additive request field only; response shapes unchanged.

**Acceptance criteria**
- Synthetic polyline heading east past a camera at `direction: 270` counts **0**
  exposures with `respectDirection:true`, **1** with `false`.
- Existing tests in `tests/scoring.test.ts` / `exposure.test.ts` remain green
  (directionless cameras unchanged).
- New behavioral tests cover: heading within tolerance, opposite heading, missing
  direction, and the `false` opt-out.

---

### P0-4 — Single source of truth for contract types (G4)

**Goal.** Eliminate hand-copied API types on the client.

**Changes**

- Client components import from `shared/src/types.ts` (workspace already wired;
  `lib/api.ts` already imports it). Remove the local `Camera`/`RankedRoute`/
  `RouteExposure` duplicates in `App.tsx`, `MapView.tsx`, `CameraLayer.tsx`,
  `DirectionsCard.tsx`.
- Where a component genuinely needs a narrower prop type, derive it:
  `Pick<ScoredRoute, 'id' | 'coordinates'>` rather than redeclaring.
- Ensure `shared` is built before `client` typecheck (root `typecheck` already
  runs shared last — reorder to shared → server → client, orchestrator-owned).
- `MapView` should carry `isClean`, `exposureCount`, and camera-preview data from
  the real `ScoredRoute` rather than recomputing `isClean` in the UI.

**Contract impact.** None at runtime; compile-time only.

**Acceptance criteria**
- `npm run typecheck` passes with zero local contract duplicates.
- Removing a field from `shared/src/types.ts` produces a compile error in every
  consumer (verified by a throwaway rename).

---

### P1-1 — Camera trust, brand & source filtering (G5)

**Goal.** Let users and the router choose which cameras count, and make
crowd-sourced (unverified) nodes visible but not authoritative.

**Changes**

- `RouteRequest` (additive): `cameraFilter?: { verifiedOnly?: boolean; brands?: string[]; sources?: string[]; maxDistM?: number }`.
- `GET /api/cameras` (additive query): `verifiedOnly=1`, `brand=Flock Safety` (repeatable/comma list), `source=`.
  Response keeps `{ cameras }`; add `matchedByFilter` only if needed.
- `store.ts`: filter in `camerasInBboxPage` before decimation so `total`/`truncated`
  reflect the filtered set.
- UI (route options): "Verified only" toggle + brand chips (Flock Safety, other).
  Default: **all cameras count** (preserves today's behavior), with an obvious
  affordance to restrict.
- Mark unverified cameras distinctly in `CameraLayer` popups ("Unverified — user submitted").

**Contract impact.** Additive.

**Acceptance criteria**
- `verifiedOnly` routing excludes unverified nodes; `SystemStatus.cameraCount`
  optionally gains `{ total, verified }` (additive) for transparency.
- Filter + decimation combination tested in `us-cameras.test.ts`.

---

### P1-2 — Shareable route deep links (G6)

**Goal.** A route is a URL you can bookmark or send.

**Changes**

- Serialize `{ origin, destination, avoidFlock, bufferMeters, cameraFilter }` into
  the URL hash (e.g. `#r=lat,lon~lat,lon&avoid=1&buf=150`), updated after each
  successful route.
- On boot, hydrate state from the hash if valid (reuse the lat/lon validator from
  `geocode.ts`), then run the route request.
- Add a "Copy link" / native share button in `RouteSheet` or `DirectionsCard`.
- Labels are optional and lossy-safe: coordinates are the source of truth.

**Contract impact.** None.

**Acceptance criteria**
- Opening a shared link reproduces the same origin/destination/options and fetches
  the route without manual input.
- Invalid/partial hashes degrade gracefully to the empty state (no crash).
- Pure round-trip tests for encode/decode in `tests/directions.test.ts` or a new
  `deeplink.test.ts`.

---

### P1-3 — Persistence: recents, saved places, preferences (G7)

**Goal.** Stop asking users to retype everything.

**Changes**

- `localStorage` (private-mode safe, try/catch like existing usage):
  - `ghostroute.recent` — last ~10 origin/destination `{label, lat, lon}` pairs.
  - `ghostroute.saved` — user-starred places.
  - `ghostroute.prefs` — `{ avoidFlock, bufferMeters, cameraFilter, respectDirection }`.
- Show recents when a `PlaceField` is focused with empty text; a star icon to save
  the current place.
- Hydrate preferences on boot; persist on change (debounced).
- Reuse the existing `Place` shape from `geocode.ts`.

**Contract impact.** None.

**Acceptance criteria**
- Toggling avoid/buffer and reloading preserves the choice.
- Recent destinations appear in the field dropdown and selecting one re-runs routing.
- Storage failures (private mode) never throw.

---

### P1-4 — Travel profiles (G8)

**Goal.** Support driving (default), walking, and cycling.

**Changes**

- `RouteRequest` (additive): `profile?: 'driving' | 'walking' | 'cycling' = 'driving'`.
- `osrm.ts`: map profile → OSRM path segment
  (`/route/v1/driving|foot|bike`); FOSSGIS uses `/routed-car|routed-foot|routed-bike`.
  Backend presets in `security.ts` must encode the profile→path mapping.
- `fetchRoutes(origin, dest, via, profile)` — thread through `cleanroute.ts`
  `FetchRoutes` and `route.ts`.
- Camera avoidance and clean-route logic remain profile-agnostic (exposure is a
  property of the path).
- UI: a small segmented control (Drive / Walk / Bike) in route options.

**Contract impact.** Additive.

**Acceptance criteria**
- Each profile hits the correct OSRM path and returns routes; demo backend returns
  sensible durations for all three (where the public instance supports it; degrade
  to driving with a clear notice if a profile is unsupported).
- Routing cache key includes the profile.

---

### P1-5 — Camera write hardening & moderation (G9)

**Goal.** Crowd-sourced cameras become trustworthy and abuse-resistant.

**Changes**

- Require a shared write token for `POST /api/cameras` (env `CAMERA_WRITE_TOKEN`,
  header `x-camera-token`); reject with 401 when configured and missing. Keep the
  endpoint open only when the token is unset (dev default, documented).
- Add `POST /api/cameras/:id/report` (reason enum) and `DELETE /api/cameras/:id`
  (token-protected). User nodes start `verified:false` and are excluded from
  routing when `cameraFilter.verifiedOnly` is set.
- Rate-limit reports like writes.
- Additive response fields only; keep `{ camera }` for create.

**Contract impact.** New endpoints; existing shapes unchanged.

**Acceptance criteria**
- Configured token rejects anonymous writes; dev default still allows them.
- Reported cameras are recorded (in-memory counter + persisted flag) and reflected
  in a moderation listing; delete removes from store and routing.
- Tests cover 401/200 paths and report idempotency.

---

### P2-1 — JEV caching, batching & request budget (G10)

**Goal.** Cut critical-path latency and upstream cost.

**Changes**

- Cache JEV ranking/exposure results in `cache.ts` keyed by a route fingerprint
  (ordered candidate ids + exposure counts + rounded durations + mode), TTL ~60 s.
  Never cache across different keys/modes.
- Merge `rankRoutes` and `estimateExposure` into one orchestration that reuses a
  single abort/timeout budget per request (e.g. `JEV_BUDGET_MS`, default 10 s total).
- Add an overall `/api/route` time budget (`ROUTE_BUDGET_MS`): if the clean-route
  search would exceed it, return the best-so-far set with a `cleanSearch.aborted`
  flag (additive) instead of blocking.
- When no key is present, skip all JEV network work (already the case) and skip
  the exposure call entirely (fake path is deterministic).

**Contract impact.** Additive `cleanSearch.aborted`.

**Acceptance criteria**
- Identical repeated route requests within TTL make zero JEV calls (asserted via a
  fetch spy).
- A forced-slow clean search returns within the budget with partial results and the
  `aborted` flag.
- No behavioral change to results under the threshold gate.

---

### P2-2 — Pluggable store + rate-limit backend (G11)

**Goal.** Make multi-instance deploys honest.

**Changes**

- Introduce a `Store` interface (`allCameras`, `camerasInBboxPage`, `addCamera`,
  `deleteCamera`, `reportCamera`) with the current in-memory/JSON implementation as
  the default and document a SQLite implementation path (no new keyed service).
- Either make the rate limiter injectable (memory default) or explicitly document
  the single-instance constraint in `README`/`STACK.md`.
- `POST /api/cameras` currently `writeFileSync`s the whole array — move to
  append-only or SQLite to avoid lost updates under concurrency.

**Contract impact.** None.

**Acceptance criteria**
- Store interface has two passing implementations behind the same tests.
- Concurrent `addCamera` calls in a test do not lose writes (append/SQLite impl).

---

### P2-3 — Edge-case consistency sweep (G12)

Small but user-visible:

- Emit `cleanSearch` (or an explicit `cleanSearch:null` with a reason) consistently,
  including when `avoidFlock=false`, so the UI never shows a stale banner.
- Align the client buffer slider range with the server (50–5000) or clamp/document
  the narrower UI range intentionally.
- Trust server `isClean` instead of recomputing from `exposureCount`.
- Render a degraded-mode banner when `GET /api/health` reports `fake` mode or
  `/api/system/status` reports the demo routing backend (helps self-hosters).

**Acceptance criteria.** Tests for banner presence/absence per flag combination;
no client-side recomputation of server-derived flags.

---

### P3 — Later (explicitly deferred)

- Structured logging + metrics (request latency, OSRM/JEV error rates, clean-search
  hit rate) behind a tiny internal module.
- PWA/offline shell; voice guidance for maneuvers.
- SSE/WebSocket live camera updates (only if a streaming source appears).
- Traffic-aware durations — **non-goal** while the no-keyed-provider rule stands;
  document as a future paid-tier-only option.

---

## 5. Cross-cutting requirements

- **Tests:** every P0/P1 change ships behavioral tests under `tests/*.test.ts`
  (project convention: behavior over source-regex). Target ≥ 160 passing.
- **Types:** re-run `npm run typecheck` and `npm test` after each workstream.
- **Docs:** update `PROJECT_BRIEF.md` §API contract (additive v1.2 section) and
  `docs/SYSTEM_DESIGN.md` for each new endpoint/field. `README` quickstart unchanged;
  add a "Route options" subsection.
- **Ownership:** the contract changes (P0-3, P1-1, P1-4, P1-5, P2-1) touch
  `shared/types.ts` + `server/routes/*` (api agent), `avoid.ts`/`scoring.ts`
  (debug/backend), and `security.ts` (security). Sequence via the orchestrator;
  no cross-owned edits.
- **Backward compatibility:** all request additions optional with today's defaults;
  all response additions optional fields. Old clients keep working unchanged.

## 6. Sequencing recommendation

```
Wave 1 (correctness):  P0-2 (cancellation) → P0-4 (types) → P0-3 (direction) → P0-1 (nav follow)
Wave 2 (parity):       P1-3 (persistence) → P1-1 (filters) → P1-4 (profiles) → P1-2 (deep links)
Wave 3 (trust/scale):  P1-5 (moderation) → P2-1 (JEV cache/budget) → P2-2 (store) → P2-3 (edge sweep)
```

Wave 1 is strictly client + scoring and carries the highest user-visible payoff.
Wave 2 needs one coordinated contract bump (additive v1.2). Wave 3 is mostly
server-side and can proceed in parallel after the v1.2 shape freezes.

## 7. Non-goals

- Any keyed/paid provider (Mapbox, Google, HERE, TomTom, ORS, Stadia-keyed) — see STACK.md §5.
- Native mobile apps.
- Redesigning the visual language or migrating the map stack.
- Replacing OSRM/JEV — this spec improves orchestration around them, not their choice.
- Storing precise user origin/destination server-side (privacy posture stays: nothing
  persisted per user server-side; all personal state lives in the browser).
