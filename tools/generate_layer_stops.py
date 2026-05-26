#!/usr/bin/env python3
"""
generate_layer_stops.py — Build-time generator for layer stop bpatcher files.

Reads every organ JSON in mapping/config/ and writes a matching
layer_stops_<OrganName>.maxpat into the project root.  Max loads these
via bpatcher @name at runtime — no runtime file generation needed in JS.

Usage:
    python3 tools/generate_layer_stops.py

Run this whenever an organ JSON is added or its stops change.

Reset mechanism (pattr-based, v2):
  JS creates  [pattrforward ::stops_<layerID>::set]  in the layer sub-patcher.
  To cancel:  pattrForwardObj.message(0)
    → pattrforward routes 0  →  pattr "set" inside this bpatcher
    → pattr outlets 0  →  [prepend set]  →  "set 0" to every live.text
    →  all buttons go dark silently (no MaxobjListener fires, no outlet output)
  autopattr @autorestore 0  collects all live.text parameters automatically
  (useful for future preset save/recall via pattrstorage).
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
DIV_GAP_COLS = 1        # empty columns between movable stops and DIV buttons


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


def generate_maxpat(
    movable_stops:  list[tuple],   # [(stopID_int, stopName_str), ...]
    division_stops: list[tuple],   # [(divisionID_int, "DIV<N>"), ...]
) -> str:
    """
    Returns a compact (non-indented) Max patcher JSON string containing:

    Hidden objects (negative Y, outside presentation area):
      - outlet 0          — stop-button clicks (prepend stopID → here)
      - pattr set         — reset target: pattrforward sends 0 here → prepend set → all live.text
      - autopattr         — auto-collects all live.text parameters for pattrstorage
      - prepend set       — converts received 0 → "set 0" (silent value set, no outlet output)
      - prepend <stopID>  — one per stop/div, tags clicks with their ID before outlet

    Visible objects (presentation mode):
      - live.text toggle  — one per movable stop  (varname = "stop<ID>")
      - live.text toggle  — one per division       (varname = "stopdivision<ID>")

    Layout:
      Movable stops fill columns 0 … n (MAX_PER_COL rows each).
      Division buttons start at column (n + DIV_GAP_COLS + 1) for visual separation.

    Reset path:
      JS pattrforward.message(0)
        → pattr "set" receives 0 → outputs 0
        → prepend set → "set 0" to every live.text
        → buttons go dark silently

    Click path:
      live.text outlet → prepend <stopID> → outlet 0
      JS MaxobjListener on each live.text detects the click directly.
    """
    boxes: list[dict] = []
    lines: list[dict] = []

    # ── Hidden infrastructure ─────────────────────────────────────────────────

    # outlet 0 — stop/div click output
    boxes.append({"box": {
        "id": "obj-out", "maxclass": "outlet", "comment": "stop",
        "patching_rect": [10.0, -30.0, 30.0, 30.0],
        "numinlets": 1, "numoutlets": 0,
    }})

    # pattr set — reset target for pattrforward from JS.
    # JS: pattrforward("::stops_<layerID>::set").message(0)  →  this receives 0
    #     →  outputs 0  →  prepend set  →  "set 0" to every live.text
    boxes.append({"box": {
        "id": "obj-pattr", "maxclass": "newobj",
        "text": "pattr set @invisible 1 @autorestore 0",
        "patching_rect": [10.0, -60.0, 210.0, 22.0],
        "numinlets": 2, "numoutlets": 2,
    }})

    # autopattr — automatically registers all live.text parameters.
    # @autorestore 0 — do not restore values on patch load (buttons start off).
    boxes.append({"box": {
        "id": "obj-autopattr", "maxclass": "newobj",
        "text": "autopattr @autorestore 0",
        "patching_rect": [230.0, -60.0, 150.0, 22.0],
        "numinlets": 1, "numoutlets": 1,
    }})

    # prepend set — pattr outlet (a number) → "set <number>" for silent live.text clear
    boxes.append({"box": {
        "id": "obj-prepset", "maxclass": "newobj", "text": "prepend set",
        "patching_rect": [10.0, -90.0, 80.0, 22.0],
        "numinlets": 2, "numoutlets": 1,
    }})

    # Wire: pattr set outlet 0 → prepend set inlet 0
    lines.append({"patchline": {"source": ["obj-pattr", 0], "destination": ["obj-prepset", 0]}})

    # ── Helper: add one live.text + prepend <id> pair ─────────────────────────

    def add_button(i: int, stop_id, stop_name: str, varname: str, col: int, row: int):
        x = float(col * (COL_W + COL_MARGIN))
        y = float(row * STOP_H)
        s_id = f"obj-s{i}"
        p_id = f"obj-p{i}"

        boxes.append({"box": {
            "id": s_id, "maxclass": "live.text",
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect":     [x, y, float(STOP_W), float(STOP_H)],
            "presentation_rect": [x, y, float(STOP_W), float(STOP_H)],
            "presentation": 1,
            "text": stop_name, "texton": stop_name,
            "varname": varname, "fontsize": 10.0,
        }})
        boxes.append({"box": {
            "id": p_id, "maxclass": "newobj",
            "text": f"prepend {stop_id}",
            "patching_rect": [x, -90.0 - i * 25.0, 100.0, 22.0],
            "numinlets": 2, "numoutlets": 1,
        }})
        lines.append({"patchline": {"source": [s_id, 0],        "destination": [p_id, 0]}})
        lines.append({"patchline": {"source": [p_id, 0],        "destination": ["obj-out", 0]}})
        lines.append({"patchline": {"source": ["obj-prepset", 0], "destination": [s_id, 0]}})

    # ── Movable stops ─────────────────────────────────────────────────────────

    seen_ids: set = set()
    row, col = 0, 0

    for i, (stop_id, stop_name) in enumerate(movable_stops):
        # Unique varname — duplicate stopIDs get an index suffix (e.g. Amsterdam)
        if stop_id not in seen_ids:
            seen_ids.add(stop_id)
            varname = f"stop{stop_id}"
        else:
            varname = f"stop{stop_id}_{i}"

        add_button(i, stop_id, stop_name, varname, col, row)

        row += 1
        if row >= MAX_PER_COL:
            col += 1
            row = 0

    # ── Division buttons ──────────────────────────────────────────────────────
    # Start after a visual gap of DIV_GAP_COLS columns.
    # Varname mirrors JS createStopArray: "stop" + stopID  = "stopdivision<ID>"

    if division_stops:
        n_movable_cols = max(1, -(-len(movable_stops) // MAX_PER_COL))  # ceil
        col = n_movable_cols + DIV_GAP_COLS
        row = 0

        for j, (div_id, div_name) in enumerate(division_stops):
            stop_id_str = f"division{div_id}"          # matches JS stopID
            varname     = f"stopdivision{div_id}"       # matches JS "stop" + stopID

            add_button(
                len(movable_stops) + j,
                stop_id_str, div_name, varname,
                col, row,
            )

            row += 1
            if row >= MAX_PER_COL:
                col += 1
                row = 0

    # ── Patcher frame ─────────────────────────────────────────────────────────

    total = len(movable_stops) + len(division_stops)
    n_cols   = max(1, -(-total // MAX_PER_COL)) + (DIV_GAP_COLS if division_stops else 0)
    p_width  = max(600.0, n_cols * (COL_W + COL_MARGIN) + 200.0)
    p_height = max(300.0, MAX_PER_COL * STOP_H + total * 25.0 + 100.0)

    patch = {
        "patcher": {
            "fileversion": 1,
            "appversion": {
                "major": 8, "minor": 6, "revision": 0,
                "architecture": "x64", "modernui": 1,
            },
            "classnamespace": "box",
            "rect": [100.0, 100.0, p_width, p_height],
            # openinpresentation: 1  →  bpatcher shows PRESENTATION mode.
            # Only objects with "presentation": 1 visible — the live.text buttons.
            # Outlet/prepend/pattr/autopattr objects are invisible automatically.
            # bglocked: 1  →  prevents accidental editing.
            "bglocked": 1, "openinpresentation": 1,
            "default_fontsize": 12.0, "default_fontface": 0,
            "default_fontname": "Arial",
            "gridonopen": 1, "gridsize": [15.0, 15.0], "gridsnaponopen": 1,
            "boxes": boxes,
            "lines": lines,
            "dependency_cache": [],
        }
    }

    return json.dumps(patch, ensure_ascii=False)


def process_organ(config_path: str):
    """
    Read one organ JSON, extract movable stops + divisions, write .maxpat.
    Returns (output_path, n_movable, n_divisions, box_count) or None on error.
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

    # Division buttons — mirrors JS parseDivisions() + parseDivisionStops():
    #   Only include divisions that have at least one non-movable stop.
    #   stopID = "division<ID>",  varname = "stopdivision<ID>",  text = "DIV<ID>"
    divs_with_fixed_stops: set = set()
    for s in raw_stops:
        if not s.get("Movable", False):
            div_id = s.get("DivisionID")
            if div_id is not None:
                divs_with_fixed_stops.add(div_id)

    raw_divs  = data.get("Divisions", [])
    divisions = sorted(
        [(d["DivisionID"], f"DIV{d['DivisionID']}") for d in raw_divs
         if d["DivisionID"] in divs_with_fixed_stops],
        key=lambda x: x[0]
    )

    organ_name  = extract_organ_name(config_path)
    safe_name   = safe_organ_name(organ_name)
    filename    = f"layer_stops_{safe_name}.maxpat"
    output_path = os.path.join(PROJECT_ROOT, filename)

    json_str = generate_maxpat(movable, divisions)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(json_str)

    parsed    = json.loads(json_str)
    box_count = len(parsed["patcher"]["boxes"])

    return output_path, len(movable), len(divisions), box_count


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Organ stop .maxpat generator  (pattr reset, v2)")
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
            out_path, n_movable, n_divs, n_boxes = result
            size_kb = os.path.getsize(out_path) / 1024
            print(f"    ✓ {os.path.basename(out_path)}  "
                  f"({n_movable} stops + {n_divs} divs = {n_movable+n_divs} buttons, "
                  f"{n_boxes} boxes, {size_kb:.1f} KB)")
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
