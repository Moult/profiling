/* Per-object geometry timing for web-ifc. Writes JSON output. */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as WebIFC from 'web-ifc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(__dirname, '..', '..', 'models');
const OUT_DIR = resolve(__dirname, '..', '..');

const EXCLUDE_TYPE_IDS = new Set([
  WebIFC.IFCOPENINGELEMENT, WebIFC.IFCSPACE, WebIFC.IFCBUILDING, WebIFC.IFCBUILDINGSTOREY,
]);

const typeIdToName = new Map<number, string>();
for (const [key, value] of Object.entries(WebIFC)) {
  if (typeof value === 'number' && key.startsWith('IFC') && key === key.toUpperCase()) {
    typeIdToName.set(value, key);
  }
}

const api = new WebIFC.IfcAPI();
await api.Init();
api.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_OFF);

// ── Discover models ─────────────────────────────────────────────────
const ifcFiles: { name: string; path: string; size: number }[] = [];
const target = process.argv[2];
if (target) {
  const p = resolve(target.includes('/') ? target : join(MODELS_DIR, target));
  const s = await stat(p);
  ifcFiles.push({ name: basename(p), path: p, size: s.size });
} else {
  const allFiles = await readdir(MODELS_DIR);
  for (const name of allFiles) {
    if (!/\.ifc$/i.test(name)) continue;
    const path = join(MODELS_DIR, name);
    const s = await stat(path);
    ifcFiles.push({ name, path, size: s.size });
  }
  ifcFiles.sort((a, b) => a.size - b.size);
}

// ── Process each model ──────────────────────────────────────────────
interface Timing {
  time: number;
  expressId: number;
  type: string;
}

interface ModelResult {
  file: string;
  sizeMb: number;
  tOpen: number;
  tInit: number;
  tIter: number;
  products: number;
  timings: Timing[];
}

const allResults: ModelResult[] = [];

for (const { name, path, size } of ifcFiles) {
  const sizeMb = size / (1024 * 1024);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${name} (${sizeMb.toFixed(1)} MB)`);
  console.log('='.repeat(60));

  // Open model
  const t0 = performance.now();
  const buffer = await readFile(path);
  const modelID = api.OpenModel(new Uint8Array(buffer));
  const tOpen = (performance.now() - t0) / 1000;
  console.log(`  open: ${tOpen.toFixed(3)}s`);

  // Stream geometry, timing each callback
  const timings: Timing[] = [];
  let tInit = 0;
  let lastTime = performance.now();
  let first = true;

  try {
    const tg0 = performance.now();
    api.StreamAllMeshes(modelID, (mesh) => {
      const now = performance.now();
      if (first) {
        tInit = (now - tg0) / 1000;
        first = false;
        lastTime = now;
      }
      const elapsed = (now - lastTime) / 1000;
      const typeId = api.GetLineType(modelID, mesh.expressID);
      const typeName = typeIdToName.get(typeId) ?? `Unknown(${typeId})`;
      if (!EXCLUDE_TYPE_IDS.has(typeId)) {
        timings.push({ time: elapsed, expressId: mesh.expressID, type: typeName });
      }
      lastTime = performance.now();
    });

    const tIter = timings.reduce((s, t) => s + t.time, 0);
    console.log(`  ${timings.length} products processed`);

    console.log(`\n  Top 10 slowest:`);
    console.log(`  ${'TIME'.padStart(8)}  ${'ID'.padStart(8)}  ${'TYPE'.padEnd(30)}`);
    console.log(`  ${'-'.repeat(50)}`);
    const sorted = [...timings].sort((a, b) => b.time - a.time);
    for (const t of sorted.slice(0, 10)) {
      console.log(`  ${t.time.toFixed(3).padStart(7)}s  #${String(t.expressId).padEnd(7)}  ${t.type}`);
    }

    console.log(`\n  Init: ${tInit.toFixed(3)}s  Iter: ${tIter.toFixed(3)}s  Total: ${(tInit + tIter).toFixed(3)}s`);

    allResults.push({ file: name, sizeMb, tOpen, tInit, tIter, products: timings.length, timings });
  } catch (e) {
    console.log(`  geometry: FAILED (${e})`);
  }

  api.CloseModel(modelID);
}

// ── Write JSON ──────────────────────────────────────────────────────
const outPath = join(OUT_DIR, 'timings_webifc.json');
await writeFile(outPath, JSON.stringify(allResults, null, 2));
console.log(`\nTimings written to ${outPath}`);
