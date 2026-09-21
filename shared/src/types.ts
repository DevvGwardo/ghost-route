// Shared API contract types (v1). DO NOT change shapes without orchestrator approval.
// Mirrors PROJECT_BRIEF.md § API contract.

export interface LatLon {
  lat: number;
  lon: number;
}

/** Axis-aligned geographic bounds (lon/lat order, west < east, south < north). */
export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface Camera {
  id: string;
  lat: number;
  lon: number;
  source: string;
  address?: string;
  verified: boolean;
  brand?: string;
  direction?: number;
}

/** Additive (v1.2): travel mode. Default 'driving'. */
export type TravelProfile = 'driving' | 'walking' | 'cycling';

/**
 * Additive (v1.2): which cameras count toward exposure. Absent = every
 * camera (pre-v1.2 behavior). Applied before scoring, so counts and the
 * clean-route search both see the same filtered set.
 */
export interface CameraFilter {
  /** Only cameras with `verified === true` count. */
  verifiedOnly?: boolean;
  /** Whitelist of exact `brand` values. Empty/absent = any brand. */
  brands?: string[];
  /** Whitelist of exact `source` values. Empty/absent = any source. */
  sources?: string[];
  /** Ignore cameras farther than this from the route, in meters. */
  maxDistM?: number;
}

export interface RouteRequest {
  origin: LatLon;
  destination: LatLon;
  avoidFlock?: boolean;
  bufferMeters?: number;
  /** Additive (v1.2): travel mode. Default 'driving'. */
  profile?: TravelProfile;
  /** Additive (v1.2): restrict which cameras count. Absent = all. */
  cameraFilter?: CameraFilter;
  /**
   * Additive (v1.2): when true (default), a camera with a known `direction`
   * only counts as an exposure if the route's travel heading where it passes
   * nearest matches that direction (within ~60°). Cameras without a known
   * direction always count. Set false for the legacy omnidirectional model.
   */
  respectDirection?: boolean;
}

export interface Exposure {
  cameraId: string;
  lat: number;
  lon: number;
  distM: number;
}

export interface JevTradeoff {
  savedExposures: number;
  extraSeconds: number;
  extraMeters: number;
}

export interface JevVerdict {
  choice: string;
  confidence: number;
  fallbackUsed: boolean;
  rationale?: string;
  tradeoff?: JevTradeoff;
}

export interface RouteStep {
  index: number;
  instruction: string;
  maneuver: string;
  distanceM: number;
  durationS: number;
  exposureP: number;
  cameraIds: string[];
  roadName?: string;
  maneuverKind?: 'left' | 'right' | 'straight' | 'roundabout' | 'depart' | 'arrive' | 'uturn' | 'merge' | 'exit' | 'other';
  /** Per-step geometry [lat, lon] for client-side navigation (additive). */
  coordinates?: [number, number][];
}

export interface JevExposure {
  p: number;
  confidence: number;
  fallbackUsed: boolean;
  source: string;
}

export interface ScoredRoute {
  id: string;
  /** Polyline as [lat, lon] pairs. */
  coordinates: [number, number][];
  distanceM: number;
  durationS: number;
  exposures: Exposure[];
  exposureCount: number;
  score: number;
  jev: JevVerdict;
  /** Combined per-step exposure probability, 0..1 (3-decimal). */
  exposureP: number;
  jevExposure: JevExposure;
  /** Turn-by-turn steps with per-step exposure (capped at 100). */
  steps: RouteStep[];
  /** True when the route has zero camera exposures (clean-route search). */
  isClean?: boolean;
}

export interface CleanSearch {
  cleanFound: boolean;
  rounds: number;
  osrmCalls: number;
  attempts?: number;
  detourRatio?: number;
  /** Additive (v1.2): search stopped at the ROUTE_BUDGET_MS deadline. */
  aborted?: boolean;
  /**
   * Additive (v1.2): why the search did not run. Always emitted so the UI
   * never has to guess between "no search" and "search found nothing".
   */
  skipped?: 'avoid-disabled';
}

export interface RouteResponse {
  routes: ScoredRoute[];
  rankedBy: 'jev' | 'heuristic';
  jevMode: 'jev' | 'fake';
  /** Clean-route search summary (present when the search ran). */
  cleanSearch?: CleanSearch;
  /** Additive (v1.2): the profile that actually produced these routes. */
  profile?: TravelProfile;
  /**
   * Additive (v1.2): true when a non-driving profile was requested but the
   * backend has no graph for it, so driving directions are being shown.
   */
  profileFallback?: boolean;
}

// Envelope types for the remaining endpoints.
export interface HealthResponse {
  ok: true;
  jev: { mode: 'jev' | 'fake'; threshold: number };
}

export interface CamerasResponse {
  cameras: Camera[];
  truncated?: boolean;
  total?: number;
}

export interface CreateCameraResponse {
  camera: Camera;
}

export interface SystemStatusResponse {
  mode: 'jev' | 'fake';
  threshold: number;
  cameraCount: number;
  /** Additive (v1.2): the verified/unverified split behind `cameraCount`. */
  cameraCounts?: { total: number; verified: number };
  /** Additive (v1.2): `demo` means the public OSRM instance (no SLA). */
  routingBackend?: string;
  osrm: string;
  plausibility?: { implausibleDropped: number; implausibleExhausted: number };
}

export interface ReportCameraResponse {
  camera: Camera;
  reports: number;
  reasons: Record<string, number>;
}

export interface DeleteCameraResponse {
  deleted: Camera;
}

export interface VerifyKeyResponse {
  mode: 'jev' | 'fake';
  valid: boolean;
  confidence?: number;
  /**
   * Additive (v1.2): `key-required` | `invalid-key` | `unauthorized` |
   * `invalid-request` | `rate-limited` | `upstream-error` | `timeout` |
   * `unreachable`. Distinct so the UI can name the real cause instead of
   * blaming the network — `timeout` means TypeSafe was reachable but slow.
   */
  error?: string;
  /** Additive (v1.2): upstream HTTP status when the failure was a response. */
  status?: number;
  /** Additive (v1.2): short key-scrubbed upstream detail. */
  detail?: string;
}

// BYOK: per-request user TypeSafe key, sent as `x-typesafe-key` header.
// Never log the key.
export interface ByokOpts {
  typesafeKey?: string;
}
