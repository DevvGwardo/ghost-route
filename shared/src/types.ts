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

export interface JevVerdict {
  choice: string;
  confidence: number;
  fallbackUsed: boolean;
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
}

export interface RouteResponse {
  routes: ScoredRoute[];
  rankedBy: 'jev' | 'heuristic';
  jevMode: 'jev' | 'fake';
}

// Envelope types for the remaining endpoints.
export interface HealthResponse {
  ok: true;
  jev: { mode: 'jev' | 'fake'; threshold: number };
}

export interface CamerasResponse {
  cameras: Camera[];
}

export interface CreateCameraResponse {
  camera: Camera;
}

export interface SystemStatusResponse {
  mode: 'jev' | 'fake';
  threshold: number;
  cameraCount: number;
  osrm: 'https://router.project-osrm.org';
}

// BYOK: per-request user TypeSafe key, sent as `x-typesafe-key` header.
// Never log the key.
export interface ByokOpts {
  typesafeKey?: string;
}
