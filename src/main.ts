/* Profile ifc-lite across all models in models, sorted by file size. */

import { readFile, readdir, stat } from 'node:fs/promises';
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
interface Result {
  file: string;
  sizeMb: number;
  tParse: number;
  tQuery: number;
  tGeom: number | null;
  walls: number;
  slabs: number;
  products: number;
}

const results: Result[] = [];

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

  // Query walls & slabs
  const tq0 = performance.now();
  const wallTypes = ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE'];
  let walls = 0;
  for (const t of wallTypes) {
    walls += (store.entityIndex.byType.get(t) ?? []).length;
  }
  const slabTypes = ['IFCSLAB', 'IFCSLABELEMENTEDCASE'];
  let slabs = 0;
  for (const t of slabTypes) {
    slabs += (store.entityIndex.byType.get(t) ?? []).length;
  }
  const tQuery = (performance.now() - tq0) / 1000;
  console.log(`  IfcWall: ${walls}, IfcSlab: ${slabs} (query: ${tQuery.toFixed(3)}s)`);

  // Geometry (suppress [IFC-LITE] debug output during processing)
  let tGeom: number | null = null;
  let products = 0;
  const EXCLUDE_TYPES = new Set(['IfcOpeningElement', 'IfcOpeningStandardCase', 'IfcSpace', 'IfcBuilding', 'IfcBuildingStorey']);
  const origLog = console.log;
  const origWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};
    const tg0 = performance.now();
    const api = new IfcAPI();
    const content = new TextDecoder().decode(buffer);
    const meshCollection = api.parseMeshes(content);
    const byType = new Map<string, number>();
    const seen = new Set<number>();
    for (let i = 0; i < meshCollection.length; i++) {
      const mesh = meshCollection.get(i)!;
      if (seen.has(mesh.expressId)) continue;
      const t = mesh.ifcType || 'Unknown';
      if (EXCLUDE_TYPES.has(t)) continue;
      seen.add(mesh.expressId);
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    products = seen.size;
    tGeom = (performance.now() - tg0) / 1000;
    console.log = origLog;
    console.warn = origWarn;
    console.log(`  geometry (${products} products, ${meshCollection.length} meshes): ${tGeom.toFixed(3)}s`);
    for (const [t, c] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${t}: ${c}`);
    }
  } catch (e) {
    console.log = origLog;
    console.warn = origWarn;
    console.log(`  geometry: FAILED (${e})`);
  }

  results.push({ file: name, sizeMb, tParse, tQuery, tGeom, walls, slabs, products });
}

// ── Summary table ───────────────────────────────────────────────────
const w = Math.max(...results.map((r) => r.file.length)) + 2;
const total = w + 42;
console.log(`\n\n${'='.repeat(total)}`);
console.log(
  `${'FILE'.padEnd(w)} ${'SIZE'.padStart(7)} ${'PARSE'.padStart(7)} ${'QUERY'.padStart(7)} ${'GEOM'.padStart(7)} ${'PRODS'.padStart(6)}`,
);
console.log('-'.repeat(total));
for (const r of results) {
  const geom = r.tGeom !== null ? `${r.tGeom.toFixed(2)}s` : 'FAIL';
  console.log(
    `${r.file.padEnd(w)} ${(r.sizeMb.toFixed(1) + 'M').padStart(7)} ${(r.tParse.toFixed(2) + 's').padStart(7)} ${(r.tQuery.toFixed(3) + 's').padStart(7)} ${geom.padStart(7)} ${String(r.products).padStart(6)}`,
  );
}
console.log('='.repeat(total));
