/* Profile web-ifc across all models — no type inclusion/exclusion filters. */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as WebIFC from 'web-ifc';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(__dirname, '..', '..', 'models');

const typeIdToName = new Map<number, string>();
for (const [key, value] of Object.entries(WebIFC)) {
  if (typeof value === 'number' && key.startsWith('IFC') && key === key.toUpperCase()) {
    typeIdToName.set(value, key);
  }
}

const api = new WebIFC.IfcAPI();
await api.Init();
api.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_OFF);

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

interface Result {
  file: string;
  sizeMb: number;
  tOpen: number;
  tGeom: number | null;
  products: number;
}

const results: Result[] = [];

for (const { name, path, size } of ifcFiles) {
  const sizeMb = size / (1024 * 1024);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${name} (${sizeMb.toFixed(1)} MB)`);
  console.log('='.repeat(60));

  const t0 = performance.now();
  const buffer = await readFile(path);
  const modelID = api.OpenModel(new Uint8Array(buffer));
  const tOpen = (performance.now() - t0) / 1000;
  console.log(`  open: ${tOpen.toFixed(3)}s`);

  let tGeom: number | null = null;
  let products = 0;
  const byType = new Map<string, number>();
  try {
    const tg0 = performance.now();
    api.StreamAllMeshes(modelID, (mesh) => {
      products++;
      const typeId = api.GetLineType(modelID, mesh.expressID);
      const typeName = typeIdToName.get(typeId) ?? `Unknown(${typeId})`;
      byType.set(typeName, (byType.get(typeName) ?? 0) + 1);
    });
    tGeom = (performance.now() - tg0) / 1000;

    console.log(`  geometry (${products} products): ${tGeom.toFixed(3)}s`);
    for (const [t, c] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${t}: ${c}`);
    }
  } catch (e) {
    console.log(`  geometry: FAILED (${e})`);
  }

  api.CloseModel(modelID);
  results.push({ file: name, sizeMb, tOpen, tGeom, products });
}

const w = Math.max(...results.map((r) => r.file.length)) + 2;
const total = w + 35;
console.log(`\n\n${'='.repeat(total)}`);
console.log(
  `${'FILE'.padEnd(w)} ${'SIZE'.padStart(7)} ${'OPEN'.padStart(7)} ${'GEOM'.padStart(7)} ${'PRODS'.padStart(6)}`,
);
console.log('-'.repeat(total));
for (const r of results) {
  const geom = r.tGeom !== null ? `${r.tGeom.toFixed(2)}s` : 'FAIL';
  console.log(
    `${r.file.padEnd(w)} ${(r.sizeMb.toFixed(1) + 'M').padStart(7)} ${(r.tOpen.toFixed(2) + 's').padStart(7)} ${geom.padStart(7)} ${String(r.products).padStart(6)}`,
  );
}
console.log('='.repeat(total));
