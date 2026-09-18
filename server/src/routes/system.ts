import { Router } from 'express';
import { camerasInBbox } from '../store.js';
import { jevMode, confidenceThreshold } from '../jev.js';

const router = Router();

const OSRM_BASE = 'https://router.project-osrm.org' as const;

function apiKeyFromHeader(headerVal: string | string[] | undefined): string | undefined {
  const v = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  return v?.trim() || undefined;
}

// Shared with index.ts GET /api/health (orchestrator wires it — see patch note
// in report). Per-request key; never log it.
export function healthPayload(apiKeyHeader?: string) {
  return {
    ok: true as const,
    jev: {
      mode: jevMode(apiKeyFromHeader(apiKeyHeader)),
      threshold: confidenceThreshold(),
    },
  };
}

// GET /status → { mode, threshold, cameraCount, osrm }
router.get('/status', (req, res) => {
  const mode = jevMode(apiKeyFromHeader(req.header('x-typesafe-key')));
  const threshold = confidenceThreshold();
  // camerasInBbox is the store's only read path; world bbox gives the total.
  const cameraCount = camerasInBbox(-180, -90, 180, 90, 100000).length;
  res.json({
    mode,
    threshold: Number.isFinite(threshold) ? threshold : 0.4,
    cameraCount,
    osrm: OSRM_BASE,
  });
});

export default router;
