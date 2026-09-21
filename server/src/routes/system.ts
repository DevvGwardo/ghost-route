import { Router } from 'express';
import { cameraCounts } from '../store.js';
import { jevMode, confidenceThreshold, verifyKey } from '../jev.js';
import { plausibilityStats } from './route.js';
import { resolveRoutingBackend } from '../security.js';

const router = Router();

// Active routing backend (dynamic — follows ROUTING_BACKEND env).
function routingOrigin(): string {
  try {
    return resolveRoutingBackend().origin;
  } catch {
    return 'https://router.project-osrm.org';
  }
}

function routingBackendName(): string {
  try {
    return resolveRoutingBackend().name;
  } catch {
    return 'demo';
  }
}

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

// GET /status → { mode, threshold, cameraCount, cameraCounts?, routingBackend?,
//                 osrm, plausibility? }
// `cameraCounts` and `routingBackend` are additive v1.2; `cameraCount` keeps
// its original meaning (all cameras) for existing clients.
router.get('/status', (req, res) => {
  const mode = jevMode(apiKeyFromHeader(req.header('x-typesafe-key')));
  const threshold = confidenceThreshold();
  const counts = cameraCounts();
  res.json({
    mode,
    threshold: Number.isFinite(threshold) ? threshold : 0.4,
    cameraCount: counts.total,
    cameraCounts: counts,
    routingBackend: routingBackendName(),
    osrm: routingOrigin(),
    plausibility: plausibilityStats(),
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
