# IFC Profiling

Benchmarks for comparing IFC parsing, querying, and geometry processing across three engines.

## Engines

| Script | Engine | Geometry |
|---|---|---|
| `profile_ifc.py` | IfcOpenShell (C++/Python) | Hybrid CGAL + OpenCASCADE, multiprocessed |
| `src/main.ts` | ifc-lite (Rust/WASM) | WASM single-threaded |
| `webifc/src/main.ts` | web-ifc (C++/WASM) | WASM single-threaded |

## Models

IFC test files live in `models/`. Sourced from [ifc-lite/tests/models/ara3d](https://github.com/louistrue/ifc-lite/tree/main/tests/models/ara3d), files under 1MB removed.

## Usage

All scripts accept an optional filename argument to target a single model. Without it, all models are processed in filesize order.

### IfcOpenShell

```sh
python profile_ifc.py                  # all models
python profile_ifc.py duplex.ifc       # single model
```

### ifc-lite

```sh
pnpm start                    # all models
pnpm start duplex.ifc         # single model
```

### web-ifc

```sh
cd webifc
pnpm tsx src/main_simple.ts              # all models (StreamAllMeshes, no type filtering — significantly faster)
pnpm tsx src/main_simple.ts duplex.ifc   # single model
pnpm start                    # all models (StreamAllMeshesWithTypes)
pnpm start duplex.ifc         # single model
```

## Per-object profiling

Per-object scripts time each geometry element individually and write results to JSON for analysis.

### IfcOpenShell

```sh
python profile_ifc_per_object.py                  # all models
python profile_ifc_per_object.py duplex.ifc       # single model
# -> timings_ifcopenshell.json (+ plot_*.png if PLOT=True)
```

Set `PLOT = False` at the top of the script to skip matplotlib plots.

### ifc-lite

```sh
pnpm tsx src/profile_per_object.ts                 # all models
pnpm tsx src/profile_per_object.ts duplex.ifc      # single model
# -> timings_ifclite.json
```

Note: ifc-lite's `parseMeshes()` does all geometry in one WASM call. `tInit` is the actual meshing time; per-element times are WASM-to-JS deserialization only.

### web-ifc

```sh
cd webifc
pnpm tsx src/profile_per_object.ts                 # all models
pnpm tsx src/profile_per_object.ts duplex.ifc      # single model
# -> timings_webifc.json (written to repo root)
```

### JSON output format

All three produce the same structure:

```json
[{
  "file": "duplex.ifc",
  "sizeMb": 2.3,
  "tInit": 0.045,
  "tIter": 0.312,
  "products": 215,
  "timings": [
    { "time": 0.003, "expressId": 12345, "type": "IfcWall" }
  ]
}]
```

## Output

Each summary script prints per-file timings and a per-type geometry product breakdown, followed by a summary table:

```
FILE              SIZE    OPEN   QUERY    GEOM  PRODS
------------------------------------------------------
duplex.ifc        2.3M   0.03s  0.000s   0.06s    216
```
