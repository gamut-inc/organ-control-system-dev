# Organ Control System

Software for driving the stop action of pipe organs from a sequencer.

A large organ has a hundred stops or more, and the player cannot change them
while playing — traditionally a second person sits at the console and pulls
them. Electronic setter systems exist, but every organ builder uses a different
control protocol, and those protocols are mostly undocumented. This tool sits
between the sequencer and the console: you work with stop names, it emits
whatever the instrument in front of you understands.

It currently runs a five-manual, 100-stop concert hall organ in rehearsal and
performance.

## Status

**Working prototype, not a product.** It runs as a Max for Live device, which
means it needs Ableton Live Suite (or Live with the Max for Live add-on) — a
commercial dependency that defeats much of the point. Making the core
independent of that host is the next piece of work; see
[docs/ROADMAP.md](docs/ROADMAP.md).

Developed on macOS. The MIDI output relies on a CoreMIDI external, so other
platforms are untested.

## What it speaks

Four ways of addressing a stop, chosen per instrument in its configuration:

| `stopSystem` | how a stop is switched |
|---|---|
| `note` | one MIDI note per stop, velocity 127 on / 0 off |
| `program` | program change, odd number on, even number off (Laukhuff convention) |
| `cc2` | two separate controllers per stop, one for on and one for off |
| `sysex` | the whole registration as one system exclusive dump |

Only `note` has been verified against real hardware over an extended period. The
other three are implemented from documentation and single tests — treat them as
untested until you have run them on your own instrument.

There is also a module for layer-based systems, where stops move between
divisions rather than belonging to a fixed manual.

## Describing an instrument

An organ is described by a JSON file, generated from CSV so that the survey can
be done at the console with paper and pencil:

```
mapping/csv/organ.csv      the instrument itself, and how it is addressed
mapping/csv/manuals.csv    manuals and pedal, with their MIDI channels
mapping/csv/stops.csv      stop name, foot pitch, manual, control address
mapping/csv/controls.csv   swell pedals, crescendo, wind, tremulants
```

```bash
python3 tools/csv_to_organ_json.py
```

The converter builds display names from name and foot pitch ("Principal" + "8" →
`Principal 8'`), resolves on/off address pairs, and **checks for address
collisions** — two stops sharing one address is the most common mistake when
surveying an instrument, and the hardest to notice afterwards.

Two synthetic example instruments are included:
`mapping/config/organ MIDI Example.json` and `organ Laukhuff Example.json`.

> Configurations for real instruments are not part of this repository. They
> describe the internal wiring of specific installations that belong to their
> venues, and they are not ours to publish.

## What it does

- **Registration** — draw stops per manual, couplers, tremulants; panic and
  cancel per manual and globally
- **Presets** — stored with the Live set, so a project carries its own
  registrations; recall by menu, by number, or by incoming MIDI note
- **Note control** — note 0 recalls a preset by velocity, every other note
  switches a stop; an offset covers organs with more than 127 stops
- **Write a registration into a MIDI clip** over the loop range, merging with or
  replacing what is already there
- **Follows the track's MIDI output routing**, so changing "MIDI To" in Live
  redirects the organ

## Layout

```
js/                    the modules; organTool_Universal.js orchestrates
mapping/csv/           instrument survey, as spreadsheets
mapping/config/        generated instrument descriptions
tools/                 the CSV → JSON converter
firmware/              ipMIDI to UART bridge for older consoles
docs/ROADMAP.md        what is planned, and what is known to be wrong
```

## Known limitations

- Requires Max for Live; the organ logic is not yet separable from it
- No automated tests; the boot sequence in particular is verified by hand
- `organTool_Universal.js` does far too many things at once — see the roadmap
- The preset backup file is shared between Live sets, which can carry
  registrations from one set into another

These are stated plainly because the point of the next development step is to
remove them, not to hide them.

## Licence

MIT — see [LICENSE](LICENSE).
