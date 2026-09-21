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
//     [--bbox minLon,minLat,maxLon,maxLat] [--metro <name>] [--us] [--list-metros]
//     [--snapshot] [--limit N] [--delay-ms N]
//     [--url <overpass-endpoint>] [--out <path>]
//
// Defaults target Austin metro, cap 2000 records.
// --snapshot pulls the hourly US snapshot (140k+ nodes) instead of Overpass.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_BBOX = [-98.0, 30.0, -97.4, 30.6]; // minLon,minLat,maxLon,maxLat (Austin metro)
const DEFAULT_OUT = "server/data/flock-cameras.json";
// Hourly OSM-ALPR snapshot (US), same upstream as this script's Overpass
// queries but fetched server-side — the reliable refresh path when Overpass
// mirrors 429/504. Published by flockhopper3/deflock-data (ODbL).
const SNAPSHOT_URL = "https://data.dontgetflocked.com/cameras.geojson.gz";
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter",
];
const DEFAULT_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 70000;
const DEFAULT_DELAY_MS = 3000; // politeness pause between Overpass calls

// Major-metro bbox presets (minLon,minLat,maxLon,maxLat, ~0.6deg windows).
// Austin entry matches DEFAULT_BBOX so default behavior is unchanged.
const METROS = {
  austin: [-98.0, 30.0, -97.4, 30.6],
  houston: [-95.8, 29.5, -95.0, 30.1],
  dallas: [-97.1, 32.5, -96.5, 33.1],
  "san-antonio": [-98.8, 29.2, -98.2, 29.7],
  phoenix: [-112.4, 33.2, -111.8, 33.8],
  "los-angeles": [-118.7, 33.7, -117.9, 34.3],
  chicago: [-88.0, 41.6, -87.4, 42.2],
  "new-york": [-74.3, 40.4, -73.6, 40.95],
  atlanta: [-84.7, 33.5, -84.1, 34.0],
  miami: [-80.5, 25.6, -79.9, 26.1],
  seattle: [-122.6, 47.3, -122.0, 47.8],
  denver: [-105.3, 39.5, -104.7, 40.0],
  "san-francisco": [-122.7, 37.5, -122.1, 37.95],
  "washington-dc": [-77.4, 38.7, -76.8, 39.1],
  boston: [-71.4, 42.1, -70.8, 42.55],
};

