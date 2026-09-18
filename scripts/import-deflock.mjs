#!/usr/bin/env node
// Import Flock/ALPR camera locations into server/data/flock-cameras.json.
// Source: OpenStreetMap via Overpass API (same upstream deflock.me renders:
// nodes tagged surveillance:type=ALPR). Re-runnable: merges by rounded
// coords so reruns + manually added cameras survive.
//
// Only node builtins (fs/path/url + global fetch). No npm deps.
//
// Usage:
//   node scripts/import-deflock.mjs [--help] [--synthetic]
//     [--bbox minLon,minLat,maxLon,maxLat] [--limit N]
//     [--url <overpass-endpoint>] [--out <path>]
//
// Defaults target Austin metro, cap 2000 records.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_BBOX = [-98.0, 30.0, -97.4, 30.6]; // minLon,minLat,maxLon,maxLat (Austin metro)
const DEFAULT_OUT = "server/data/flock-cameras.json";
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];
const DEFAULT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 70000;

function usage() {
  console.log(`import-deflock.mjs — fetch ALPR cameras (deflock.me upstream: OSM via Overpass) and write ${DEFAULT_OUT}

Options:
  --bbox minLon,minLat,maxLon,maxLat   area to query (default: Austin metro ${DEFAULT_BBOX.join(",")})
  --limit N                           cap fetched records (default: ${DEFAULT_LIMIT})
  --url <endpoint>                    Overpass interpreter URL (default: first reachable of ${MIRRORS.length} mirrors)
  --out <path>                        output JSON, repo-relative (default: ${DEFAULT_OUT})
  --synthetic                         skip network; write deterministic Austin TX corridor seed (~64 cams)
  --help                              print this help

Record shape: { id, lat, lon, source, address?, verified }
  fetch → source 'deflock', id 'deflock-<osm-node-id>', verified=true only when
          OSM tags tag manufacturer=Flock Safety.
  --synthetic → source 'synthetic', id 'cam-NNN', verified=false.

De-dupe + merge key: lat/lon rounded to 5 decimals. Reruns never duplicate.`);
}

function parseArgs(argv) {
  const opts = {
    bbox: DEFAULT_BBOX,
    limit: DEFAULT_LIMIT,
    url: undefined, // undefined → try MIRRORS in order
    out: DEFAULT_OUT,
    synthetic: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      usage();
      process.exit(0);
    } else if (a === "--synthetic") opts.synthetic = true;
    else if (a === "--bbox") {
      const parts = (argv[++i] ?? "").split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error("--bbox must be minLon,minLat,maxLon,maxLat (numbers)");
      }
      opts.bbox = parts;
    } else if (a === "--limit") {
      opts.limit = Number(argv[++i]);
      if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer");
    } else if (a === "--url") opts.url = argv[++i] ?? "";
    else if (a === "--out") opts.out = argv[++i] ?? "";
    else throw new Error(`unknown arg: ${a}`);
  }
  if (opts.url !== undefined && !opts.url) throw new Error("--url must not be empty");
  if (!opts.out) throw new Error("--out must not be empty");
  return opts;
}

// Deterministic PRNG (mulberry32) so --synthetic output is stable across runs.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ~64 plausible cameras along major Austin TX corridors.
function syntheticSeed() {
  const rand = rng(20260917);
  const spots = [];
  const line = (n, lat0, lon0, lat1, lon1, label, jitter = 0.004) => {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      spots.push({
        lat: lat0 + (lat1 - lat0) * t + (rand() - 0.5) * 2 * jitter,
        lon: lon0 + (lon1 - lon0) * t + (rand() - 0.5) * 2 * jitter,
        address: label,
      });
    }
  };
  line(16, 30.18, -97.741, 30.42, -97.726, "I-35 frontage Rd"); // I-35
  line(12, 30.24, -97.768, 30.42, -97.762, "MoPac Expy"); // MoPac / Loop 1
  line(6, 30.19, -97.79, 30.185, -97.68, "E Ben White Blvd"); // SH-71 / Ben White
  line(8, 30.29, -97.78, 30.38, -97.70, "US-183"); // US-183 diagonal
  for (let i = 0; i < 12; i++) {
    // downtown grid around Congress / 6th
    spots.push({
      lat: 30.26 + rand() * 0.02,
      lon: -97.755 + rand() * 0.025,
      address: ["Congress Ave", "E 6th St", "Guadalupe St", "Lavaca St"][i % 4],
    });
  }
  const landmarks = [
    [30.2849, -97.7341, "UT Austin, Guadalupe St"],
    [30.2672, -97.7431, "Congress Ave Bridge"],
    [30.1945, -97.6699, "AUS Airport, SH-71"],
    [30.3072, -97.756, "W 45th St"],
    [30.3322, -97.7729, "Loop 360 / W Braker Ln"],
    [30.2297, -97.7693, "S Lamar Blvd"],
    [30.25, -97.715, "E Riverside Dr"],
    [30.3189, -97.7035, "Cameron Rd"],
    [30.4, -97.725, "I-35, Round Rock approach"],
    [30.158, -97.746, "Slaughter Ln"],
  ];
  for (const [lat, lon, address] of landmarks) {
    spots.push({ lat: lat + (rand() - 0.5) * 0.002, lon: lon + (rand() - 0.5) * 0.002, address });
  }
  return spots.map((s, i) => ({
    id: `cam-${String(i + 1).padStart(3, "0")}`,
    lat: Number(s.lat.toFixed(6)),
    lon: Number(s.lon.toFixed(6)),
    source: "synthetic",
    ...(s.address ? { address: s.address } : {}),
    verified: false,
  }));
}

