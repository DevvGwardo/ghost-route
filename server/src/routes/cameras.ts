import { Router } from 'express';
import { camerasInBbox, addCamera } from '../store.js';
import { cameraWriteLimiter } from '../security.js';

const router = Router();

const MAX_LIMIT = 2000;
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
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const cameras = camerasInBbox(minLon, minLat, maxLon, maxLat, limit);
  res.json({ cameras });
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
  if (address !== undefined && (typeof address !== 'string' || address.length > 500)) {
    res.status(400).json({ error: 'address-invalid' });
    return;
  }
  const camera = addCamera(lat, lon, address);
  res.json({ camera });
});

export default router;
