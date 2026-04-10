# IFC Engine Profiling Findings

Benchmarked across 26 IFC models (2.3MB - 303MB), including public ara3d test models and private production files.

Exclusions applied equally: IfcOpeningElement, IfcSpace, IfcBuilding, IfcBuildingStorey.

## Parsing

ifc-lite and web-ifc are neck and neck, both 3-7x faster than IfcOpenShell.

| | Small (2-5MB) | Medium (10-30MB) | Large (50-300MB) |
|---|---|---|---|
| IfcOpenShell | 0.07-0.18s | 0.40-1.42s | 2.67-15.83s |
| web-ifc | 0.01-0.03s | 0.06-0.21s | 0.37-2.37s |
| ifc-lite | 0.02-0.05s | 0.09-0.28s | 0.54-2.26s |

For single-core IfcOpenShell, the geometry kernel dominates total runtime — on most files meshing takes several times longer than parsing. With multiprocessing, geometry becomes competitive with web-ifc and parsing becomes the main bottleneck.

## Geometry

ifc-lite is the fastest geometry engine when it works, but crashes on 4 of the largest models.

- **ifc-lite**: 2-5x faster than both others on most models. Crashes with WASM `unreachable` on 4 large models (169MB+). Small product count discrepancies on several models.
- **web-ifc**: Typically 2-8x faster than single-core IfcOpenShell on geometry, with one extreme outlier (private1 ~86x). Handles all 26 models. One pathological case: private4 (303MB) takes 135s — even single-core IfcOpenShell beats it there.
- **IfcOpenShell**: Processes everything correctly. Single-threaded, it's typically 2-8x slower than web-ifc on geometry, though it wins on some complex models (private4, ISSUE_098). With multiprocessing, IfcOpenShell wins geometry on about half the models — but its slower parsing means web-ifc still wins on total pipeline time for most.

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
| web-ifc | 26/26 | close, with small gaps (e.g. S_Office +10, private1 +85) |
| ifc-lite | 22/26 (4 FAIL) | small gaps on several models |

## Query

Negligible for all three engines (<0.02s even on the largest files).

## Known ifc-lite issues found

- Missing type support in `has_geometry_by_name()`: 31 IfcProduct subtypes were not in the geometry whitelist, including IfcSolarDevice, IfcAudioVisualAppliance, IfcCommunicationsAppliance, IfcDistributionChamberElement. Fixed in this profiling session.
- WASM geometry crashes on large/complex models (ISSUE_053, private1, private3, private4).
- 2 walls in advanced_model.ifc fail to mesh: #555613 (IfcBooleanClippingResult with IfcPolygonalBoundedHalfSpace) and #612315 (void subtraction edge case with full-height opening).

## Summary

