#!/usr/bin/env python3
"""
generate_layer_stops.py — Build-time generator for layer stop bpatcher files.

Reads every organ JSON in mapping/config/ and writes a matching
layer_stops_<OrganName>.maxpat into the project root.  Max loads these
via bpatcher @name at runtime — no runtime file generation needed in JS.

Usage:
    python3 tools/generate_layer_stops.py

Run this whenever an organ JSON is added or its stops change.
"""

import json
import os
import re
import sys

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
CONFIG_DIR   = os.path.join(PROJECT_ROOT, "mapping", "config")

# ── GEOMETRY constants (must match organTool_GEOMETRY.js) ──────────────────────
STOP_W       = 100
STOP_H       = 20
COL_W        = 99       # stops.w + widthOffset(-1)
COL_MARGIN   = -3       # stops.margin
MAX_PER_COL  = 8


# ── Helpers ────────────────────────────────────────────────────────────────────

def safe_organ_name(name: str) -> str:
    """Mirrors JS: organName.replace(/[^a-zA-Z0-9_-]/g, '_')"""
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", name)


def extract_organ_name(filepath: str) -> str:
    """
    Mirrors organTool_Common.js extractOrganNameFromPath().
    Strips 'organ' prefix/suffix, capitalises first letters.
    """
    filename = os.path.splitext(os.path.basename(filepath))[0]
    # Strip leading 'organ' (case-insensitive, with optional separator)
    name = re.sub(r"^organ[\s_\-]+", "", filename, flags=re.IGNORECASE)
    name = re.sub(r"[\s_\-]+organ$", "", name, flags=re.IGNORECASE)
    # Capitalise words
    name = " ".join(w.capitalize() for w in name.split())
    return name or filename


