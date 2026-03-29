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

## Output

Each script prints per-file timings and a per-type geometry product breakdown, followed by a summary table:

```
FILE              SIZE    OPEN   QUERY    GEOM  PRODS
------------------------------------------------------
duplex.ifc        2.3M   0.03s  0.000s   0.06s    216
```
