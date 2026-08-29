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

# Column aliases, so a table exported from anywhere still lands in the right field.
# Matching ignores case, spaces, underscores and hyphens.
ALIASES = {
    "stopID":    ["stopid", "id", "nr", "stopnr", "stopnumber"],
    "name":      ["name", "stopname", "register", "bezeichnung"],
    "feet":      ["feet", "foot", "footage", "fuss", "fuß", "pitch", "lage"],
    "manualID":  ["manualid", "manual", "man", "werk", "division"],
    "stopType":  ["type", "stoptype", "kind", "art"],
    "default":   ["default", "defaultvalue", "init", "initial", "standard"],
    "channel":   ["channel", "ch", "stopchannel", "kanal"],
    "onMsg":     ["onmsg", "msgon", "ontype", "typeon", "onmessage", "oncontrolmsg"],
    "onNr":      ["onnr", "nron", "onnumber", "onvalue1", "oncontrolnr", "oncc", "onnote"],
    "onValue":   ["onvalue", "valueon", "onvel", "onvelocity", "ondata"],
    "offMsg":    ["offmsg", "msgoff", "offtype", "typeoff", "offmessage", "offcontrolmsg"],
    "offNr":     ["offnr", "nroff", "offnumber", "offvalue1", "offcontrolnr", "offcc", "offnote"],
    "offValue":  ["offvalue", "valueoff", "offvel", "offvelocity", "offdata"],
    "msg":       ["msg", "controlmsg", "type", "message"],
    "nr":        ["nr2", "controlnr", "number", "cc", "note"],
}


def norm(key):
    """Normalise a column header for alias matching."""
    return (key or "").strip().lower().replace(" ", "").replace("_", "").replace("-", "")


def pick(row, field):
    """Value of `field` in `row`, honouring the alias table. '' when absent."""
    wanted = ALIASES.get(field, [field.lower()])
    for key, value in row.items():
        if norm(key) in wanted:
            return (value or "").strip()
    return ""


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


def build_stop_name(row):
    """Join name and feet into one label, adding the foot mark: Principal + 8 → Principal 8'"""
    name = pick(row, "name")
    feet = pick(row, "feet")
    if not feet:
        return name
    feet = feet.strip()
    # Leave an already-marked or non-numeric footage alone (16', III, 2 2/3')
    if not feet.endswith("'") and not feet.endswith("’"):
        feet += "'"
    return ("%s %s" % (name, feet)).strip()


