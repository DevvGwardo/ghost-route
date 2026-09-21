import { Router } from 'express';
import {
  camerasInBboxPage,
  addCamera,
  cameraById,
  deleteCamera,
  reportCamera,
  REPORT_REASONS,
  type CameraQueryFilter,
  type ReportReason,
} from '../store.js';
import { cameraWriteLimiter, requireCameraWriteToken } from '../security.js';

const router = Router();

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 500;

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** `?brand=A&brand=B` and `?brand=A,B` both work; values are trimmed. */
function listParam(v: unknown): string[] | undefined {
  const raw = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(',')) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out.length > 0 ? out : undefined;
}

// GET /?bbox=minLon,minLat,maxLon,maxLat&limit=500
//     &verifiedOnly=1&brand=Flock%20Safety&source=user        (additive v1.2)
// (mounted at /api/cameras by index.ts)
router.get('/', (req, res) => {
  const rawBbox = req.query.bbox;
  if (typeof rawBbox !== 'string' || rawBbox.trim() === '') {
    res.status(400).json({ error: 'bbox-required' });
    return;
  }
  const parts = rawBbox.split(',').map((s) => Number(s.trim()));
  if (
    parts.length !== 4 ||
    !parts.every((n) => isFiniteNum(n))
  ) {
    res.status(400).json({ error: 'bbox-invalid' });
    return;
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (
    minLon < -180 || maxLon > 180 ||
    minLat < -90 || maxLat > 90 ||
    minLon > maxLon || minLat > maxLat
  ) {
    res.status(400).json({ error: 'bbox-invalid' });
    return;
  }

  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    const parsed = Number(req.query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ error: 'limit-invalid' });
      return;
    }
    // Deterministic cap: clamp oversized limits to MAX_LIMIT (5000),
    // never 400 — US-wide queries stay servable.
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const verifiedOnly = req.query.verifiedOnly;
  if (
    verifiedOnly !== undefined &&
    verifiedOnly !== '1' &&
    verifiedOnly !== '0' &&
    verifiedOnly !== 'true' &&
    verifiedOnly !== 'false'
  ) {
    res.status(400).json({ error: 'verifiedOnly-invalid' });
    return;
  }
  const brands = listParam(req.query.brand);
  const sources = listParam(req.query.source);

  const filter: CameraQueryFilter = {
    ...(verifiedOnly === '1' || verifiedOnly === 'true' ? { verifiedOnly: true } : {}),
    ...(brands ? { brands } : {}),
    ...(sources ? { sources } : {}),
  };

  // Additive v1.1: `truncated`/`total` document decimation; `cameras` shape
  // unchanged. v1.2: filters apply BEFORE decimation, so `total` describes
  // the filtered set rather than the whole bbox.
  try {
    const { cameras, total, truncated } = camerasInBboxPage(
      minLon,
      minLat,
      maxLon,
      maxLat,
      limit,
      filter,
    );
    res.json({ cameras, truncated, total });
  } catch {
    res.status(400).json({ error: 'bbox-invalid' });
  }
});

// POST / { lat, lon, address? }
// Requires `x-camera-token` when CAMERA_WRITE_TOKEN is configured.
router.post('/', cameraWriteLimiter, requireCameraWriteToken, (req, res) => {
  const { lat, lon, address } = req.body ?? {};
  if (
    !isFiniteNum(lat) || lat < -90 || lat > 90 ||
    !isFiniteNum(lon) || lon < -180 || lon > 180
  ) {
    res.status(400).json({ error: 'coordinates-invalid' });
    return;
  }
  if (address !== undefined && (typeof address !== 'string' || address.length === 0 || address.length > 500)) {
    res.status(400).json({ error: 'address-invalid' });
    return;
  }
  const camera = addCamera(lat, lon, address);
  res.json({ camera });
});

// POST /:id/report { reason } → moderation signal for a bad node.
// Idempotent per call: each report increments the reason counter.
router.post('/:id/report', cameraWriteLimiter, requireCameraWriteToken, (req, res) => {
  const reason = req.body?.reason;
  if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason as ReportReason)) {
    res.status(400).json({
      error: 'reason-invalid',
      allowed: [...REPORT_REASONS],
    });
    return;
  }
  const camera = cameraById(req.params.id);
  if (!camera) {
    res.status(404).json({ error: 'camera-not-found' });
    return;
  }
  let result;
  try {
    result = reportCamera(req.params.id, reason as ReportReason);
  } catch {
    res.status(400).json({ error: 'camera-id-invalid' });
    return;
  }
  if (!result) {
    res.status(404).json({ error: 'camera-not-found' });
    return;
  }
  res.json({ camera, reports: result.reports, reasons: result.reasons });
});

// DELETE /:id → remove a node from the store and from all future routing.
router.delete('/:id', cameraWriteLimiter, requireCameraWriteToken, (req, res) => {
  let deleted;
  try {
    deleted = deleteCamera(req.params.id);
  } catch {
    res.status(400).json({ error: 'camera-id-invalid' });
    return;
  }
  if (!deleted) {
    res.status(404).json({ error: 'camera-not-found' });
    return;
  }
  res.json({ deleted });
});

export default router;
