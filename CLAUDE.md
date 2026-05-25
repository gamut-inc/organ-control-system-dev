# ORGAN CONTROL SYSTEM — CLAUDE.md

## Project Overview

Max/MSP JavaScript system for controlling pipe organs via two protocols:
- **SINUA** organs → OSC over UDP
- **MIDI** organs → MIDI messages (NoteOn/Off, CC, ProgChange, SysEx)

Single unified GUI for both organ types, loaded dynamically from JSON config files.

## Architecture

```
organTool_Universal.js   ← Entry point / orchestrator (Max patcher loads this)
organTool_Common.js      ← Logging, utilities, geometry constants, object management
organTool_DataLayer.js   ← State model (g_organState), command queue, preset management
organTool_ProtocolLayer.js ← Protocol abstraction (SINUA/MIDI dispatching)
organTool_SINUA.js       ← SINUA-specific parser, GUI builder, OSC command sender
organTool_GEOMETRY.js    ← Layout constants (column widths, stop heights, positions)
```

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
