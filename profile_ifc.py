import glob
import multiprocessing
import os
import sys
import time

# sys.path.insert(0, "/home/dion/Projects/ios-dm/src/ifcopenshell-python")
# sys.path.insert(0, "/home/dion/Projects/ios-dm/build/ifcwrap")

import ifcopenshell
import ifcopenshell.geom

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")

if len(sys.argv) > 1:
    paths = [os.path.join(MODELS_DIR, sys.argv[1]) if not os.path.isabs(sys.argv[1]) else sys.argv[1]]
else:
    paths = sorted(glob.glob(os.path.join(MODELS_DIR, "*.[iI][fF][cC]")), key=os.path.getsize)

results = []

for path in paths:
    name = os.path.basename(path)
    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"{name} ({size_mb:.1f} MB)")
    print(f"{'='*60}")

    row = {"file": name, "size_mb": size_mb}

    t0 = time.perf_counter()
    f = ifcopenshell.open(path)
    row["t_open"] = time.perf_counter() - t0
    print(f"  open: {row['t_open']:.3f}s")

    t0 = time.perf_counter()
    row["walls"] = len(f.by_type("IfcWall"))
    row["slabs"] = len(f.by_type("IfcSlab"))
    row["t_query"] = time.perf_counter() - t0
    print(f"  IfcWall: {row['walls']}, IfcSlab: {row['slabs']} (query: {row['t_query']:.3f}s)")

    cpu_count = multiprocessing.cpu_count()
    cpu_count = 1
    settings = ifcopenshell.geom.settings()
    t0 = time.perf_counter()
    iterator = ifcopenshell.geom.iterator(
        settings, f, cpu_count,
        geometry_library="hybrid-cgal-simple-opencascade",
        exclude=["IfcOpeningElement", "IfcOpeningStandardCase", "IfcSpace", "IfcBuilding", "IfcBuildingStorey"],
    )
    type_counts = {}
    if iterator.initialize():
        count = 0
        while True:
            shape = iterator.get()
            ifc_type = f.by_id(shape.id).is_a()
            type_counts[ifc_type] = type_counts.get(ifc_type, 0) + 1
            count += 1
            if not iterator.next():
                break
        row["products"] = count
        row["t_geom"] = time.perf_counter() - t0
        print(f"  geometry ({count} products): {row['t_geom']:.3f}s")
    else:
        row["products"] = 0
        row["t_geom"] = None
        print("  geometry: FAILED to initialize")

    row["by_type"] = type_counts
    for t, c in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {t}: {c}")

    results.append(row)

w = max(len(r["file"]) for r in results) + 2
total = w + 42
print(f"\n\n{'='*total}")
print(f"{'FILE':<{w}} {'SIZE':>7} {'OPEN':>7} {'QUERY':>7} {'GEOM':>7} {'PRODS':>6}")
print(f"{'-'*total}")
for r in results:
    geom = f"{r['t_geom']:.2f}s" if r["t_geom"] is not None else "FAIL"
    print(f"{r['file']:<{w}} {r['size_mb']:>6.1f}M {r['t_open']:>6.2f}s {r['t_query']:>6.3f}s {geom:>7} {r['products']:>6}")
print(f"{'='*total}")
