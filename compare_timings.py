"""Compare per-object timings: find where IfcOpenShell is slowest relative to web-ifc and ifc-lite.

Usage:
    python compare_timings.py                          # all models
    python compare_timings.py duplex.ifc               # single model
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(__file__)

TOP_N = 20


def load(path):
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return {r["file"]: r for r in json.load(f)}


ios_data = load(os.path.join(SCRIPT_DIR, "timings_ifcopenshell.json"))
wifc_data = load(os.path.join(SCRIPT_DIR, "timings_webifc.json"))
lite_data = load(os.path.join(SCRIPT_DIR, "timings_ifclite.json"))

if not ios_data:
    print("timings_ifcopenshell.json not found")
    sys.exit(1)

models = sorted(ios_data.keys())
if len(sys.argv) > 1:
    target = sys.argv[1]
    models = [m for m in models if m == target]
    if not models:
        print(f"Model '{target}' not found in IfcOpenShell timings")
        sys.exit(1)

for model in models:
    ios = ios_data[model]
    ios_by_id = {t["expressId"]: t for t in ios["timings"]}

    print(f"\n{'='*100}")
    t_init = ios.get("t_init") or ios.get("tInit", 0)
    t_iter = ios.get("t_iter") or ios.get("tIter", 0)
    print(f"{model} — IfcOpenShell init: {t_init:.3f}s  iter: {t_iter:.3f}s  total: {t_init + t_iter:.3f}s")
    print(f"{'='*100}")

    # ── vs web-ifc ───────────────────────────────────────────────────
    wifc = wifc_data.get(model)
    if wifc:
        wifc_by_id = {t["expressId"]: t for t in wifc["timings"]}
        matched = []
        for eid, ios_t in ios_by_id.items():
            wifc_t = wifc_by_id.get(eid)
            if wifc_t and wifc_t["time"] > 0:
                ratio = ios_t["time"] / wifc_t["time"]
                diff = ios_t["time"] - wifc_t["time"]
                matched.append((eid, ios_t["type"], ios_t["time"], wifc_t["time"], ratio, diff))

        # Sort by absolute time difference (where IOS loses the most)
        matched.sort(key=lambda x: -x[5])

        print(f"\n  vs web-ifc — {len(matched)} matched elements")
        print(f"  {'ID':>8}  {'TYPE':<30}  {'IOS':>8}  {'WIFC':>8}  {'RATIO':>7}  {'DIFF':>8}")
        print(f"  {'-'*80}")
        for eid, typ, ios_time, wifc_time, ratio, diff in matched[:TOP_N]:
            print(f"  #{eid:<7}  {typ:<30}  {ios_time:>7.3f}s  {wifc_time:>7.3f}s  {ratio:>6.1f}x  +{diff:>6.3f}s")

        # Summary stats
        if matched:
            ratios = [m[4] for m in matched]
            diffs = [m[5] for m in matched]
            total_ios = sum(m[2] for m in matched)
            total_wifc = sum(m[3] for m in matched)
            print(f"\n  Matched total: IOS {total_ios:.2f}s vs WIFC {total_wifc:.2f}s ({total_ios/total_wifc:.1f}x)")
            print(f"  Top {TOP_N} account for {sum(d for d in diffs[:TOP_N]):.2f}s of the {sum(diffs):.2f}s total gap")

        # IOS-only (no web-ifc equivalent)
        ios_only = [ios_by_id[eid] for eid in ios_by_id if eid not in wifc_by_id]
        if ios_only:
            ios_only.sort(key=lambda x: -x["time"])
            ios_only_total = sum(t["time"] for t in ios_only)
            print(f"\n  {len(ios_only)} elements only in IOS (not in web-ifc), total: {ios_only_total:.3f}s")
            if ios_only[0]["time"] > 0.01:
                print(f"  Slowest IOS-only:")
                for t in ios_only[:5]:
                    print(f"    #{t['expressId']:<7}  {t['type']:<30}  {t['time']:.3f}s")
    else:
        print("\n  (no web-ifc data)")

    # ── vs ifc-lite ──────────────────────────────────────────────────
    lite = lite_data.get(model)
    if lite:
        lite_by_id = {t["expressId"]: t for t in lite["timings"]}
        matched = []
        for eid, ios_t in ios_by_id.items():
            lite_t = lite_by_id.get(eid)
            if lite_t and lite_t["time"] > 0:
                ratio = ios_t["time"] / lite_t["time"]
                diff = ios_t["time"] - lite_t["time"]
                matched.append((eid, ios_t["type"], ios_t["time"], lite_t["time"], ratio, diff))

        matched.sort(key=lambda x: -x[5])

        print(f"\n  vs ifc-lite — {len(matched)} matched elements")
        print(f"  {'ID':>8}  {'TYPE':<30}  {'IOS':>8}  {'LITE':>8}  {'RATIO':>7}  {'DIFF':>8}")
        print(f"  {'-'*80}")
        for eid, typ, ios_time, lite_time, ratio, diff in matched[:TOP_N]:
            print(f"  #{eid:<7}  {typ:<30}  {ios_time:>7.3f}s  {lite_time:>7.3f}s  {ratio:>6.1f}x  +{diff:>6.3f}s")

        if matched:
            ratios = [m[4] for m in matched]
            diffs = [m[5] for m in matched]
            total_ios = sum(m[2] for m in matched)
            total_lite = sum(m[3] for m in matched)
            print(f"\n  Matched total: IOS {total_ios:.2f}s vs LITE {total_lite:.2f}s ({total_ios/total_lite:.1f}x)")
            print(f"  Top {TOP_N} account for {sum(d for d in diffs[:TOP_N]):.2f}s of the {sum(diffs):.2f}s total gap")

        ios_only = [ios_by_id[eid] for eid in ios_by_id if eid not in lite_by_id]
        if ios_only:
            ios_only.sort(key=lambda x: -x["time"])
            ios_only_total = sum(t["time"] for t in ios_only)
            print(f"\n  {len(ios_only)} elements only in IOS (not in ifc-lite), total: {ios_only_total:.3f}s")
            if ios_only[0]["time"] > 0.01:
                print(f"  Slowest IOS-only:")
                for t in ios_only[:5]:
                    print(f"    #{t['expressId']:<7}  {t['type']:<30}  {t['time']:.3f}s")
    else:
        print("\n  (no ifc-lite data)")
