import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Camera {
  id: string;
  lat: number;
  lon: number;
  source: string;
  address?: string;
  verified: boolean;
}

const DATA_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../data/flock-cameras.json",
);
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function assertLatLon(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`invalid lat: ${lat} (want -90..90)`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`invalid lon: ${lon} (want -180..180)`);
  }
}

function load(): Camera[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Camera =>
        typeof r?.id === "string" &&
        Number.isFinite(r?.lat) &&
        Number.isFinite(r?.lon) &&
        typeof r?.verified === "boolean",
    );
  } catch {
    return [];
  }
}

// Loaded once at module init; addCamera() keeps memory + JSON in sync.
const cameras: Camera[] = load();

function persist(): void {
  writeFileSync(DATA_FILE, JSON.stringify(cameras, null, 2) + "\n");
}

function nextId(): string {
  let max = 0;
  for (const c of cameras) {
    const m = /^cam-(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let id = `cam-${String(max + 1).padStart(3, "0")}`;
  while (cameras.some((c) => c.id === id)) id += "-x";
  return id;
}

export function allCameras(): Camera[] {
  return [...cameras];
}

export function cameraById(id: string): Camera | undefined {
  if (typeof id !== "string" || id.length === 0) throw new RangeError("invalid id");
  return cameras.find((c) => c.id === id);
}

export function camerasInBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  limit = DEFAULT_LIMIT,
): Camera[] {
  for (const n of [minLon, minLat, maxLon, maxLat]) {
    if (!Number.isFinite(n)) throw new RangeError("bbox bounds must be finite numbers");
  }
  assertLatLon(minLat, minLon);
  assertLatLon(maxLat, maxLon);
  if (minLon > maxLon || minLat > maxLat) {
    throw new RangeError("bbox min must be <= max");
  }
  if (!Number.isInteger(limit)) throw new RangeError("limit must be an integer");
  const n = Math.min(Math.max(limit, 1), MAX_LIMIT);
  return cameras
    .filter((c) => c.lon >= minLon && c.lon <= maxLon && c.lat >= minLat && c.lat <= maxLat)
    .slice(0, n);
}

export function addCamera(lat: number, lon: number, address?: string): Camera {
  assertLatLon(lat, lon);
  if (address !== undefined && (typeof address !== "string" || address.length === 0 || address.length > 500)) {
    throw new RangeError("address must be a non-empty string (max 500 chars) when provided");
  }
  // Dedupe: same user spam within ~10m returns the existing node.
  for (const c of cameras) {
    const dLat = (c.lat - lat) * 111320;
    const dLon = (c.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
    if (Math.hypot(dLat, dLon) < 10) return c;
  }
  const camera: Camera = {
    id: nextId(),
    lat,
    lon,
    source: "user",
    ...(address !== undefined ? { address } : {}),
    verified: false,
  };
  cameras.push(camera);
  persist();
  return camera;
}
