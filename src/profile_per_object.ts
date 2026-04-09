/* Per-object geometry timing for ifc-lite. Writes JSON output.
 *
 * NOTE: ifc-lite's parseMeshes() does all geometry in one WASM call.
 * We can only time the .get(i) calls (WASM→JS deserialization), not
 * individual element meshing. The "init" time here is the parseMeshes()
 * call itself, which is where all the actual work happens.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  StepTokenizer,
  ColumnarParser,
  type IfcDataStore,
} from '@ifc-lite/parser';
import initWasm, { IfcAPI } from '@ifc-lite/wasm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(__dirname, '..', 'models');
const OUT_DIR = resolve(__dirname, '..');

const EXCLUDE_TYPES = new Set(['IfcOpeningElement', 'IfcOpeningStandardCase', 'IfcSpace', 'IfcBuilding', 'IfcBuildingStorey']);

// ── Init WASM once ──────────────────────────────────────────────────
const wasmPkgDir = dirname(fileURLToPath(import.meta.resolve('@ifc-lite/wasm')));
const wasmBytes = await readFile(join(wasmPkgDir, 'ifc-lite_bg.wasm'));
await initWasm({ module_or_path: wasmBytes });

// ── Discover models ─────────────────────────────────────────────────
const ifcFiles: { name: string; path: string; size: number }[] = [];
const target = process.argv[2];
if (target) {
  const p = resolve(target.includes('/') ? target : join(MODELS_DIR, target));
  const s = await stat(p);
  ifcFiles.push({ name: p.split('/').pop()!, path: p, size: s.size });
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
  tParse: number;
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

  // Parse
  const t0 = performance.now();
  const buffer = await readFile(path);
  const tokenizer = new StepTokenizer(buffer);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntities()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  const store: IfcDataStore = await parser.parseLite(buffer.buffer, entityRefs);
  const tParse = (performance.now() - t0) / 1000;
  console.log(`  parse: ${tParse.toFixed(3)}s`);

  // Geometry — parseMeshes does everything in one call
  let tInit = 0;
  const timings: Timing[] = [];

  const origLog = console.log;
  const origWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};

    const content = new TextDecoder().decode(buffer);

    const tg0 = performance.now();
    const api = new IfcAPI();
    const meshCollection = api.parseMeshes(content);
    tInit = (performance.now() - tg0) / 1000;

    console.log = origLog;
    console.warn = origWarn;
    console.log(`  parseMeshes(): ${tInit.toFixed(3)}s (${meshCollection.length} meshes)`);

    // Time each .get(i) — this is WASM→JS deserialization only
    const seen = new Set<number>();
    for (let i = 0; i < meshCollection.length; i++) {
      const t0i = performance.now();
      const mesh = meshCollection.get(i)!;
      const elapsed = (performance.now() - t0i) / 1000;
      if (seen.has(mesh.expressId)) continue;
      seen.add(mesh.expressId);
      const ifcType = mesh.ifcType || 'Unknown';
      if (EXCLUDE_TYPES.has(ifcType)) continue;
      timings.push({ time: elapsed, expressId: mesh.expressId, type: ifcType });
    }

    const tIter = timings.reduce((s, t) => s + t.time, 0);
    console.log(`  ${timings.length} products processed`);

    console.log(`\n  Top 10 slowest (deserialization only):`);
    console.log(`  ${'TIME'.padStart(8)}  ${'ID'.padStart(8)}  ${'TYPE'.padEnd(30)}`);
    console.log(`  ${'-'.repeat(50)}`);
    const sorted = [...timings].sort((a, b) => b.time - a.time);
    for (const t of sorted.slice(0, 10)) {
      console.log(`  ${(t.time * 1000).toFixed(3).padStart(7)}ms #${String(t.expressId).padEnd(7)}  ${t.type}`);
    }

    console.log(`\n  parseMeshes: ${tInit.toFixed(3)}s  get() total: ${tIter.toFixed(3)}s`);

    allResults.push({ file: name, sizeMb, tParse, tInit, tIter, products: timings.length, timings });
  } catch (e) {
    console.log = origLog;
    console.warn = origWarn;
    console.log(`  geometry: FAILED (${e})`);
  }
}

// ── Write JSON ──────────────────────────────────────────────────────
const outPath = join(OUT_DIR, 'timings_ifclite.json');
await writeFile(outPath, JSON.stringify(allResults, null, 2));
console.log(`\nTimings written to ${outPath}`);
