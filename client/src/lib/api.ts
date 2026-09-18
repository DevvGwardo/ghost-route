// Typed fetch client for the Ghost Route v1 API contract. No React imports.
import type {
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

function baseUrl(): string {
  const envBase =
    typeof import.meta !== 'undefined' &&
    (import.meta as any).env?.VITE_API_URL;
  if (typeof envBase === 'string' && envBase.length > 0) return envBase;
  return '';
}

async function req<T>(path: string, init?: RequestInit, opts?: ByokOpts): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.typesafeKey) headers['x-typesafe-key'] = opts.typesafeKey;
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
    });
  } catch (err) {
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

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function getHealth(opts?: ByokOpts): Promise<HealthResponse> {
  return req<HealthResponse>('/api/health', undefined, opts);
}

export function getSystemStatus(opts?: ByokOpts): Promise<SystemStatusResponse> {
  return req<SystemStatusResponse>('/api/system/status', undefined, opts);
}

export function getCameras(bbox: Bbox, limit = 500): Promise<CamerasResponse> {
  const q = `bbox=${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}&limit=${limit}`;
  return req<CamerasResponse>(`/api/cameras?${q}`);
}

export function postRoute(routeReq: RouteRequest, opts?: ByokOpts): Promise<RouteResponse> {
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
  ByokOpts,
  Camera,
  JevExposure,
  RouteRequest,
  RouteResponse,
  RouteStep,
  ScoredRoute,
};
