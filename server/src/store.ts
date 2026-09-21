import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Query-time camera filter (additive v1.2). Applied BEFORE decimation so
 * `total`/`truncated` describe the filtered set the caller actually gets.
 * Absent/empty fields mean "no restriction" — never "match nothing".
 */
export interface CameraQueryFilter {
  verifiedOnly?: boolean;
  brands?: readonly string[];
  sources?: readonly string[];
}

export interface BboxPage {
  cameras: Camera[];
  total: number;
  truncated: boolean;
}

/** Reasons accepted by POST /api/cameras/:id/report. */
export const REPORT_REASONS = [
  "gone",
  "not-a-camera",
  "wrong-location",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportResult {
  reports: number;
  reasons: Record<string, number>;
}

/**
 * Storage contract for cameras (additive v1.2, spec P2-2). Two implementations
 * ship: an in-memory store (tests, ephemeral deploys) and the JSON-backed
 * default. Both satisfy the same behavioral test suite.
 */
export interface Store {
  allCameras(): Camera[];
  cameraCounts(): { total: number; verified: number };
  cameraById(id: string): Camera | undefined;
  camerasInBbox(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    limit?: number,
    filter?: CameraQueryFilter,
  ): Camera[];
  camerasInBboxPage(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    limit?: number,
    filter?: CameraQueryFilter,
  ): BboxPage;
  addCamera(lat: number, lon: number, address?: string): Camera;
  /** Removes from the live set. Returns the removed camera, or undefined. */
  deleteCamera(id: string): Camera | undefined;
  /** Records a moderation report. Returns cumulative counts, or undefined. */
  reportCamera(id: string, reason: ReportReason): ReportResult | undefined;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = join(HERE, "../data/flock-cameras.json");
// User writes go to an append-only journal, NEVER back into the shipped seed:
// rewriting the 18MB seed on every POST lost concurrent writes and risked
// corrupting the dataset. One JSON line per mutation survives crashes and
// concurrent appends, and the seed stays read-only.
const DEFAULT_USER_FILE = join(HERE, "../data/user-cameras.ndjson");

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

/**
 * Grid-cell size in degrees (~1.1 km lat). bbox queries collect candidates
 * from covered cells instead of scanning all ~141k cameras; the 3×3
 * neighborhood of a point covers any 10 m dedupe radius.
 */
const CELL_DEG = 0.01;

function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
}

function assertLatLon(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`invalid lat: ${lat} (want -90..90)`);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`invalid lon: ${lon} (want -180..180)`);
  }
}

function assertId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    throw new RangeError("invalid id");
  }
  return id;
}

function isCamera(r: unknown): r is Camera {
  const c = r as Partial<Camera> | null;
  return (
    typeof c?.id === "string" &&
    Number.isFinite(c?.lat) &&
    Number.isFinite(c?.lon) &&
    typeof c?.verified === "boolean"
  );
}

/** True when `c` satisfies every field the filter actually restricts. */
function matchesFilter(c: Camera, filter?: CameraQueryFilter): boolean {
  if (!filter) return true;
  if (filter.verifiedOnly === true && c.verified !== true) return false;
  const brands = filter.brands;
  if (brands && brands.length > 0) {
    if (typeof c.brand !== "string" || !brands.includes(c.brand)) return false;
  }
  const sources = filter.sources;
  if (sources && sources.length > 0) {
    if (typeof c.source !== "string" || !sources.includes(c.source)) return false;
  }
  return true;
}

function validateBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): void {
  for (const n of [minLon, minLat, maxLon, maxLat]) {
    if (!Number.isFinite(n)) throw new RangeError("bbox bounds must be finite numbers");
  }
  assertLatLon(minLat, minLon);
  assertLatLon(maxLat, maxLon);
  if (minLon > maxLon || minLat > maxLat) {
    throw new RangeError("bbox min must be <= max");
  }
}

/**
 * Shared bbox query: filter → sort by id (deterministic regardless of import
 * order) → grid-decimate so the page spans the whole bbox rather than
 * collapsing to one file-order cluster. `truncated` is true iff the filtered
 * match set did not fit.
 */
