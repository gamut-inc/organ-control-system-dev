# ORGAN CONTROL SYSTEM — CLAUDE.md

## Project Overview

Max/MSP JavaScript system for controlling pipe organs via two protocols:
- **SINUA** organs → OSC over UDP
- **MIDI** organs → MIDI messages (NoteOn/Off, CC, ProgChange, SysEx)

Single unified GUI for both organ types, loaded dynamically from JSON config files.

## Architecture

```
OrganPatch_2026.amxd           ← Main Ableton Live device (entry point)
├── MuteAndSoloSafe.maxpat     ← Ableton track mute/solo safety gate (at root)
├── js/organTool_Universal.js  ← JS orchestrator (amxd uses patcherrelativepath: ./js)
│   ├── js/organTool_Common.js
│   ├── js/organTool_DataLayer.js
│   ├── js/organTool_ProtocolLayer.js
│   ├── js/organTool_SINUA.js
│   └── js/organTool_GEOMETRY.js
│
Max subpatchers (root, found by name):
  Colors.maxpat          ← GUI color palette data
  cancel.maxpat          ← OSC cancel commands (/M1/L%d/D,S)
  collectStops.maxpat    ← Stop state collector (pattr-based)
  gamut_storage.maxpat   ← Preset/dict storage (needs gamut_storage.js!)
  layer.maxpat           ← Division/stop layout (refs collectStops.maxpat)
```

## Folder Structure

```
organ-control-system-claudecode/
├── OrganPatch_2026.amxd          ← Ableton Live device
├── MuteAndSoloSafe.maxpat        ← at root (hardcoded in amxd)
├── Colors.maxpat
├── cancel.maxpat
├── collectStops.maxpat
├── gamut_storage.maxpat          ← needs gamut_storage.js (TODO)
├── layer.maxpat
├── js/                           ← JS modules (amxd expects ./js/)
│   ├── organTool_Universal.js
│   ├── organTool_Common.js
│   ├── organTool_DataLayer.js
│   ├── organTool_ProtocolLayer.js
│   ├── organTool_SINUA.js
│   └── organTool_GEOMETRY.js
├── mapping/
│   ├── config/                   ← Organ JSON configs
│   │   ├── organ Kunststation.json
│   │   ├── organ Malmö.json
│   │   ├── organ Oberkassel.json
│   │   ├── organ amsterdam.json
│   │   ├── organ ratingen.json
│   │   └── console.json
│   ├── mapping_KunstStation_2025.csv
│   └── mapping_KunstStation_2025.xls
├── test/
│   ├── fixtures/
│   └── manual-tests.md
└── docs/
```

## Max/MSP Path Rules — IMPORTANT

The amxd has **hardcoded relative paths** (patcherrelativepath). Do NOT move:
- `MuteAndSoloSafe.maxpat` — must stay at root (amxd path: `.`)
- `js/` folder — must stay as `./js/` next to the amxd
- All other `.maxpat` files stay at root so Max finds them by name search

