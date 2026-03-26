import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import initWasm, { IfcAPI } from '@ifc-lite/wasm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(__dirname, '..', '..', 'models');

const wasmPkgDir = dirname(fileURLToPath(import.meta.resolve('@ifc-lite/wasm')));
const wasmBytes = await readFile(join(wasmPkgDir, 'ifc-lite_bg.wasm'));
await initWasm({ module_or_path: wasmBytes });

const buffer = await readFile(join(MODELS_DIR, 'advanced_model.ifc'));

// Get all IfcWallStandardCase IDs from parser
const tokenizer = new StepTokenizer(buffer);
const entityRefs: any[] = [];
for (const ref of tokenizer.scanEntities()) {
  entityRefs.push({ expressId: ref.expressId, type: ref.type, byteOffset: ref.offset, byteLength: ref.length, lineNumber: ref.line });
}
const parser = new ColumnarParser();
const store = await parser.parseLite(buffer.buffer, entityRefs);

const wallIds = new Set<number>();
for (const t of ['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE']) {
  for (const id of (store.entityIndex.byType.get(t) ?? []) as number[]) {
    wallIds.add(id);
  }
}

// Get geometry and find which walls got meshes
const api = new IfcAPI();
const content = new TextDecoder().decode(buffer);
const meshCollection = api.parseMeshes(content);

const meshedWallIds = new Set<number>();
for (let i = 0; i < meshCollection.length; i++) {
  const mesh = meshCollection.get(i)!;
  if (wallIds.has(mesh.expressId)) {
    meshedWallIds.add(mesh.expressId);
  }
}

const missing = [...wallIds].filter(id => !meshedWallIds.has(id)).sort((a, b) => a - b);
console.log(`Walls in schema: ${wallIds.size}`);
console.log(`Walls with geometry: ${meshedWallIds.size}`);
console.log(`Missing geometry: ${missing.length}`);
console.log(`Missing IDs: ${JSON.stringify(missing)}`);