function addressFromTags(tags = {}) {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  if (street) return street;
  return tags.operator ?? undefined;
}

function normalizeOverpass(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  return elements
    .filter((e) => Number.isFinite(e?.lat) && Number.isFinite(e?.lon))
    .map((e) => {
      const tags = e.tags ?? {};
      const rec = {
        id: `deflock-${e.id}`,
        lat: Number(e.lat.toFixed(6)),
        lon: Number(e.lon.toFixed(6)),
        source: "deflock",
        verified: tags.manufacturer === "Flock Safety",
      };
      const address = addressFromTags(tags);
      if (address) rec.address = String(address);
      return rec;
    });
}

async function fetchQuad(url, quad) {
  const [minLon, minLat, maxLon, maxLat] = quad;
  // Overpass bbox order: south,west,north,east.
  const query = `[out:json][timeout:60];node["surveillance:type"="ALPR"](${minLat},${minLon},${maxLat},${maxLon});out;`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Overpass ${res.status} ${res.statusText}`);
  return normalizeOverpass(await res.json());
}

// Full bboxes 504 on some mirrors; 2x2 quadrants stay under the limit.
// De-dupe by OSM node id (quadrants share edges).
function splitQuads(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const midLon = (minLon + maxLon) / 2;
  const midLat = (minLat + maxLat) / 2;
  return [
    [minLon, minLat, midLon, midLat],
    [midLon, minLat, maxLon, midLat],
    [minLon, midLat, midLon, maxLat],
    [midLon, midLat, maxLon, maxLat],
  ];
}

async function fetchOverpass(urls, bbox, limit) {
  const attempts = [];
  let lastErr;
  for (const url of urls) {
    try {
      const seen = new Map();
      const quads = splitQuads(bbox);
      for (let i = 0; i < quads.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 3000)); // be polite: avoid 429s
        for (const rec of await fetchQuad(url, quads[i])) seen.set(rec.id, rec);
      }
      const rows = [...seen.values()].slice(0, limit);
      return { rows, mirror: url, attempts };
    } catch (err) {
      lastErr = err;
      attempts.push(`${url} → ${err.message}`);
    }
  }
  throw new Error(`all Overpass mirrors failed: ${attempts.join("; ")}; last: ${lastErr?.message}`);
}

const keyOf = (r) => `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;

function mergeRecords(existing, incoming) {
  const seen = new Set(existing.map(keyOf));
  const merged = [...existing];
  for (const rec of incoming) {
    if (seen.has(keyOf(rec))) continue;
    seen.add(keyOf(rec));
    merged.push(rec);
  }
  return merged;
}

function readExisting(outPath) {
  try {
    const raw = readFileSync(outPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outPath = resolve(ROOT, opts.out);
  if (opts.synthetic) {
    const existing = readExisting(outPath);
    const incoming = syntheticSeed();
    const merged = mergeRecords(existing, incoming);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
    console.log(
      `synthetic: ${incoming.length} records, ${merged.length - existing.length} new, total ${merged.length} → ${opts.out}`,
    );
    return;
  }
  const urls = opts.url === undefined ? MIRRORS : [opts.url];
  const { rows, mirror, attempts } = await fetchOverpass(urls, opts.bbox, opts.limit);
  for (const a of attempts) console.log(`mirror failed: ${a}`);
  // ≥10 real nodes → replace file with real rows only (drop synthetic seed).
  // Below that the network is likely down/sparse: keep synthetics, report honestly.
  if (rows.length < 10) {
    const existing = readExisting(outPath);
    console.log(
      `overpass via ${mirror}: only ${rows.length} real ALPR nodes (<10) — keeping existing ${existing.length} rows, wrote nothing.`,
    );
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(rows, null, 2) + "\n");
  const verified = rows.filter((r) => r.verified).length;
  console.log(
    `overpass via ${mirror}: ${rows.length} real ALPR nodes (${verified} verified Flock Safety), replaced ${opts.out}`,
  );
}

await main().catch((err) => {
  console.error(`import-deflock: ${err.message}`);
  process.exit(1);
});