function queryBbox(
  cameras: Camera[],
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  limit: number,
  filter?: CameraQueryFilter,
): BboxPage {
  validateBbox(minLon, minLat, maxLon, maxLat);
  if (!Number.isInteger(limit)) throw new RangeError("limit must be an integer");
  const n = Math.min(Math.max(limit, 1), MAX_LIMIT);
  const matched = cameras
    .filter(
      (c) =>
        c.lon >= minLon &&
        c.lon <= maxLon &&
        c.lat >= minLat &&
        c.lat <= maxLat &&
        matchesFilter(c, filter),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (matched.length <= n) {
    return { cameras: matched, total: matched.length, truncated: false };
  }
  const stride = Math.ceil(matched.length / n);
  const page = matched.filter((_, i) => i % stride === 0).slice(0, n);
  return { cameras: page, total: matched.length, truncated: true };
}

/** Core mutation logic shared by every Store implementation. */
class CameraCollection {
  private cameras: Camera[];
  /** Grid buckets by cell key; each camera lives in exactly one cell. */
  private cells = new Map<string, Camera[]>();
  /** First camera per id (seed order), mirroring the old find-first scan. */
  private byIdIndex = new Map<string, Camera>();
  /** Highest `cam-NNN` number seen, so ids are never reused mid-run. */
  private maxCamNum = 0;
  /** Reports are moderation signal, not routing input — kept in memory. */
  private reports = new Map<string, Map<string, number>>();
  private readonly onPersist: (record: JournalRecord) => void;

  constructor(seed: Camera[], onPersist: (record: JournalRecord) => void) {
    this.cameras = seed;
    this.onPersist = onPersist;
    for (const c of seed) this.indexCamera(c);
  }

  private indexCamera(c: Camera): void {
    const key = cellKey(c.lat, c.lon);
    const cell = this.cells.get(key);
    if (cell) cell.push(c);
    else this.cells.set(key, [c]);
    if (!this.byIdIndex.has(c.id)) this.byIdIndex.set(c.id, c);
    const m = /^cam-(\d+)$/.exec(c.id);
    if (m) this.maxCamNum = Math.max(this.maxCamNum, Number(m[1]));
  }

  private deindexCamera(c: Camera): void {
    const key = cellKey(c.lat, c.lon);
    const cell = this.cells.get(key);
    if (cell) {
      const i = cell.indexOf(c);
      if (i >= 0) cell.splice(i, 1);
      if (cell.length === 0) this.cells.delete(key);
    }
    this.byIdIndex.delete(c.id);
  }

  /**
   * bbox candidates from the grid. A bbox spanning more cells than the
   * dataset has cameras can't win from the grid — fall back to the flat
   * array (whole-world and continent-wide queries stay bounded).
   */
  private candidatesInBbox(
    minLat: number,
    minLon: number,
    maxLat: number,
    maxLon: number,
  ): Camera[] {
    const lat0 = Math.floor(minLat / CELL_DEG);
    const lat1 = Math.floor(maxLat / CELL_DEG);
    const lon0 = Math.floor(minLon / CELL_DEG);
    const lon1 = Math.floor(maxLon / CELL_DEG);
    if ((lat1 - lat0 + 1) * (lon1 - lon0 + 1) > this.cameras.length) {
      return this.cameras;
    }
    const out: Camera[] = [];
    for (let la = lat0; la <= lat1; la++) {
      for (let lo = lon0; lo <= lon1; lo++) {
        const cell = this.cells.get(`${la}:${lo}`);
        if (cell) out.push(...cell);
      }
    }
    return out;
  }

  /** Cameras in the 3×3 cell neighborhood of a point (superset of 10 m). */
  private nearby(lat: number, lon: number): Camera[] {
    const lat0 = Math.floor(lat / CELL_DEG);
    const lon0 = Math.floor(lon / CELL_DEG);
    const out: Camera[] = [];
    for (let la = lat0 - 1; la <= lat0 + 1; la++) {
      for (let lo = lon0 - 1; lo <= lon0 + 1; lo++) {
        const cell = this.cells.get(`${la}:${lo}`);
        if (cell) out.push(...cell);
      }
    }
    return out;
  }

  all(): Camera[] {
    return [...this.cameras];
  }

  counts(): { total: number; verified: number } {
    let verified = 0;
    for (const c of this.cameras) if (c.verified === true) verified += 1;
    return { total: this.cameras.length, verified };
  }

  byId(id: string): Camera | undefined {
    return this.byIdIndex.get(assertId(id));
  }

  bboxPage(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    limit = DEFAULT_LIMIT,
    filter?: CameraQueryFilter,
  ): BboxPage {
    return queryBbox(
      this.candidatesInBbox(minLat, minLon, maxLat, maxLon),
      minLon,
      minLat,
      maxLon,
      maxLat,
      limit,
      filter,
    );
  }

  add(lat: number, lon: number, address?: string): Camera {
    assertLatLon(lat, lon);
    if (
      address !== undefined &&
      (typeof address !== "string" || address.length === 0 || address.length > 500)
    ) {
      throw new RangeError("address must be a non-empty string (max 500 chars) when provided");
    }
    // Dedupe: same user spam within ~10m returns the existing node. The 3×3
    // neighborhood fully covers a 10 m radius (cells are ~1.1 km).
    for (const c of this.nearby(lat, lon)) {
      const dLat = (c.lat - lat) * 111320;
      const dLon = (c.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
      if (Math.hypot(dLat, dLon) < 10) return c;
    }
    const camera: Camera = {
      id: this.nextId(),
      lat,
      lon,
      source: "user",
      ...(address !== undefined ? { address } : {}),
      verified: false,
    };
    this.cameras.push(camera);
    this.indexCamera(camera);
    this.onPersist({ op: "add", camera });
    return camera;
  }

  remove(id: string): Camera | undefined {
    const key = assertId(id);
    const i = this.cameras.findIndex((c) => c.id === key);
    if (i < 0) return undefined;
    const [removed] = this.cameras.splice(i, 1);
    this.deindexCamera(removed);
    this.onPersist({ op: "delete", id: key });
    return removed;
  }

  report(id: string, reason: ReportReason): ReportResult | undefined {
    const key = assertId(id);
    if (!this.cameras.some((c) => c.id === key)) return undefined;
    if (!REPORT_REASONS.includes(reason)) throw new RangeError("invalid reason");
    const byReason = this.reports.get(key) ?? new Map<string, number>();
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    this.reports.set(key, byReason);
    this.onPersist({ op: "report", id: key, reason });
    return this.reportCounts(key);
  }

  reportCounts(id: string): ReportResult {
    const byReason = this.reports.get(id) ?? new Map<string, number>();
    const reasons: Record<string, number> = {};
    let total = 0;
    for (const [r, n] of byReason) {
      reasons[r] = n;
      total += n;
    }
    return { reports: total, reasons };
  }

  /** Applies one journal line; used when replaying the append-only log. */
  applyJournal(record: JournalRecord): void {
    switch (record.op) {
      case "add": {
        if (!isCamera(record.camera)) return;
        const c = record.camera;
        if (this.cameras.some((x) => x.id === c.id)) return;
        this.cameras.push({
          id: c.id,
          lat: c.lat,
          lon: c.lon,
          source: typeof c.source === "string" ? c.source : "user",
          ...(typeof c.address === "string" ? { address: c.address } : {}),
          verified: c.verified === true,
          ...(typeof c.brand === "string" ? { brand: c.brand } : {}),
          ...(typeof c.direction === "number" ? { direction: c.direction } : {}),
        });
        this.indexCamera(this.cameras[this.cameras.length - 1]);
        return;
      }
      case "delete": {
        const i = this.cameras.findIndex((c) => c.id === record.id);
        if (i >= 0) {
          const [removed] = this.cameras.splice(i, 1);
          this.deindexCamera(removed);
        }
        return;
      }
      case "report": {
        if (!REPORT_REASONS.includes(record.reason)) return;
        const byReason = this.reports.get(record.id) ?? new Map<string, number>();
        byReason.set(record.reason, (byReason.get(record.reason) ?? 0) + 1);
        this.reports.set(record.id, byReason);
        return;
      }
    }
  }

  /** Next `cam-NNN` from the tracked max, so deleted ids are never reused. */
  private nextId(): string {
    const n = this.maxCamNum + 1;
    let id = `cam-${String(n).padStart(3, "0")}`;
    while (this.cameras.some((c) => c.id === id)) id += "-x";
    this.maxCamNum = n;
    return id;
  }
}

type JournalRecord =
  | { op: "add"; camera: Camera }
  | { op: "delete"; id: string }
  | { op: "report"; id: string; reason: ReportReason };

function readSeed(path: string): Camera[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCamera);
  } catch {
    return [];
  }
}

