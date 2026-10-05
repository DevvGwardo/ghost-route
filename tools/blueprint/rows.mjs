// Prints the report's generated tables (checks, perf, route matrix) as HTML
// rows from the latest blueprint-out/data/report-*.json, and splices them into
// the report between <!--ROWS:name--> … <!--/ROWS:name--> markers.
//   node tools/blueprint/rows.mjs docs/blueprint/ghost-route-blueprint.html
import fs from "node:fs";
import { BP } from "./lib.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const load = (n) => JSON.parse(fs.readFileSync(`${BP}/data/report-${n}.json`, "utf8"));
const reports = ["sweep", "routes", "navigation"].map(load);

const checks = reports
  .flatMap((r) => r.checks.map((c) => ({ ...c, script: r.script })))
  .map(
    (c) =>
      `<tr><td>${esc(c.area)}</td><td>${esc(c.name)}</td><td class="num">${esc(c.detail).slice(0, 140)}</td>` +
      `<td><span class="pill ${c.ok ? "ok" : "bad"}">${c.ok ? "pass" : "fail"}</span></td><td><code>${c.script}</code></td></tr>`,
  )
  .join("\n");

const frames = load("routes").frames
  .map(
    (f) =>
      `<tr><td><code>${f.name}</code></td><td class="num">${f.routeInView}%</td><td class="num">${f.endpointsVisible}</td>` +
      `<td class="num">${f.fill}%</td><td class="num">${f.chips - f.hiddenChips}/${f.chips}</td><td class="num">${f.chipClash}</td><td class="num">${f.lineDrawn}%</td>` +
      `<td class="num">${f.pitch}°</td><td class="num">${f.zoom}</td></tr>`,
  )
  .join("\n");

const summary = reports.map((r) => `${r.script} ${r.checks.filter((c) => c.ok).length}/${r.checks.length}`).join(" · ");
console.log(summary);

const file = process.argv[2];
if (file) {
  let html = fs.readFileSync(file, "utf8");
  for (const [name, rows] of [["checks", checks], ["frames", frames]]) {
    const re = new RegExp(`(<!--ROWS:${name}-->)[\\s\\S]*?(<!--/ROWS:${name}-->)`);
    if (!re.test(html)) throw new Error(`marker ${name} missing`);
    html = html.replace(re, `$1\n${rows}\n$2`);
  }
  fs.writeFileSync(file, html);
  console.log(`spliced ${checks.split("\n").length} checks, ${frames.split("\n").length} frames into ${file}`);
}