ifc-lite has the fastest combined parse+geometry pipeline when it works, but is not production-ready for large/complex models. web-ifc is the best all-rounder for total pipeline time: fast parsing, solid geometry, handles everything. IfcOpenShell is the correct reference implementation — with multiprocessing it wins on geometry for about half the models, but its slower parsing (3-7x vs web-ifc) means web-ifc still wins on total pipeline time for most models. Parsing, not geometry, is now IfcOpenShell's main bottleneck when multiprocessing is available.

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
duplex.ifc                                                     2.3M   0.07s  0.000s   0.12s    215
AC20-FZK-Haus.ifc                                              2.4M   0.09s  0.000s   0.13s     83
ISSUE_005_haus.ifc                                             2.4M   0.08s  0.000s   0.13s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.10s  0.000s   0.43s   2636
Office_A_20110811.ifc                                          3.8M   0.13s  0.002s   0.16s    803
ISSUE_126_model.ifc                                            4.2M   0.18s  0.001s   0.28s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.15s  0.003s   0.56s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.21s  0.000s   0.41s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.46s  0.005s   1.19s    414
C20-Institute-Var-2.ifc                                       10.3M   0.40s  0.002s   0.31s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.55s  0.006s   0.97s    959
dental_clinic.ifc                                             12.4M   0.53s  0.007s   0.72s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   0.72s  0.003s   1.71s    692
ifcbridge-model01.ifc                                         14.5M   0.81s  0.000s   1.24s    165
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   1.10s  0.003s   2.92s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   1.42s  0.003s   2.62s   3407
advanced_model.ifc                                            33.7M   1.58s  0.004s   2.34s   6401
schependomlaan.ifc                                            47.0M   1.84s  0.009s   1.51s   3569
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   2.67s  0.008s   3.05s   4459
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   3.34s  0.065s   5.08s  11124
private2.ifc                                                 147.4M   4.32s  0.000s   1.51s   4521
private5.ifc                                                 161.3M   8.32s  0.000s 113.72s  28801
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M   8.68s  0.010s  10.85s  60285
private1.ifc                                                 211.7M   9.82s  0.000s 228.13s  19340
private3.ifc                                                 245.4M  11.53s  0.000s  49.61s 114032
private4.ifc                                                 302.7M  15.83s  0.000s  61.22s  56559
```

Maximum threads on my machine:

```
FILE                                                           SIZE    OPEN   QUERY    GEOM  PRODS
-----------------------------------------------------------------------------------------------------
duplex.ifc                                                     2.3M   0.08s  0.000s   0.04s    215
AC20-FZK-Haus.ifc                                              2.4M   0.10s  0.000s   0.05s     83
ISSUE_005_haus.ifc                                             2.4M   0.09s  0.000s   0.04s     83
ISSUE_021_Mini Project.ifc                                     3.2M   0.13s  0.000s   0.16s   2636
Office_A_20110811.ifc                                          3.8M   0.16s  0.002s   0.09s    803
ISSUE_126_model.ifc                                            4.2M   0.24s  0.001s   0.08s    257
ISSUE_034_HouseZ.ifc                                           4.8M   0.21s  0.002s   0.17s    228
ISSUE_102_M3D-CON.ifc                                          6.0M   0.28s  0.000s   0.21s    138
ISSUE_159_kleine_Wohnung_R22.ifc                               9.5M   0.57s  0.005s   0.34s    416
C20-Institute-Var-2.ifc                                       10.3M   0.53s  0.002s   0.14s    702
ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc     11.5M   0.67s  0.006s   0.22s    959
dental_clinic.ifc                                             12.4M   0.72s  0.009s   0.27s   2586
FM_ARC_DigitalHub.ifc                                         13.4M   0.93s  0.003s   0.61s    700
ifcbridge-model01.ifc                                         14.5M   1.04s  0.000s   0.28s    165
ISSUE_102_M3D-CON-CD.ifc                                      25.6M   1.38s  0.003s   1.28s   1616
S_Office_Integrated Design Archi.ifc                          29.6M   1.83s  0.003s   1.11s   3407
advanced_model.ifc                                            33.7M   2.17s  0.005s   0.83s   6401
schependomlaan.ifc                                            47.0M   2.39s  0.008s   0.46s   3569
ISSUE_068_ARK_NUS_skolebygg.ifc                               53.7M   3.43s  0.007s   0.68s   4459
ISSUE_098_R8_F1_MAB_AR_M3_XX_XXX_MO_7000.IFC                  68.4M   4.23s  0.010s   1.59s  11124
private2.ifc                                                 147.4M   5.40s  0.000s   0.69s   4521
private5.ifc                                                 161.3M   9.16s  0.000s  15.90s  28801
ISSUE_053_20181220Holter_Tower_10.ifc                        169.2M  10.29s  0.010s   3.41s  60285
private1.ifc                                                 211.7M  12.37s  0.000s  60.42s  19344
private3.ifc                                                 245.4M  14.80s  0.000s  12.36s 114032
private4.ifc                                                 302.7M  19.18s  0.000s  15.69s  56559
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

**Parsing**: web-ifc is consistently 3-7x faster. For the 303MB file: 2.37s vs 15.83s.

**Geometry (single-core, apples-to-apples)**: web-ifc is typically 2-8x faster, but IfcOpenShell now wins on a couple of complex models:
- private4 (303MB): IfcOpenShell 61s vs web-ifc 135s — IfcOpenShell wins (2.2x)
- ISSUE_098 (68MB): IfcOpenShell 5.1s vs web-ifc 10.0s — IfcOpenShell wins (2.0x)
- private5 (161MB): IfcOpenShell 114s vs web-ifc 14s (7.9x slower)
- private1 (212MB): IfcOpenShell 228s vs web-ifc 2.7s (86x slower — extreme outlier)
- ISSUE_159 (9.5MB): IfcOpenShell 1.2s vs web-ifc 0.31s (3.8x slower)

**Geometry (multiprocessed IfcOpenShell)**: IfcOpenShell wins geometry on ~half the models (13/26), web-ifc on 9, with 4 roughly tied. Highlights:
- private4 (303MB): IfcOpenShell 16s vs web-ifc 135s — IfcOpenShell wins decisively (8.6x)
- ISSUE_098 (68MB): IfcOpenShell 1.6s vs web-ifc 10.0s — IfcOpenShell wins decisively (6.3x)
- ISSUE_068 (54MB): IfcOpenShell 0.68s vs web-ifc 1.79s — IfcOpenShell wins (2.6x)
- private1 (212MB): web-ifc 2.7s vs IfcOpenShell 60s — web-ifc still wins big

**Total pipeline (multiprocessed open+geom)**: Despite winning on geometry, IfcOpenShell's 3-7x slower parsing means web-ifc still wins on total time for 22/26 models. IfcOpenShell only wins total time on ISSUE_098, private4, and ISSUE_021.

**Product counts**: Mostly close but with several discrepancies. S_Office: 3417 vs 3407 (10 off). private1 shows the largest gap: 19425 (web-ifc) vs 19340 (IfcOpenShell). ifcbridge-model01 now succeeds on single-core IfcOpenShell (165 products, matching web-ifc).

**Takeaways**: Single-threaded, IfcOpenShell's geometry is typically 2-8x slower than web-ifc. With multiprocessing, IfcOpenShell wins on geometry for about half the models. However, web-ifc's 3-7x parsing advantage means it still wins on total pipeline time for most models. Parsing is now IfcOpenShell's main bottleneck when multiprocessing is available. Geometry complexity matters more than file size — both engines have individual models where they choke.
