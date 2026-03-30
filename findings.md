# IFC Engine Profiling Findings

Benchmarked across 26 IFC models (2.3MB - 303MB), including public ara3d test models and private production files.

Exclusions applied equally: IfcOpeningElement, IfcSpace, IfcBuilding, IfcBuildingStorey.

## Parsing

ifc-lite and web-ifc are neck and neck, both ~10x faster than IfcOpenShell.

| | Small (2-5MB) | Medium (10-30MB) | Large (50-300MB) |
|---|---|---|---|
| IfcOpenShell | 0.10-0.21s | 0.54-1.90s | 3.16-20.10s |
| web-ifc | 0.01-0.03s | 0.06-0.21s | 0.37-2.37s |
| ifc-lite | 0.02-0.05s | 0.09-0.28s | 0.54-2.26s |

IfcOpenShell spends more time parsing than meshing on most files. Parsing is its biggest bottleneck.

## Geometry

ifc-lite is the fastest geometry engine when it works, but crashes on 4 of the largest models.

- **ifc-lite**: 2-5x faster than both others on most models. Crashes with WASM `unreachable` on 4 large models (169MB+). Small product count discrepancies on several models.
- **web-ifc**: 5-100x faster than single-core IfcOpenShell on most models. Handles all 26 models. One pathological case: private4 (303MB) takes 135s.
- **IfcOpenShell**: Slowest overall but processes everything correctly. Single-threaded, it's 5-40x slower than web-ifc on most models. Multiprocessing closes the gap significantly but can't fully overcome the heavier CGAL+OpenCASCADE kernel overhead.

## web-ifc: StreamAllMeshes vs StreamAllMeshesWithTypes

`StreamAllMeshesWithTypes` with a large inclusion list (all types minus a few exclusions) is **4-8x slower** than `StreamAllMeshes`. The inclusion list approach causes web-ifc to iterate per type ID rather than doing a single pass over all entities. For ~100 included type IDs this means ~100 separate passes with redundant internal setup. Filtering should be done in the `StreamAllMeshes` callback instead:

```ts
api.StreamAllMeshes(modelID, (mesh) => {
  const typeId = api.GetLineType(modelID, mesh.expressID);
  if (EXCLUDE_TYPE_IDS.has(typeId)) return;
  // ...
});
```

## Reliability

| | Models completed | Product count accuracy |
|---|---|---|
| IfcOpenShell | 26/26 | reference (correct) |
| web-ifc | 26/26 | near-exact (S_Office off by 10) |
| ifc-lite | 22/26 (4 FAIL) | small gaps on several models |

## Query

Negligible for all three engines (<0.02s even on the largest files).

## Known ifc-lite issues found

- Missing type support in `has_geometry_by_name()`: 31 IfcProduct subtypes were not in the geometry whitelist, including IfcSolarDevice, IfcAudioVisualAppliance, IfcCommunicationsAppliance, IfcDistributionChamberElement. Fixed in this profiling session.
- WASM geometry crashes on large/complex models (ISSUE_053, private1, private3, private4).
- 2 walls in advanced_model.ifc fail to mesh: #555613 (IfcBooleanClippingResult with IfcPolygonalBoundedHalfSpace) and #612315 (void subtraction edge case with full-height opening).

## Summary

ifc-lite has the fastest combined parse+geometry pipeline when it works, but is not production-ready for large/complex models. web-ifc is the best all-rounder: fast parsing, solid geometry, handles everything. IfcOpenShell is the slow-but-correct reference implementation — single-threaded it's an order of magnitude slower on geometry; multiprocessing closes the gap but parsing remains the main bottleneck.

## What "open/parse" actually does in each engine

### IfcOpenShell — `ifcopenshell.open()` — Full eager parse

Reads the entire file and builds a complete entity graph in memory. Every entity's attributes are parsed and stored. Builds 4 indexes: by ID (`byid_`), by type (`bytype_excl_`), by GlobalId (`byguid_`), and inverse references (`byref_excl_`).

- Parsing loop: `src/ifcparse/IfcParse.cpp:1542-1604`
- Entity construction: `src/ifcparse/IfcFile.cpp:655-760`

This is why it's 10x slower — it does the most work upfront.

### web-ifc — `api.OpenModel()` — Structural parse, lazy attributes

Streams the IFC data into WASM memory and parses the file structure (tokenizes entities, records offsets, validates the header/schema). But entity attributes are NOT materialized into JS objects — they stay in WASM memory until `GetLine()` is called.

