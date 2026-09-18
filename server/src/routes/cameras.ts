import { Router } from 'express';
import { camerasInBboxPage, addCamera } from '../store.js';
import { cameraWriteLimiter } from '../security.js';

const router = Router();

const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 500;

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

// GET /?bbox=minLon,minLat,maxLon,maxLat&limit=500
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

  // Additive v1.1: `truncated`/`total` document decimation; `cameras` shape unchanged.
  try {
    const { cameras, total, truncated } = camerasInBboxPage(minLon, minLat, maxLon, maxLat, limit);
    res.json({ cameras, truncated, total });
  } catch {
    res.status(400).json({ error: 'bbox-invalid' });
  }
});

// POST / { lat, lon, address? }
router.post('/', cameraWriteLimiter, (req, res) => {
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

export default router;
