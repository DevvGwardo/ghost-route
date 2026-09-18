import { Router } from 'express';
import { allCameras } from '../store.js';
import { jevMode, confidenceThreshold, verifyKey } from '../jev.js';

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
  const cameraCount = allCameras().length;
  res.json({
    mode,
    threshold: Number.isFinite(threshold) ? threshold : 0.4,
    cameraCount,
    osrm: OSRM_BASE,
  });
});

// GET /verify → { mode, valid, confidence?, error? }
// Checks a pasted BYOK key with a minimal live Jev call (5s timeout).
// Never echoes the key. 400 when no key provided.
router.get('/verify', async (req, res) => {
  const key = apiKeyFromHeader(req.header('x-typesafe-key'));
  if (!key) {
    res.status(400).json({ mode: 'fake' as const, valid: false, error: 'key-required' });
    return;
  }
  const out = await verifyKey(key);
  res.json({ mode: jevMode(key), ...out });
});

export default router;