- JS wrapper: `web-ifc-api-node.js:73231-73250`
- Lazy entity access: `GetLine()` at `web-ifc-api-node.js:72133-72177`

### ifc-lite — `StepTokenizer` + `parseLite()` — Minimal parse, maximum deferral

The most aggressive lazy strategy:

1. **Byte-level scan** (`tokenizer.ts:94-229`): Finds entity boundaries (express ID, type name, byte offset, byte length) without parsing any attributes. ~1,259 MB/s throughput.
2. **Build type index** (`columnar-parser.ts:613-629`): Groups express IDs by type string. No attribute parsing needed — type was extracted during scanning.
3. **Batch extract only GlobalId + Name** (`columnar-parser.ts:282-354`): For geometry/type entities, extracts just 2 attributes using only 2 `TextDecoder.decode()` calls total across ALL entities.
4. **Byte-level relationship scanning** (`columnar-parser.ts:427-479`): Extracts entity ID references from relationships without decoding strings.
5. **Everything else deferred**: Full attribute parsing, properties, quantities, classifications — all on-demand via `extractPropertiesOnDemand()` (`columnar-parser.ts:918-975`).

### The key difference

| | Attributes parsed | Indexes built | Entity objects created |
|---|---|---|---|
| IfcOpenShell | All, eagerly | ID, type, GUID, inverse | All entities |
| web-ifc | None (stay in WASM) | Internal to WASM | On demand via `GetLine()` |
| ifc-lite | GlobalId + Name only | type, ID (compact binary search) | None (byte offsets only) |

This explains the 10x parse time gap. IfcOpenShell builds the full object graph. web-ifc tokenizes into WASM memory but doesn't materialize. ifc-lite doesn't even fully tokenize — it just records byte boundaries and extracts the minimum needed for indexing.

## Detailed Timings

### IfcOpenShell

Single core, comparable to IFC Lite and Web IFC. Using the datamodel branch.

```
FILE                                                           SIZE    OPEN   QUERY    GEOM  PRODS
-----------------------------------------------------------------------------------------------------
duplex.ifc                                                     2.3M   0.10s  0.000s   0.34s    215
AC20-FZK-Haus.ifc                                              2.4M   0.11s  0.000s   0.92s     83
ISSUE_005_haus.ifc                                             2.4M   0.10s  0.000s   0.92s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.15s  0.000s   3.05s   2636
Office_A_20110811.ifc                                          3.8M   0.18s  0.010s   0.58s    803
ISSUE_126_model.ifc                                            4.2M   0.21s  0.000s   0.92s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.20s  0.001s   1.58s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.27s  0.000s   1.63s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.55s  0.006s   9.51s    425
C20-Institute-Var-2.ifc                                       10.3M   0.54s  0.001s   3.22s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.64s  0.008s   4.09s    959
dental_clinic.ifc                                             12.4M   0.68s  0.003s   2.17s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   0.82s  0.006s   7.48s    705
ifcbridge-model01.ifc                                         14.5M   0.22s  0.000s    FAIL      0
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   1.08s  0.002s  16.63s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   1.68s  0.008s  20.28s   3407
advanced_model.ifc                                            33.7M   1.90s  0.004s   5.76s   6401
schependomlaan.ifc                                            47.0M   2.51s  0.024s   3.27s   3569
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   3.16s  0.012s  10.45s   4459
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   4.04s  0.036s  45.31s  11124
private2.ifc                                                 147.4M   6.22s  0.000s  10.47s   4521
private5.ifc                                                 161.3M  10.14s  0.000s 302.55s  28808
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M  10.05s  0.039s  37.90s  60285
private1.ifc                                                 211.7M  11.93s  0.000s 276.67s  19425
private3.ifc                                                 245.4M  15.03s  0.000s 254.48s 114032
private4.ifc                                                 302.7M  20.10s  0.000s 560.63s  56580
```

Maximum threads on my machine:

```
FILE                                                           SIZE    OPEN   QUERY    GEOM  PRODS
-----------------------------------------------------------------------------------------------------
duplex.ifc                                                     2.3M   0.10s  0.000s   0.07s    215
AC20-FZK-Haus.ifc                                              2.4M   0.12s  0.000s   0.38s     83
ISSUE_005_haus.ifc                                             2.4M   0.11s  0.000s   0.36s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.17s  0.000s   0.59s   2636
Office_A_20110811.ifc                                          3.8M   0.21s  0.002s   0.20s    803
ISSUE_126_model.ifc                                            4.2M   0.25s  0.001s   0.18s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.25s  0.002s   0.44s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.34s  0.000s   0.43s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.64s  0.002s   1.60s    425
C20-Institute-Var-2.ifc                                       10.3M   0.65s  0.000s   0.73s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.79s  0.008s   0.75s    959
dental_clinic.ifc                                             12.4M   0.85s  0.005s   0.60s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   1.07s  0.005s   0.61s    705
ifcbridge-model01.ifc                                         14.5M   1.36s  0.000s   0.43s    165
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   1.70s  0.003s   3.38s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   2.11s  0.007s   3.66s   3407
advanced_model.ifc                                            33.7M   2.45s  0.002s   1.30s   6401
schependomlaan.ifc                                            47.0M   3.02s  0.007s   0.85s   3569
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   3.84s  0.007s   1.63s   4459
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   4.93s  0.020s   7.41s  11124
private2.ifc                                                 147.4M   7.33s  0.000s   1.38s   4521
private5.ifc                                                 161.3M  11.10s  0.000s  31.83s  28808
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M  12.24s  0.014s   9.10s  60285
private1.ifc                                                 211.7M  14.48s  0.000s  41.16s  19425
private3.ifc                                                 245.4M  18.66s  0.000s  34.10s 114032
private4.ifc                                                 302.7M  22.88s  0.000s  60.92s  56580
```

### web-ifc

With StreamAllMeshes:

```
FILE                                                           SIZE    OPEN   QUERY    GEOM  PRODS
-----------------------------------------------------------------------------------------------------
duplex.ifc                                                     2.3M   0.03s  0.000s   0.06s    215
AC20-FZK-Haus.ifc                                              2.4M   0.02s  0.000s   0.10s     83
ISSUE_005_haus.ifc                                             2.4M   0.01s  0.000s   0.09s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.02s  0.000s   0.32s   2636
Office_A_20110811.ifc                                          3.8M   0.02s  0.000s   0.09s    803
ISSUE_126_model.ifc                                            4.2M   0.03s  0.000s   0.05s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.03s  0.000s   0.06s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.04s  0.000s   0.11s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.06s  0.000s   0.31s    425
C20-Institute-Var-2.ifc                                       10.3M   0.08s  0.000s   0.30s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.07s  0.000s   0.32s    959
dental_clinic.ifc                                             12.4M   0.08s  0.000s   0.37s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   0.09s  0.000s   0.50s    705
ifcbridge-model01.ifc                                         14.5M   0.09s  0.000s   0.10s    165
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   0.17s  0.000s   1.20s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   0.21s  0.000s   2.78s   3417
advanced_model.ifc                                            33.7M   0.24s  0.000s   1.00s   6401
schependomlaan.ifc                                            47.0M   0.33s  0.000s   0.33s   3569
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   0.37s  0.000s   1.79s   4459
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   0.47s  0.000s   9.96s  11124
private2.ifc                                                 147.4M   1.05s  0.000s   0.52s   4521
private5.ifc                                                 161.3M   1.13s  0.000s  14.44s  28808
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M   1.29s  0.000s   4.59s  60285
private1.ifc                                                 211.7M   1.35s  0.000s   2.65s  19425
private3.ifc                                                 245.4M   1.61s  0.000s  10.20s 114032
private4.ifc                                                 302.7M   2.37s  0.000s 135.01s  56580
```

With StreamAllMeshesWithTypes:

```
FILE                                                           SIZE    OPEN   QUERY    GEOM  PRODS
-----------------------------------------------------------------------------------------------------
duplex.ifc                                                     2.3M   0.03s  0.000s   0.15s    215
AC20-FZK-Haus.ifc                                              2.4M   0.02s  0.000s   0.15s     83
ISSUE_005_haus.ifc                                             2.4M   0.01s  0.000s   0.14s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.02s  0.000s   1.51s   2636
Office_A_20110811.ifc                                          3.8M   0.02s  0.000s   0.28s    803
ISSUE_126_model.ifc                                            4.2M   0.03s  0.000s   0.18s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.03s  0.000s   0.27s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.03s  0.000s   0.34s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.06s  0.000s   1.45s    425
C20-Institute-Var-2.ifc                                       10.3M   0.07s  0.000s   0.62s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.07s  0.000s   1.08s    959
dental_clinic.ifc                                             12.4M   0.10s  0.000s   2.09s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   0.08s  0.000s   2.37s    705
ifcbridge-model01.ifc                                         14.5M   0.09s  0.000s   0.57s    165
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   0.16s  0.000s   3.56s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   0.20s  0.000s  16.52s   3417
advanced_model.ifc                                            33.7M   0.23s  0.000s   4.64s   6401
schependomlaan.ifc                                            47.0M   0.31s  0.000s   2.37s   3569
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   0.37s  0.000s  13.85s   4459
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   0.48s  0.000s  82.10s  11124
private2.ifc                                                 147.4M   1.02s  0.000s   3.50s   4521
private5.ifc                                                 161.3M   1.12s  0.000s  61.43s  28808
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M   1.29s  0.000s  30.24s  60285
private1.ifc                                                 211.7M   1.33s  0.000s  12.06s  19425
private3.ifc                                                 245.4M   1.61s  0.000s  39.86s 114032
private4.ifc                                                 302.7M   2.31s  0.000s 530.82s  56580
```