function readJournal(path: string): JournalRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: JournalRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as JournalRecord;
      if (rec && typeof rec === "object" && typeof rec.op === "string") out.push(rec);
    } catch {
      // A torn final line (crash mid-append) must not discard the rest.
    }
  }
  return out;
}

/** In-memory store: no filesystem at all. Tests and ephemeral deploys. */
export function createMemoryStore(seed: Camera[] = []): Store {
  return toStore(new CameraCollection(seed.filter(isCamera), () => {}));
}

/**
 * JSON-backed store: shipped seed (read-only) + append-only user journal.
 * A failed append is non-fatal — the camera still serves for this process,
 * which beats dropping the write on a read-only volume.
 */
export function createJsonStore(opts?: {
  dataFile?: string;
  userFile?: string;
}): Store {
  const dataFile = opts?.dataFile ?? process.env.CAMERA_DATA_FILE ?? DEFAULT_DATA_FILE;
  const userFile = opts?.userFile ?? process.env.CAMERA_USER_FILE ?? DEFAULT_USER_FILE;
  const collection = new CameraCollection(readSeed(dataFile), (record) => {
    try {
      mkdirSync(dirname(userFile), { recursive: true });
      appendFileSync(userFile, JSON.stringify(record) + "\n");
    } catch {
      /* read-only volume — mutation still applies in memory */
    }
  });
  for (const record of readJournal(userFile)) collection.applyJournal(record);
  return toStore(collection);
}

