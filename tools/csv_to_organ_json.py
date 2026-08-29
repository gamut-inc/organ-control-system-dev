#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
csv_to_organ_json.py — build an organ JSON for organTool_MIDI.js from CSV tables.

The CSVs are the master copy: they open in Excel / Numbers / any spreadsheet, sort
and fill down like normal tables, and diff cleanly in git.  Run this after editing
them to regenerate the JSON the Max patch loads.

USAGE
    python3 tools/csv_to_organ_json.py mapping/csv "mapping/config/organ Grosse Orgel.json"
    python3 tools/csv_to_organ_json.py mapping/csv          # writes <name>.json next to the CSVs

INPUT  (in the given directory)
    organ.csv     key,value                     — one setting per row (see KNOWN_KEYS)
    manuals.csv   manualID,name,midiChannel,stopChannel
    stops.csv     stopID,name,manualID[,midiNote,midiCC,ccOn,ccOff,programOn,programOff,stopChannel]
    controls.csv  controlID,controlName,type,manual,channel,controlMsg,controlNr

  Only organ.csv's `name` and the three tables' first columns are mandatory; every
  optional stop column may be left out entirely or left blank per row, in which case
  organTool_MIDI.js derives the address itself.

CHANNELS
    midiChannel  = key action — the channel the manual's NOTES arrive on.  Panic
                   messages go here, because that is what silences sounding pipes.
    stopChannel  = stop output — the channel REGISTER commands are sent on.
                   Deliberately separate; consoles rarely use the same numbers.

CONTROLS
    type "wheel" (or anything not a panic) becomes a dial in that manual.
    type "button" whose name contains "panic" is not drawn: it defines what the
    already-existing PANIC button of that manual sends.
    manual 0 means global — dials land in the header, panics on the global button.
"""

import csv
import json
import os
import sys

KNOWN_KEYS = {
    # organ.csv key            → where it goes in the JSON
    "name":            ("root", "name"),
    "stopSystem":      ("midi", "stopSystem"),
    "outputFormat":    ("midi", "outputFormat"),
    "panicMethod":     ("midi", "panicMethod"),
    "stopChannelBase": ("midi", "stopChannelBase"),
    "programBase":     ("midi", "programBase"),
}

# Optional per-stop overrides — emitted only when the cell holds a value
STOP_OPTIONAL = ["midiNote", "midiCC", "ccOn", "ccOff",
                 "programOn", "programOff", "stopChannel"]


def read_csv(path, required=True):
    """Read a CSV into a list of dicts; tolerate a missing optional file."""
    if not os.path.exists(path):
        if required:
            sys.exit("missing required file: %s" % path)
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [
            {(k or "").strip(): (v or "").strip() for k, v in row.items()}
            for row in csv.DictReader(f)
        ]


def as_int(row, key, default=None):
    """Integer cell, or default when absent/blank. Errors name the offending row."""
    raw = row.get(key, "")
    if raw == "":
        return default
    try:
        return int(float(raw))
    except ValueError:
        sys.exit("row %r: column %s is not a number: %r" % (row, key, raw))


def build(csv_dir):
    organ_rows = read_csv(os.path.join(csv_dir, "organ.csv"), required=False)
    manual_rows = read_csv(os.path.join(csv_dir, "manuals.csv"))
    stop_rows = read_csv(os.path.join(csv_dir, "stops.csv"))
    control_rows = read_csv(os.path.join(csv_dir, "controls.csv"), required=False)

    organ = {"name": "Organ", "midi": {}, "manuals": [], "stops": []}

    # --- organ.csv: key/value settings ---
    for row in organ_rows:
        key, value = row.get("key", ""), row.get("value", "")
        if not key or value == "":
            continue
        if key not in KNOWN_KEYS:
            print("  note: ignoring unknown organ.csv key %r" % key)
            continue
        where, name = KNOWN_KEYS[key]
        target = organ if where == "root" else organ["midi"]
        target[name] = int(value) if value.lstrip("-").isdigit() else value

    # --- manuals.csv ---
    known_manual_ids = set()
    for row in manual_rows:
        mid = as_int(row, "manualID")
        if mid is None:
            sys.exit("manuals.csv: every row needs a manualID (offending row: %r)" % row)
        known_manual_ids.add(mid)
        manual = {"manualID": mid, "name": row.get("name") or ("Manual %d" % mid)}
        for key in ("midiChannel", "stopChannel"):
            val = as_int(row, key)
            if val is not None:
                manual[key] = val
        organ["manuals"].append(manual)

    # --- stops.csv ---
    for row in stop_rows:
        sid = as_int(row, "stopID")
        if sid is None:
            sys.exit("stops.csv: every row needs a stopID (offending row: %r)" % row)
        mid = as_int(row, "manualID", 0)
        if mid not in known_manual_ids:
            sys.exit("stops.csv: stop %d references manualID %s, which manuals.csv "
                     "does not define" % (sid, mid))
        stop = {"stopID": sid, "name": row.get("name") or ("Stop %d" % sid), "manualID": mid}
        for key in STOP_OPTIONAL:
            val = as_int(row, key)
            if val is not None:
                stop[key] = val
        organ["stops"].append(stop)

    # --- controls.csv ---
    controls = []
    for row in control_rows:
        cid = as_int(row, "controlID")
        if cid is None:
            continue
        controls.append({
            "controlID": cid,
            "name":      row.get("controlName") or row.get("name") or ("Control %d" % cid),
            "type":      (row.get("type") or "wheel").lower(),
            "manual":    as_int(row, "manual", 0),
            "channel":   as_int(row, "channel", 1),
            "msg":       (row.get("controlMsg") or row.get("msg") or "CC").upper(),
            "nr":        as_int(row, "controlNr", as_int(row, "nr", 0)),
        })
    if controls:
        organ["controls"] = controls

    return organ


def summarise(organ):
    per_manual = {}
    for stop in organ["stops"]:
        per_manual[stop["manualID"]] = per_manual.get(stop["manualID"], 0) + 1

    print("  %-14s %s" % ("organ:", organ["name"]))
    print("  %-14s %s" % ("stop system:", organ["midi"].get("stopSystem", "note")))
    print("  %-14s %s" % ("output:", organ["midi"].get("outputFormat", "raw")))
    for manual in organ["manuals"]:
        print("  manual %-3s %-14s keys ch %-3s stops ch %-3s %d stops" % (
            manual["manualID"], manual["name"],
            manual.get("midiChannel", "-"), manual.get("stopChannel", "-"),
            per_manual.get(manual["manualID"], 0)))

    panics = [c for c in organ.get("controls", [])
              if c["type"] == "panic" or (c["type"] == "button" and "panic" in c["name"].lower())]
    wheels = [c for c in organ.get("controls", []) if c not in panics]
    if wheels:
        print("  %-14s %s" % ("dials:", ", ".join(
            "%s (man %s, %s%s ch%s)" % (c["name"], c["manual"], c["msg"], c["nr"], c["channel"])
            for c in wheels)))
    if panics:
        print("  %-14s %d definitions attached to the PANIC buttons" % ("panics:", len(panics)))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    csv_dir = sys.argv[1]
    organ = build(csv_dir)

    if len(sys.argv) > 2:
        out_path = sys.argv[2]
    else:
        out_path = os.path.join(csv_dir, "organ %s.json" % organ["name"])

    out_dir = os.path.dirname(out_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(organ, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print("wrote %s" % out_path)
    summarise(organ)


if __name__ == "__main__":
    main()
