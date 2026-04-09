import glob
import json
import os
import sys
import time

sys.path.insert(0, "/home/dion/Projects/ios-dm/src/ifcopenshell-python")
sys.path.insert(0, "/home/dion/Projects/ios-dm/build/ifcwrap")

import ifcopenshell
import ifcopenshell.geom

MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
PLOT = True


def plot_timings(timings, name, t_init, total_iter):
    import matplotlib.pyplot as plt
    import numpy as np

    times = np.array([t[0] for t in timings])

    fig, axes = plt.subplots(2, 2, figsize=(16, 10))
    fig.suptitle(f"{name} — {len(timings)} products, init {t_init:.2f}s, iter {total_iter:.2f}s", fontsize=13)

    # 1) sorted times (descending) — shows outlier shape
    ax = axes[0, 0]
    sorted_times = np.sort(times)[::-1]
    ax.bar(range(len(sorted_times)), sorted_times, width=1.0, color="steelblue")
    ax.set_xlabel("Element (ranked)")
    ax.set_ylabel("Time (s)")
    ax.set_title("Per-element time (sorted descending)")

    # 2) cumulative % of total time — shows concentration
    ax = axes[0, 1]
    cumsum = np.cumsum(sorted_times)
    pct = cumsum / cumsum[-1] * 100
    ax.plot(range(len(pct)), pct, color="steelblue")
    for target in [50, 90, 99]:
        idx = np.searchsorted(pct, target)
        ax.axhline(target, color="gray", linewidth=0.5, linestyle="--")
        ax.axvline(idx, color="gray", linewidth=0.5, linestyle="--")
        ax.annotate(f"{target}% in {idx} elements", (idx, target),
                    textcoords="offset points", xytext=(10, -5), fontsize=8)
    ax.set_xlabel("Element count (ranked)")
    ax.set_ylabel("Cumulative % of total time")
    ax.set_title("Time concentration")

    # 3) time by IFC type (box plot of top types)
    ax = axes[1, 0]
    type_times = {}
    for t_val, _, ifc_type, _ in timings:
        type_times.setdefault(ifc_type, []).append(t_val)
    top_types = sorted(type_times.keys(), key=lambda k: -sum(type_times[k]))[:15]
    box_data = [type_times[t] for t in top_types]
    bp = ax.boxplot(box_data, vert=True, patch_artist=True, showfliers=True)
    for patch in bp["boxes"]:
        patch.set_facecolor("steelblue")
        patch.set_alpha(0.6)
    ax.set_xticklabels([f"{t}\n({len(type_times[t])})" for t in top_types],
                       rotation=45, ha="right", fontsize=7)
    ax.set_ylabel("Time (s)")
    ax.set_title("Time distribution by IFC type (top 15 by total)")

    # 4) log histogram — shows overall distribution shape
    ax = axes[1, 1]
    log_times = np.log10(times[times > 0])
    ax.hist(log_times, bins=50, color="steelblue", edgecolor="white", linewidth=0.3)
    ax.set_xlabel("log₁₀(time in s)")
    ax.set_ylabel("Count")
    ax.set_title("Distribution of element times (log scale)")
    stats_text = (f"median: {np.median(times)*1000:.1f}ms\n"
                  f"mean: {np.mean(times)*1000:.1f}ms\n"
                  f"p95: {np.percentile(times, 95)*1000:.1f}ms\n"
                  f"p99: {np.percentile(times, 99)*1000:.1f}ms\n"
                  f"max: {np.max(times):.3f}s")
    ax.text(0.95, 0.95, stats_text, transform=ax.transAxes,
            verticalalignment="top", horizontalalignment="right",
            fontsize=9, fontfamily="monospace",
            bbox=dict(boxstyle="round", facecolor="wheat", alpha=0.8))

    plt.tight_layout()
    plot_path = os.path.join(os.path.dirname(__file__), f"plot_{os.path.splitext(name)[0]}.png")
    plt.savefig(plot_path, dpi=150)
    plt.close()
    print(f"  Plot saved: {plot_path}")

if len(sys.argv) > 1:
    paths = [os.path.join(MODELS_DIR, sys.argv[1]) if not os.path.isabs(sys.argv[1]) else sys.argv[1]]
else:
    paths = sorted(glob.glob(os.path.join(MODELS_DIR, "*.[iI][fF][cC]")), key=os.path.getsize)

all_results = []

for path in paths:
    name = os.path.basename(path)
    size_mb = os.path.getsize(path) / (1024 * 1024)
    print(f"\n{'='*60}")
    print(f"{name} ({size_mb:.1f} MB)")
    print(f"{'='*60}")

    t0 = time.perf_counter()
    f = ifcopenshell.open(path)
    t_open = time.perf_counter() - t0
    print(f"  open: {t_open:.3f}s")

    settings = ifcopenshell.geom.settings()
    iterator = ifcopenshell.geom.iterator(
        settings, f, 1,
        geometry_library="hybrid-cgal-simple-opencascade",
        exclude=["IfcOpeningElement", "IfcOpeningStandardCase", "IfcSpace", "IfcBuilding", "IfcBuildingStorey"],
    )

    timings = []
    t0 = time.perf_counter()
    if iterator.initialize():
        t_init = time.perf_counter() - t0
        print(f"  iterator.initialize(): {t_init:.3f}s")

        t0 = time.perf_counter()
        while True:
            elapsed = time.perf_counter() - t0
            shape = iterator.get()
            entity = f.by_id(shape.id)
            timings.append((elapsed, shape.id, entity.is_a(), getattr(entity, "Name", None)))
            t0 = time.perf_counter()
            if not iterator.next():
                break

        print(f"  {len(timings)} products processed\n")
        print(f"  Top 10 slowest:")
        print(f"  {'TIME':>8}  {'ID':>8}  {'TYPE':<30}  NAME")
        print(f"  {'-'*80}")
        for elapsed, eid, ifc_type, ename in sorted(timings, key=lambda x: -x[0])[:10]:
            print(f"  {elapsed:>7.3f}s  #{eid:<7}  {ifc_type:<30}  {ename or ''}")

        total_iter = sum(t[0] for t in timings)
        print(f"\n  Init: {t_init:.3f}s  Iter: {total_iter:.3f}s  Total: {t_init + total_iter:.3f}s")

        all_results.append({
            "file": name,
            "size_mb": size_mb,
            "t_open": t_open,
            "t_init": t_init,
            "t_iter": total_iter,
            "products": len(timings),
            "timings": [{"time": t, "expressId": eid, "type": tp} for t, eid, tp, _ in timings],
        })

        if PLOT:
            plot_timings(timings, name, t_init, total_iter)
    else:
        print("  geometry: FAILED to initialize")

out_path = os.path.join(os.path.dirname(__file__), "timings_ifcopenshell.json")
with open(out_path, "w") as fp:
    json.dump(all_results, fp, indent=2)
print(f"\nTimings written to {out_path}")