### ifc-lite

```
FILE                                                           SIZE   PARSE   QUERY    GEOM  PRODS
-----------------------------------------------------------------------------------------------------
duplex.ifc                                                     2.3M   0.04s  0.000s   0.08s    215
AC20-FZK-Haus.ifc                                              2.4M   0.04s  0.000s   0.15s     83
ISSUE_005_haus.ifc                                             2.4M   0.02s  0.000s   0.13s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.05s  0.000s   0.11s   2636
Office_A_20110811.ifc                                          3.8M   0.04s  0.000s   0.08s    803
ISSUE_126_model.ifc                                            4.2M   0.04s  0.000s   0.07s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.04s  0.000s   0.11s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.06s  0.000s   0.12s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.10s  0.000s   0.26s    425
C20-Institute-Var-2.ifc                                       10.3M   0.09s  0.000s   0.16s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.11s  0.000s   0.24s    959
dental_clinic.ifc                                             12.4M   0.11s  0.000s   0.26s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   0.15s  0.000s   0.39s    705
ifcbridge-model01.ifc                                         14.5M   0.12s  0.000s   0.27s    165
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   0.20s  0.000s   0.89s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   0.28s  0.000s   0.73s   3403
advanced_model.ifc                                            33.7M   0.39s  0.000s   1.29s   6399
schependomlaan.ifc                                            47.0M   0.35s  0.000s   0.68s   3566
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   0.54s  0.000s   1.30s   4455
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   0.75s  0.000s   1.83s  11124
private2.ifc                                                 147.4M   1.00s  0.000s   3.26s   4521
private5.ifc                                                 161.3M   1.26s  0.000s   6.88s  28391
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M   1.53s  0.000s    FAIL      0
private1.ifc                                                 211.7M   1.52s  0.000s    FAIL      0
private3.ifc                                                 245.4M   2.10s  0.000s    FAIL      0
private4.ifc                                                 302.7M   2.26s  0.000s    FAIL      0
```

### IfcOpenShell vs web-ifc (head to head)

**Parsing**: web-ifc is consistently 5-10x faster. For the 303MB file: 2.37s vs 20.10s.

**Geometry (single-core, apples-to-apples)**: web-ifc is 5-100x faster on most models. IfcOpenShell's CGAL+OpenCASCADE kernel is dramatically slower without multiprocessing:
- private4 (303MB): IfcOpenShell 561s vs web-ifc 135s (4.2x slower)
- private5 (161MB): IfcOpenShell 303s vs web-ifc 14s (21x slower)
- private1 (212MB): IfcOpenShell 277s vs web-ifc 2.7s (103x slower)
- ISSUE_098 (68MB): IfcOpenShell 45s vs web-ifc 10s (4.5x slower)
- ISSUE_159 (9.5MB): IfcOpenShell 9.5s vs web-ifc 0.31s (31x slower)

**Geometry (multiprocessed IfcOpenShell)**: The gap narrows significantly. IfcOpenShell even wins on a few models:
- private4 (303MB): IfcOpenShell 61s vs web-ifc 135s — IfcOpenShell wins
- ISSUE_098 (68MB): IfcOpenShell 7.4s vs web-ifc 10.0s — IfcOpenShell wins
- private1 (212MB): web-ifc 2.7s vs IfcOpenShell 41s — web-ifc still wins big

**Product counts**: Nearly identical. S_Office has a small 10-product discrepancy (3417 vs 3407). ifcbridge-model01 shows 165 products on both web-ifc and multiprocessed IfcOpenShell, but FAILs on single-core IfcOpenShell.

**Takeaways**: Single-threaded, IfcOpenShell's geometry kernel is an order of magnitude slower than web-ifc on most models. Multiprocessing recovers much of that gap and even wins on some complex models, but it can't fully compensate. For a pipeline that needs fast open + iterate, web-ifc currently wins overall. Geometry complexity matters more than file size — both engines have individual models where they choke.
