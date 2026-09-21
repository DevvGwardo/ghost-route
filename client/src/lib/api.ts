// Typed fetch client for the Ghost Route v1 API contract. No React imports.
import type {
  BBox,
  ByokOpts,
  Camera,
  CamerasResponse,
  CreateCameraResponse,
  HealthResponse,
  JevExposure,
  RouteRequest,
  RouteResponse,
  RouteStep,
  ScoredRoute,
  SystemStatusResponse,
  VerifyKeyResponse,
} from '../../../shared/src/types';

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API error ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** BYOK key plus cancellation. `signal` aborts an in-flight request. */
export interface ReqOpts extends ByokOpts {
  signal?: AbortSignal;
}

function baseUrl(): string {
  const envBase =
    typeof import.meta !== 'undefined' &&
    (import.meta as any).env?.VITE_API_URL;
  if (typeof envBase === 'string' && envBase.length > 0) return envBase;
  return '';
}

/**
 * True when `err` is an aborted request rather than a real failure. Aborts are
 * deliberately re-thrown untouched by `req` (not folded into ApiError(0)), so
 * callers can tell "superseded by newer intent" apart from "network is down"
 * and avoid clobbering the newer request's UI state.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function req<T>(path: string, init?: RequestInit, opts?: ReqOpts): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.typesafeKey) headers['x-typesafe-key'] = opts.typesafeKey;
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      ...(opts?.signal ? { signal: opts.signal } : {}),
      headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
    });
  } catch (err) {
    // Preserve abort identity; everything else becomes a network-shaped error.
    if (isAbortError(err)) throw err;
    throw new ApiError(0, null, err instanceof Error ? err.message : 'network-error');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `API error ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

export function getHealth(opts?: ReqOpts): Promise<HealthResponse> {
  return req<HealthResponse>('/api/health', undefined, opts);
}

export function getSystemStatus(opts?: ReqOpts): Promise<SystemStatusResponse> {
  return req<SystemStatusResponse>('/api/system/status', undefined, opts);
}

export function verifySystemKey(typesafeKey: string): Promise<VerifyKeyResponse> {
  return req<VerifyKeyResponse>('/api/system/verify', undefined, { typesafeKey });
}

export function getCameras(bbox: BBox, limit = 500, opts?: ReqOpts): Promise<CamerasResponse> {
  const q = `bbox=${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}&limit=${limit}`;
  return req<CamerasResponse>(`/api/cameras?${q}`, undefined, opts);
}

export function postRoute(routeReq: RouteRequest, opts?: ReqOpts): Promise<RouteResponse> {
  return req<RouteResponse>(
    '/api/route',
    {
      method: 'POST',
      body: JSON.stringify(routeReq),
    },
    opts,
  );
}

export function postCamera(input: {
  lat: number;
  lon: number;
  address?: string;
}): Promise<CreateCameraResponse> {
  return req<CreateCameraResponse>('/api/cameras', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type {
  BBox,
  ByokOpts,
  Camera,
  JevExposure,
  RouteRequest,
  RouteResponse,
  RouteStep,
  ScoredRoute,
  VerifyKeyResponse,
};