`layer.maxpat` references `collectStops.maxpat` by name → must be in same folder.
`gamut_storage.maxpat` references `gamut_storage.js` and `relative_paths.maxpat` → **both missing, need to be added to root or js/**.

## Missing Files (TODO)

- `js/gamut_storage_menu.js` — required by `gamut_storage.js` via `require()`
- `js/gamut_storage_chains.js` — required by `gamut_storage.js` via `require()`

## Two JS Runtimes in Use

This project uses **two different Max JS runtimes** — they have different rules:

| File | Object | Runtime | Style |
|---|---|---|---|
| `js/organTool_*.js` | `js` | JavaScriptCore (old) | ES5, `var`, `post()`, no `require()` |
| `js/gamut_storage.js` | `v8` | V8 (Max 8+) | ES6+, `require()`, `let/const` ok |

**Do not mix patterns** — `require()` in a `js` object crashes, `include()` doesn't exist in `v8`.

**No external build system. No npm. No transpilation.**
All files are plain ES5-compatible JavaScript for the Max/MSP `js` object (JavaScriptCore).

## Key Constraints

- **Runtime**: Max/MSP `js` object — NOT Node.js, NOT browser
- **ES5 only**: no `let/const`, no arrow functions, no template literals, no classes, no modules
- **`var` everywhere**: function-scoped only
- **Module pattern**: every module exports via `createXxxModule()` factory function returning a plain object
- **Dependency injection**: modules receive their dependencies as constructor arguments (no globals shared between modules)
- **`autowatch = 1`**: must appear at top of every file (enables live-reload in Max)
- **`post()`**: use instead of `console.log()` — Max's logging function
- **No `require()`**: files are loaded via Max's `js` object; use `createXxxModule()` pattern

## Module Interface Pattern

```javascript
// Standard module factory — every file follows this
autowatch = 1;

function createFooModule(common, dataLayer) {   // deps injected
    // private state
    var state = {};

    function publicMethod() { ... }

    return {                                    // public API
        publicMethod: publicMethod
    };
}
```

## State Model (g_organState)

```javascript
g_organState = {
    type: "SINUA" | "MIDI",
    stops: { <id>: { state: true|false, divisionID: <n> } },
    tremulants: { <id>: { active: true|false, speed: 0-127 } },
    controllers: { <id>: { value: 0-127 } },
    presets: { current: "<name>", loading: false }
}
```

## Protocol Commands

**SINUA (OSC)**
- `/stop/<id> <0|1>`
- `/tremulant/<id>/speed <0-127>`
- `/controller/<id> <0-127>`
- `/division/<id>/preset <stopList>`

**MIDI**
- Stop: NoteOn/Off, CC, ProgChange, or SysEx (determined by organ JSON)
- Channel routing: Division N → MIDI Ch N, Couplers → Ch 16

## Organ JSON Format

Two formats detected automatically:
- **SINUA JSON**: has `divisions[]` with `stops[]`, `tremulants[]`, `controllers[]`, `transmissions[]`
- **MIDI JSON**: has `manuals[]` with `stops[]`, `couplers[]`, `pistons[]`, `midiChannels`

## Coding Conventions

- All `var`, no `let`/`const`
- Function declarations, not arrow functions
- String concatenation with `+`, not template literals
- `post("message\n")` for logging (not console.log)
- Error handling: always check return values, use `try/catch` where Max API calls can throw
- Comment style: `// ====...====` section separators, inline comments for non-obvious logic
- Log via `common.log(common.LOG_LEVEL.INFO, "message")`
- Log levels: ERROR=0, WARN=1, INFO=2, VERBOSE=3, DEBUG=4

## Testing Approach

No test framework available in Max/MSP environment.
- Mock organ JSON files in `test/fixtures/`
- Manual test sequences documented in `test/manual-tests.md`
- Use `MOCK_MODE = true` in Universal.js to test without hardware
- `getSystemHealth()` and `displaySystemStatus()` are runtime introspection tools

## Key Functions (Universal.js entry points)

```
loadOrgan(path)           ← load organ JSON, build GUI
selectOrganFile()         ← file dialog → loadOrgan
setStopState(id, value)   ← toggle a stop
setTremulantState(id, v)  ← toggle tremulant
executeContextCommand(cmd) ← piston/coupler/preset commands
panic()                   ← all stops off, clear queue
resetSystem()             ← re-init state, clear queues
displaySystemStatus()     ← post system info to Max console
getSystemHealth()         ← returns health object
```

## File Naming

`organTool_<Module>.js` — capital first letter of module name.

## Development Phases (current status)

- [x] Phase 1: Parsing & unified data model
- [x] Phase 2: State management & command queue
- [x] Phase 3: Protocol layer (SINUA + MIDI)
- [ ] Phase 4: Crossfade presets, full MIDI SysEx, hardware testing

## Do Not

- Do not use ES6+ syntax — Max/MSP will throw syntax errors
- Do not use `require()` or `import`
- Do not add Node.js dependencies
- Do not use `console.log` — use `post()`
- Do not add a build step
