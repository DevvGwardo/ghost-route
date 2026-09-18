// Shared fixtures + tiny HTTP helpers for ghost-route behavioral tests.
// Shape assumptions (per PROJECT_BRIEF.md contract):
//   coords: { lat:number, lon:number } | [lat,lon] pairs in polylines
//   camera: { id, lat, lon, source?, verified? }
//   route:  { id, coordinates:[[lat,lon],...], distanceM?, durationS?, exposureCount?, score? }

export const AUSTIN = { lat: 30.2672, lon: -97.7431 };
export const DALLAS = { lat: 32.7767, lon: -96.797 };

// Straight-line polyline from a to b as [[lat,lon],...] with n points.
export function straightCoords(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  n = 11,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    pts.push([a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t]);
  }
  return pts;
}

export function makeCamera(id: string, lat: number, lon: number) {
  return { id, lat, lon, source: 'test', verified: true };
}

export function makeRoute(
  id: string,
  a: { lat: number; lon: number } = AUSTIN,
  b: { lat: number; lon: number } = { lat: 30.35, lon: -97.7 },
  n = 11,
) {
  return {
    id,
    coordinates: straightCoords(a, b, n),
    distanceM: 10_000,
    durationS: 900,
    exposureCount: 0,
    score: 0,
  };
}

export async function startServer(
  app: any,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server: any = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const addr = server.address() as { port: number } | null;
  if (!addr || typeof addr.port !== 'number') throw new Error('startServer: no port bound');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

export async function fetchJson(base: string, path: string, init?: RequestInit) {
  const res = await fetch(base + path, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { res, body };
}