function toStore(collection: CameraCollection): Store {
  return {
    allCameras: () => collection.all(),
    cameraCounts: () => collection.counts(),
    cameraById: (id) => collection.byId(id),
    camerasInBbox: (minLon, minLat, maxLon, maxLat, limit, filter) =>
      collection.bboxPage(minLon, minLat, maxLon, maxLat, limit, filter).cameras,
    camerasInBboxPage: (minLon, minLat, maxLon, maxLat, limit, filter) =>
      collection.bboxPage(minLon, minLat, maxLon, maxLat, limit, filter),
    addCamera: (lat, lon, address) => collection.add(lat, lon, address),
    deleteCamera: (id) => collection.remove(id),
    reportCamera: (id, reason) => collection.report(id, reason),
  };
}

// Default singleton — routes import the named helpers below.
export const store: Store = createJsonStore();

export function allCameras(): Camera[] {
  return store.allCameras();
}

export function cameraCounts(): { total: number; verified: number } {
  return store.cameraCounts();
}

export function cameraById(id: string): Camera | undefined {
  return store.cameraById(id);
}

export function camerasInBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  limit = DEFAULT_LIMIT,
  filter?: CameraQueryFilter,
): Camera[] {
  return store.camerasInBbox(minLon, minLat, maxLon, maxLat, limit, filter);
}

export function camerasInBboxPage(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  limit = DEFAULT_LIMIT,
  filter?: CameraQueryFilter,
): BboxPage {
  return store.camerasInBboxPage(minLon, minLat, maxLon, maxLat, limit, filter);
}

export function addCamera(lat: number, lon: number, address?: string): Camera {
  return store.addCamera(lat, lon, address);
}

export function deleteCamera(id: string): Camera | undefined {
  return store.deleteCamera(id);
}

export function reportCamera(id: string, reason: ReportReason): ReportResult | undefined {
  return store.reportCamera(id, reason);
}