function usage() {
  console.log(`import-deflock.mjs — fetch ALPR cameras (deflock.me upstream: OSM via Overpass) and write ${DEFAULT_OUT}

Options:
  --bbox minLon,minLat,maxLon,maxLat   area to query (default: Austin metro ${DEFAULT_BBOX.join(",")})
  --metro <name>                      preset area (${Object.keys(METROS).join(", ")})
  --us                                tile all metro presets (UNION; --bbox/--metro ignored)
  --snapshot                          pull hourly US snapshot (${SNAPSHOT_URL}) instead of Overpass
  --list-metros                       print preset names + bboxes and exit
  --limit N                           cap fetched records PER metro (default: ${DEFAULT_LIMIT})
  --delay-ms N                        politeness pause between Overpass calls (default: ${DEFAULT_DELAY_MS})
  --url <endpoint>                    Overpass interpreter URL (default: first reachable of ${MIRRORS.length} mirrors)
  --out <path>                        output JSON, repo-relative (default: ${DEFAULT_OUT})
  --synthetic                         skip network; write deterministic Austin TX corridor seed (~64 cams)
                                      (+ --us: one seed per metro preset; + --metro: seed shifted to that metro)
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
    bboxSet: false,
    metro: undefined,
    us: false,
    snapshot: false,
    limit: DEFAULT_LIMIT,
    delayMs: DEFAULT_DELAY_MS,
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
    else if (a === "--us") opts.us = true;
    else if (a === "--snapshot") opts.snapshot = true;
    else if (a === "--list-metros") {
      for (const [name, bbox] of Object.entries(METROS)) console.log(`${name} ${bbox.join(",")}`);
      process.exit(0);
    } else if (a === "--metro") {
      opts.metro = (argv[++i] ?? "").toLowerCase();
      if (!METROS[opts.metro]) throw new Error(`--metro must be one of: ${Object.keys(METROS).join(", ")}`);
    } else if (a === "--bbox") {
      const parts = (argv[++i] ?? "").split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error("--bbox must be minLon,minLat,maxLon,maxLat (numbers)");
      }
      opts.bbox = parts;
      opts.bboxSet = true;
    } else if (a === "--delay-ms") {
      opts.delayMs = Number(argv[++i]);
      if (!Number.isInteger(opts.delayMs) || opts.delayMs < 0) throw new Error("--delay-ms must be a non-negative integer");
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
// dLat/dLon shift the whole seed to another metro center; idPrefix keeps ids unique.
function syntheticSeed(dLat = 0, dLon = 0, idPrefix = "cam", seed = 20260917) {
  const rand = rng(seed);
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
    id: `${idPrefix}-${String(i + 1).padStart(3, "0")}`,
    lat: Number((s.lat + dLat).toFixed(6)),
    lon: Number((s.lon + dLon).toFixed(6)),
    source: "synthetic",
    ...(s.address ? { address: s.address } : {}),
    verified: false,
  }));
}

const AUSTIN_CENTER = [30.27, -97.74]; // lat, lon — anchor syntheticSeed() was authored against

function bboxCenter(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
}

// One ~64-cam corridor seed per metro, shifted to that metro's center.
// Deterministic per metro (seed = base + index) so reruns are stable.
// Addresses are generic per-metro labels (NOT Austin street names) so the
// synthetic fallback never misleads: source=synthetic, verified=false.
function syntheticSeedUS() {
  const names = Object.keys(METROS);
  return names.flatMap((name, mi) => {
    const [cLat, cLon] = bboxCenter(METROS[name]);
    const prefix = `us-${name.replace(/[^a-z0-9]+/g, "")}`;
    return syntheticSeed(cLat - AUSTIN_CENTER[0], cLon - AUSTIN_CENTER[1], prefix, 20260917 + mi).map(
      (rec, i) => ({ ...rec, address: `${name} metro corridor ${i + 1}` }),
    );
  });
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
      // OSM tags bearing as a string ("270") or cardinal ("N"); only the
      // numeric form is unambiguous, cardinals are skipped as unknown.
      if (typeof tags.direction === "string" && tags.direction.trim() !== "") {
        const dir = Number(tags.direction);
        if (Number.isFinite(dir)) rec.direction = ((dir % 360) + 360) % 360;
      }
      return rec;
    });
}

function normalizeSnapshot(json) {
  const feats = Array.isArray(json?.features) ? json.features : [];
  const seen = new Set();
  const out = [];
  for (const f of feats) {
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c)) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const p = f?.properties ?? {};
    if (p.osmId === undefined || p.osmId === null) continue;
    const id = `deflock-${p.osmId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const brand = typeof p.brand === "string" && p.brand ? p.brand : undefined;
    const rec = {
      id,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      source: "deflock",
      verified: brand === "Flock Safety",
    };
    if (brand) rec.brand = brand;
    // Bearing union: scalar `direction` plus any extra heads in `directions`.
    // A scalar of 0 (due north) is a real bearing — dropping it used to turn
    // ~9k cameras omnidirectional, flagging them on routes they cannot see.
    const bearings = [];
    const seenBearing = new Set();
    const addBearing = (v) => {
      if (typeof v !== "number" || !Number.isFinite(v)) return;
      const b = ((v % 360) + 360) % 360;
      if (!seenBearing.has(b)) {
        seenBearing.add(b);
        bearings.push(b);
      }
    };
    addBearing(p.direction);
    if (Array.isArray(p.directions)) for (const d of p.directions) addBearing(d);
    if (bearings.length === 1) {
      rec.direction = bearings[0];
    } else if (bearings.length > 1) {
      if (typeof p.direction === "number" && Number.isFinite(p.direction))
        rec.direction = p.direction;
      rec.directions = bearings;
    }
    out.push(rec);
  }
  return out;
}

async function fetchSnapshot(url = SNAPSHOT_URL) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "ghost-route/0.1 (OSM ALPR import; local dev)",
      Accept: "application/geo+json, application/json",
      Referer: "https://github.com/DevvGwardo/ghost-route",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`snapshot ${res.status} ${res.statusText}`);
  return normalizeSnapshot(await res.json());
}
async function fetchQuad(url, quad) {
  const [minLon, minLat, maxLon, maxLat] = quad;
  // Overpass bbox order: south,west,north,east.
  const query = `[out:json][timeout:60];node["surveillance:type"="ALPR"](${minLat},${minLon},${maxLat},${maxLon});out;`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ghost-route/0.1 (OSM ALPR import; local dev)",
      Accept: "application/json",
      Referer: "https://github.com/DevvGwardo/ghost-route",
    },
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