def generate_maxpat(stops: list[tuple[int, str]]) -> str:
    """
    Returns a compact (non-indented) Max patcher JSON string containing:
      - One inlet object  (inlet 0  of the bpatcher) — sends 0 to reset all buttons silently
      - One outlet object (outlet 0 of the bpatcher) — outputs stop-button clicks
      - One "prepend set" object — converts reset 0 → "set 0" (silent value set, no output)
      - One live.text toggle per stop (varname = 'stop<ID>')
      - One prepend <stopID> per stop (routes clicks to the outlet)
      - Patch lines wiring:
          inlet → prepend-set → each live.text inlet  (visual reset path)
          each live.text outlet → prepend stopID → outlet  (click output path)

    Reset usage from JS:  stopsBpatcher.message(0)
      → bpatcher forwards to inlet → prepend set → "set 0" to every live.text
      → all buttons go dark silently (no MaxobjListener fires, no outlet output)

    live.text has no parameter_enable / saved_attribute_attributes to:
      • keep the file small
      • avoid parameter-name collisions across multiple bpatcher instances
    """
    boxes: list[dict] = []
    lines: list[dict] = []

    # ── Hidden objects (negative Y, outside presentation area) ────────────────

    # Inlet 0 — reset: JS sends stopsBpatcher.message(0) to clear all buttons.
    # Must be the LEFT-MOST inlet object (x < outlet.x) so it becomes inlet 0.
    boxes.append({"box": {
        "id": "obj-in", "maxclass": "inlet", "comment": "reset (0=clear all)",
        "patching_rect": [10.0, -30.0, 30.0, 30.0],
        "numinlets": 0, "numoutlets": 1,
    }})

    # Outlet 0 — stop clicks: prepend stopID output routes here.
    boxes.append({"box": {
        "id": "obj-out", "maxclass": "outlet", "comment": "stop",
        "patching_rect": [50.0, -30.0, 30.0, 30.0],
        "numinlets": 1, "numoutlets": 0,
    }})

    # "prepend set" — converts 0 → "set 0" so live.text gets a silent set (no outlet fire).
    boxes.append({"box": {
        "id": "obj-prepset", "maxclass": "newobj", "text": "prepend set",
        "patching_rect": [10.0, -60.0, 80.0, 22.0],
        "numinlets": 2, "numoutlets": 1,
    }})

    # Wire: inlet → prepend-set
    lines.append({"patchline": {"source": ["obj-in", 0], "destination": ["obj-prepset", 0]}})

    seen_ids: set[int] = set()
    row, col = 0, 0

    for i, (stop_id, stop_name) in enumerate(stops):
        x = float(col * (COL_W + COL_MARGIN))   # col × 96
        y = float(row * STOP_H)                  # row × 20

        s_id = f"obj-s{i}"
        p_id = f"obj-p{i}"

        # Unique varname — duplicate stopIDs get an index suffix
        if stop_id not in seen_ids:
            seen_ids.add(stop_id)
            varname = f"stop{stop_id}"
        else:
            varname = f"stop{stop_id}_{i}"

        # Minimal live.text toggle button
        boxes.append({"box": {
            "id": s_id, "maxclass": "live.text",
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect":     [x, y, float(STOP_W), float(STOP_H)],
            "presentation_rect": [x, y, float(STOP_W), float(STOP_H)],
            "presentation": 1,
            "text": stop_name, "texton": stop_name,
            "varname": varname, "fontsize": 10.0,
        }})

        # prepend <stopID> — tags each button click with its stopID.
        # Placed at negative Y (hidden area) — only live.text buttons appear in presentation.
        boxes.append({"box": {
            "id": p_id, "maxclass": "newobj",
            "text": f"prepend {stop_id}",
            "patching_rect": [x, -90.0 - i * 25.0, 100.0, 22.0],
            "numinlets": 2, "numoutlets": 1,
        }})

        lines.append({"patchline": {"source": [s_id, 0], "destination": [p_id, 0]}})
        lines.append({"patchline": {"source": [p_id, 0], "destination": ["obj-out", 0]}})
        # Reset path: prepend-set → this live.text inlet (set 0 = silent visual clear)
        lines.append({"patchline": {"source": ["obj-prepset", 0], "destination": [s_id, 0]}})

        row += 1
        if row >= MAX_PER_COL:
            col += 1
            row = 0

    n_cols  = max(1, -(-len(stops) // MAX_PER_COL))   # ceil division
    p_width = max(600.0, n_cols * (COL_W + COL_MARGIN) + 200.0)
    p_height = max(300.0, MAX_PER_COL * STOP_H + len(stops) * 25.0 + 100.0)

    patch = {
        "patcher": {
            "fileversion": 1,
            "appversion": {
                "major": 8, "minor": 6, "revision": 0,
                "architecture": "x64", "modernui": 1,
            },
            "classnamespace": "box",
            "rect": [100.0, 100.0, p_width, p_height],
            # openinpresentation: 1 → bpatcher shows PRESENTATION mode, not patching view.
            # Only objects with "presentation": 1 are visible — the live.text toggle buttons.
            # Outlet, prepend objects, and patch cables are hidden automatically.
            # bglocked: 1 → prevents accidental editing when opened.
            "bglocked": 1, "openinpresentation": 1,
            "default_fontsize": 12.0, "default_fontface": 0,
            "default_fontname": "Arial",
            "gridonopen": 1, "gridsize": [15.0, 15.0], "gridsnaponopen": 1,
            "boxes": boxes,
            "lines": lines,
            "dependency_cache": [],
        }
    }

    # Compact JSON (no indentation) — avoids Max writestring size limits
    return json.dumps(patch, ensure_ascii=False)


def process_organ(config_path: str):
    """
    Read one organ JSON, extract movable stops, write .maxpat.
    Returns (output_path, stop_count) or None on error.
    """
    data = None
    for enc in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
        try:
            with open(config_path, encoding=enc) as f:
                data = json.load(f)
            break
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    if data is None:
        print(f"  ✗ Cannot read {config_path} (tried utf-8, latin-1, cp1252)")
        return None

    raw_stops = data.get("Stops", [])
    movable   = [(s["StopID"], s["Name"]) for s in raw_stops if s.get("Movable", False)]

    if not movable:
        print(f"  ⚠ No movable stops found — skipping")
        return None

    organ_name  = extract_organ_name(config_path)
    safe_name   = safe_organ_name(organ_name)
    filename    = f"layer_stops_{safe_name}.maxpat"
    output_path = os.path.join(PROJECT_ROOT, filename)

    json_str = generate_maxpat(movable)

    # Python open('w') always truncates — no leftover bytes from previous runs
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(json_str)

    # Verify
    parsed = json.loads(json_str)
    box_count = len(parsed["patcher"]["boxes"])

    return output_path, len(movable), box_count


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Organ stop .maxpat generator")
    print(f"Config dir : {CONFIG_DIR}")
    print(f"Output dir : {PROJECT_ROOT}")
    print()

    config_files = sorted(
        f for f in os.listdir(CONFIG_DIR)
        if f.startswith("organ") and f.endswith(".json")
    )

    if not config_files:
        print("No organ JSON files found.")
        sys.exit(1)

    ok = 0
    for fname in config_files:
        path = os.path.join(CONFIG_DIR, fname)
        organ_name = extract_organ_name(path)
        safe_name  = safe_organ_name(organ_name)
        print(f"  {fname}")
        print(f"    organ name : {organ_name!r}  →  safe: {safe_name!r}")

        result = process_organ(path)
        if result:
            out_path, n_stops, n_boxes = result
            size_kb = os.path.getsize(out_path) / 1024
            print(f"    ✓ {os.path.basename(out_path)}  "
                  f"({n_stops} stops, {n_boxes} boxes, {size_kb:.1f} KB)")
            ok += 1
        print()

    print(f"Done — {ok}/{len(config_files)} organs processed.")
    print()
    print("Generated files (add to git):")
    for fname in config_files:
        path = os.path.join(CONFIG_DIR, fname)
        organ_name = extract_organ_name(path)
        safe_name  = safe_organ_name(organ_name)
        out = os.path.join(PROJECT_ROOT, f"layer_stops_{safe_name}.maxpat")
        if os.path.exists(out):
            print(f"  git add {os.path.relpath(out, PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
