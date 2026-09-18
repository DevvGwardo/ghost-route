// Shared API contract types (v1). DO NOT change shapes without orchestrator approval.
// Mirrors PROJECT_BRIEF.md § API contract.

export interface LatLon {
  lat: number;
  lon: number;
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

export interface RouteRequest {
  origin: LatLon;
  destination: LatLon;
  avoidFlock?: boolean;
  bufferMeters?: number;
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

export interface RouteResponse {
  routes: ScoredRoute[];
  rankedBy: 'jev' | 'heuristic';
  jevMode: 'jev' | 'fake';
  /** Clean-route search summary (present when the search ran). */
  cleanSearch?: { cleanFound: boolean; rounds: number; osrmCalls: number; attempts?: number; detourRatio?: number };
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
  osrm: string;
  plausibility?: { implausibleDropped: number; implausibleExhausted: number };
}

export interface VerifyKeyResponse {
  mode: 'jev' | 'fake';
  valid: boolean;
  confidence?: number;
  error?: string;
}

// BYOK: per-request user TypeSafe key, sent as `x-typesafe-key` header.
// Never log the key.
export interface ByokOpts {
  typesafeKey?: string;
}
