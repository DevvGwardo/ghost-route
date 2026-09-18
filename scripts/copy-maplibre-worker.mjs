// postinstall: vendor maplibre's GL worker into client/public/ (gitignored).
// Vite dev cannot resolve maplibre's default worker URL, so MapView.tsx points
// at /gr-map-worker.mjs via setWorkerUrl. Re-runs on every npm install.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "client", "package.json"));
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const pub = join(root, "client", "public");
mkdirSync(pub, { recursive: true });

for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  const src = join(dist, f);
  if (!existsSync(src)) throw new Error(`missing ${src} — is maplibre-gl installed?`);
  const destName = f.replace("maplibre-gl-", "gr-map-");
  let text = readFileSync(src, "utf8");
  if (destName === "gr-map-worker.mjs") {
    text = text.replaceAll("./maplibre-gl-shared.mjs", "./gr-map-shared.mjs");
  }
  writeFileSync(join(pub, destName), text);
  console.log(`vendored ${destName}`);
}