async function fetchOverpass(urls, bbox, limit, delayMs = DEFAULT_DELAY_MS) {
  const attempts = [];
  let lastErr;
  for (const url of urls) {
    try {
      const seen = new Map();
      const quads = splitQuads(bbox);
      for (let i = 0; i < quads.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, delayMs)); // be polite: avoid 429s
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

// --us: fetch each metro preset in turn (politeness delay between metros),
// merge/dedupe on rounded coord key (same keyOf as single-bbox path).
// --limit applies PER metro. Returns { rows, attempts }.
async function fetchOverpassUS(urls, limit, delayMs) {
  const merged = [];
  const seenKeys = new Set();
  const attempts = [];
  const names = Object.keys(METROS);
  for (let m = 0; m < names.length; m++) {
    const name = names[m];
    if (m > 0) await new Promise((r) => setTimeout(r, delayMs));
    try {
      const { rows, mirror, attempts: att } = await fetchOverpass(urls, METROS[name], limit, delayMs);
      attempts.push(...att.map((a) => `${name}: ${a}`));
      let added = 0;
      for (const rec of rows) {
        const k = keyOf(rec);
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        merged.push(rec);
        added++;
      }
      console.log(`metro ${name}: ${rows.length} nodes via ${mirror} (${added} new after dedupe)`);
    } catch (err) {
      attempts.push(`${name}: ${err.message}`);
      console.log(`metro ${name} failed: ${err.message}`);
    }
  }
  return { rows: merged, attempts };
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
  const activeBbox = opts.us
    ? null
    : opts.bboxSet
      ? opts.bbox // explicit --bbox always wins
      : opts.metro
        ? METROS[opts.metro]
        : opts.bbox; // Austin default, unchanged
  if (opts.synthetic) {
    const existing = readExisting(outPath);
    let incoming;
    let tag;
    if (opts.us) {
      incoming = syntheticSeedUS();
      tag = `synthetic --us (${Object.keys(METROS).length} metros)`;
    } else if (opts.metro) {
      const [cLat, cLon] = bboxCenter(METROS[opts.metro]);
      incoming = syntheticSeed(cLat - AUSTIN_CENTER[0], cLon - AUSTIN_CENTER[1], `syn-${opts.metro.replace(/[^a-z0-9]+/g, "")}`, 20260917).map(
        (rec, i) => ({ ...rec, address: `${opts.metro} metro corridor ${i + 1}` }),
      );
      tag = `synthetic --metro ${opts.metro}`;
    } else {
      incoming = syntheticSeed();
      tag = "synthetic";
    }
    const merged = mergeRecords(existing, incoming);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
    console.log(
      `${tag}: ${incoming.length} records, ${merged.length - existing.length} new, total ${merged.length} → ${opts.out}`,
    );
    return;
  }
  const urls = opts.url === undefined ? MIRRORS : [opts.url];
  if (opts.snapshot) {
    const rows = await fetchSnapshot(opts.url);
    if (rows.length < 10) {
      const existing = readExisting(outPath);
      console.log(
        `snapshot: only ${rows.length} nodes (<10) — keeping existing ${existing.length} rows, wrote nothing.`,
      );
      return;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(rows) + "\n");
    const verified = rows.filter((r) => r.verified).length;
    console.log(
      `snapshot: ${rows.length} real ALPR nodes (${verified} verified Flock Safety), replaced ${opts.out}`,
    );
    return;
  }
  if (opts.us) {
    const { rows, attempts } = await fetchOverpassUS(urls, opts.limit, opts.delayMs);
    for (const a of attempts) console.log(`mirror failed: ${a}`);
    if (rows.length < 10) {
      const existing = readExisting(outPath);
      console.log(
        `overpass --us: only ${rows.length} real ALPR nodes (<10) — keeping existing ${existing.length} rows, wrote nothing.`,
      );
      return;
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(rows, null, 2) + "\n");
    const verified = rows.filter((r) => r.verified).length;
    console.log(
      `overpass --us (${Object.keys(METROS).length} metros): ${rows.length} real ALPR nodes (${verified} verified Flock Safety), replaced ${opts.out}`,
    );
    return;
  }
  const { rows, mirror, attempts } = await fetchOverpass(urls, activeBbox, opts.limit, opts.delayMs);
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