def build_address(row, side, default_channel):
    """
    One end of a stop's wiring, or None when the table does not describe it.

    side is "on" or "off".  Consoles differ in how they address a stop: one note
    with velocity 127/0, two separate CCs, two program changes (Laukhuff's odd/even).
    Describing each end separately covers all of them, so the module does not need
    to know which console it is talking to.
    """
    msg = pick(row, side + "Msg") or pick(row, "msg")
    nr = pick(row, side + "Nr")
    if not nr and not msg:
        return None
    if not nr:
        nr = pick(row, "nr")
    if nr == "":
        return None

    value = pick(row, side + "Value")
    msg = (msg or "note").lower()
    if value == "":
        # Sensible default per message type: notes/CCs use 127 for on, 0 for off;
        # program changes carry no value at all.
        value = 127 if side == "on" else 0
    else:
        value = int(float(value))

    try:
        nr = int(float(nr))
    except ValueError:
        sys.exit("row %r: %sNr is not a number: %r" % (row, side, nr))

    address = {"msg": msg, "nr": nr, "value": value}
    channel = pick(row, "channel")
    if channel:
        address["channel"] = int(float(channel))
    elif default_channel is not None:
        address["channel"] = default_channel
    return address


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
    manual_stop_channel = {m["manualID"]: m.get("stopChannel") for m in organ["manuals"]}
    explicit_pairs = 0

    for row in stop_rows:
        raw_id = pick(row, "stopID")
        if raw_id == "":
            sys.exit("stops.csv: every row needs a stopID (offending row: %r)" % row)
        sid = int(float(raw_id))

        raw_mid = pick(row, "manualID")
        mid = int(float(raw_mid)) if raw_mid else 0
        if mid not in known_manual_ids:
            sys.exit("stops.csv: stop %d references manualID %s, which manuals.csv "
                     "does not define" % (sid, mid))

        stop = {
            "stopID": sid,
            "name": build_stop_name(row) or ("Stop %d" % sid),
            "manualID": mid,
        }

        # "coupler" moves the stop into a separate, greyed column at the end of the
        # manual — couplers are not registers and should not read as ones.
        stop_type = pick(row, "stopType").lower()
        if stop_type:
            stop["type"] = stop_type

        # Explicit on/off addresses win: they describe any console exactly.
        default_channel = manual_stop_channel.get(mid)
        on = build_address(row, "on", default_channel)
        off = build_address(row, "off", default_channel)

        # When on and off are DIFFERENT numbers, the number itself carries the
        # meaning (Casavant's two controllers, Laukhuff's odd/even programs), so the
        # off message is a trigger and must not be sent as "value 0" — that would be
        # a no-op on most consoles.  Same number = note on/off, where 0 is the point.
        if on and off and on["nr"] != off["nr"] and pick(row, "offValue") == "":
            off["value"] = 127

        if on or off:
            if on:
                stop["on"] = on
            if off:
                stop["off"] = off
            explicit_pairs += 1
        else:
            # Otherwise fall back to the per-system override columns
            for key in STOP_OPTIONAL:
                val = as_int(row, key)
                if val is not None:
                    stop[key] = val

        organ["stops"].append(stop)

    if explicit_pairs:
        organ.setdefault("midi", {})["stopSystem"] = "explicit"
        print("  note: %d stop(s) carry explicit on/off addresses → stopSystem "
              "set to \"explicit\"" % explicit_pairs)

    # --- controls.csv ---
    controls = []
    for row in control_rows:
        cid = as_int(row, "controlID")
        if cid is None:
            continue
        control = {
            "controlID": cid,
            "name":      row.get("controlName") or row.get("name") or ("Control %d" % cid),
            "type":      (row.get("type") or "wheel").lower(),
            "manual":    as_int(row, "manual", 0),
            "channel":   as_int(row, "channel", 1),
            "msg":       (row.get("controlMsg") or row.get("msg") or "CC").upper(),
            "nr":        as_int(row, "controlNr", as_int(row, "nr", 0)),
        }
        # Resting position CANCEL returns this control to. Usually 0, but a wind
        # throttle sits open at 127 — cancelling a registration must not close it.
        default = pick(row, "default")
        control["default"] = int(float(default)) if default else 0
        controls.append(control)
    if controls:
        organ["controls"] = controls

    return organ


def check_collisions(organ):
    """
    Warn when two stops would send the identical message.

    This is the mistake that silently breaks an organ: put every manual on the same
    stopChannel and let each manual number its stops from zero, and the fourth
    manual's Principal now speaks the pedal's Subbass.  Cheap to check, invisible
    otherwise until you hear it.
    """
    system = organ["midi"].get("stopSystem", "note")
    manual_channel = {m["manualID"]: m.get("stopChannel") for m in organ["manuals"]}
    manual_name = {m["manualID"]: m["name"] for m in organ["manuals"]}
    seen = {}
    clashes = []

    for stop in organ["stops"]:
        channel = stop.get("stopChannel") or manual_channel.get(stop["manualID"])
        if "on" in stop:
            addr = stop["on"]
            key = (addr.get("channel", channel), addr["msg"], addr["nr"])
        elif system == "cc":
            key = (channel, "cc", stop.get("midiCC", stop["stopID"]))
        elif system in ("cc2", "program", "sysex", "explicit"):
            continue  # addressed per stop, or not addressed individually at all
        else:
            key = (channel, "note", stop.get("midiNote", stop["stopID"]))

        if key in seen:
            clashes.append((seen[key], stop, key))
        else:
            seen[key] = stop

    if not clashes:
        return

    print()
    print("  WARNING: %d stop(s) share an address with another stop —" % len(clashes))
    print("  they will speak together. Give each manual its own stopChannel, or make")
    print("  the numbers unique across the whole organ.")
    for first, second, key in clashes[:8]:
        print("    ch %-3s %-4s %-4s  %s: %s  ==  %s: %s" % (
            key[0], key[1], key[2],
            manual_name.get(first["manualID"], first["manualID"]), first["name"],
            manual_name.get(second["manualID"], second["manualID"]), second["name"]))
    if len(clashes) > 8:
        print("    … and %d more" % (len(clashes) - 8))


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
    check_collisions(organ)


if __name__ == "__main__":
    main()
