// organTool_MIDI.js - Traditional MIDI organ module (NO layers, NO moving stops)
// 00.01 - Initial version for the midi-organ branch.
// 00.02 - Manuals start 50px lower; reversed order (highest manual first, pedal last).
//         PANIC (red) above CANC in every manual, both offset 2px right.
//         Global PANIC + CANCEL in the header at the same x as the manual buttons.
//         Stop colouring (reed/aliquot) same as SINUA.
//         Pluggable stop-output systems: note | cc | cc2 | program (Laukhuff) | sysex.
//         Stop output channels are independent of the key-action (note) channels.
// 00.03 - RAW MIDI output by default: the js outlet feeds [multichanmidiout] directly,
//         so messages must be status + data bytes, not tagged lists.  midi.outputFormat
//         "tagged" restores the old ("midi", "note", …) form for patches that route it.
//         Controls table support (see CONTROLS below): dials per manual / global,
//         and panic definitions that drive the existing PANIC buttons.
// 00.04 - Fixed the suppression Task being garbage-collected: it is now held at module
//         scope.  A Task referenced only by a local variable can be collected before it
//         fires, which left _suppressListeners stuck true — every later stop click
//         returned early, so CANCEL worked only sometimes and store captured nothing.
//         Output format "named" is now the default: <note|cc|pc|poly> ch nr value.
//         Controller dials: own reserved column (so every manual, pedal included, is
//         indented alike), "tiny" appearance, wider, names cropped at 9 chars.
//         Controller values are captured into presets and restored on recall.
//         Stops hug the manual's top and bottom edge (stopPadTop/Bottom).
//         Explicit per-stop on/off addresses ("explicit" system) — see STOP SYSTEMS.
//         handleStopEvent now updates the button and the cache, so a stop moved from
//         outside the GUI is visible and gets captured.
// 29.08.2026
//
// TARGET: traditional pipe organs with MIDI interface — every stop belongs to
// exactly ONE manual (fixed disposition, like the physical console).  There are
// no layers, no movable stops, no division routing, no SINUA OSC.
//
// ================================================================================================
// ORGAN JSON FORMAT (lowercase keys → detectOrganType() returns "MIDI")
// ================================================================================================
// {
//   "name": "St. Marien",
//   "midi": {
//     "stopSystem":      "note",   // note | cc | cc2 | program | sysex   (see below)
//     "stopChannelBase": 11,       // first stop-output channel; manuals count up from here
//     "panicMethod":     "cc123",  // cc123 | allnotesoff
//     "sysex": { "header": [240, 126, 0], "footer": [247] }   // only for stopSystem "sysex"
//   },
//   "manuals": [
//     // midiChannel = KEY ACTION channel (notes played on the manual)
//     // stopChannel = STOP OUTPUT channel (optional; default stopChannelBase + index)
//     { "manualID": 0, "name": "Pedal",     "midiChannel": 1, "stopChannel": 11 },
//     { "manualID": 1, "name": "Hauptwerk", "midiChannel": 2, "stopChannel": 12 }
//   ],
//   "stops": [
//     { "stopID": 1, "name": "Principal 8'", "manualID": 1, "midiNote": 36 }
//   ]
// }
//
// ================================================================================================
// STOP OUTPUT SYSTEMS  (midi.stopSystem) — the console-specific half of the system.
// ================================================================================================
// The GUI, presets and panic behaviour stay identical across all of them; only the
// bytes on the wire change.  Every derived value can be overridden per stop.
//
//  "note"     Standard consoles: note on/off per stop.
//             per stop: midiNote (default: stopID)            velocity 127 / 0
//
//  "cc"       Single CC per stop, 127 = on, 0 = off.
//             per stop: midiCC (default: stopID)
//
//  "cc2"      Casavant Frères style: two SEPARATE CCs — one addresses "on",
//             the other "off"; both are sent with value 127.
//             per stop: ccOn / ccOff  (default: 2*i, 2*i+1 within the manual)
//
//  "program"  Laukhuff style: program changes, ODD number = on, EVEN = off.
//             per stop: programOn / programOff
//             (default: programBase + 2*i + 1 / programBase + 2*i)
//
//  "sysex"    Whole-organ state dump: every stop change re-sends one SysEx message
//             containing a bit for every stop in JSON order.
//             midi.sysex.header / .footer are raw byte arrays (default F0 … F7).
//             Bits are packed 7 per byte (MIDI data bytes must stay < 128).
//
//  "explicit" Each stop carries its own two addresses — the general case that covers
//             every console above without the module having to know which one it is:
//               "on":  { "msg": "cc", "channel": 11, "nr": 20, "value": 127 },
//               "off": { "msg": "cc", "channel": 11, "nr": 21, "value": 127 }
//             A stop's on/off pair overrides the organ's nominal system, whatever it
//             is, so a single organ may mix addressing styles.  tools/csv_to_organ_json.py
//             builds these from onMsg/onNr/offMsg/offNr columns.
//
// ================================================================================================
// CONTROLS  (organ JSON "controls" array)
// ================================================================================================
// Mirrors the console's control table one row per entry:
//   { "controlID": 1, "name": "Schweller", "type": "wheel",
//     "manual": 4, "channel": 11, "msg": "CC", "nr": 9 }
//
//   type "wheel" (anything not a panic) → live.dial under the manual's CANC button,
//        sending msg/nr on `channel` with the dial value 0..127
//   type "button" whose name contains "panic" (or type "panic") → NOT drawn; it defines
//        what the PANIC button of that manual sends.  This is how a console declares
//        that a single CC123 on its own channel silences the manual, so no 128 note-offs.
//   manual 0 (or a manualID no manual claims) → global: dials go in the header,
//        panics fire from the global PANIC button.  channel 0 on a global panic means
//        "send on every manual's key-action channel".
//
// Dials fill one column below CANC before starting the next; the stop grid shifts right
// by exactly those columns.  Past midi.ctrlMaxCols the manual grows taller instead.
//
// ================================================================================================
// MIDI OUTPUT via outlet 0 — midi.outputFormat
// ================================================================================================
//  "named" (default)  <type> channel number value, one message per line:
//                         note 11 60 127     cc 11 9 64     pc 12 41     poly 11 60 80
//                         sysex 240 … 247
//                     Channels are 1..16, data 0..127; both are clamped.
//
//  "raw"              Status byte + data bytes, for [midiout] / [multichanmidiout]
//                     wired straight to the js outlet:
//                         note → (143 + ch), control → (175 + ch),
//                         program → (191 + ch), poly → (159 + ch), sysex → 240 … 247
//
//  "tagged"           ("midi", "note"|"cc"|"program"|"poly"|"sysex", channel, …) for
//                     patches that route the message themselves:
//                         [route midi] → [route note cc program] → noteout / ctlout / …
//
// PUBLIC API (same interface as organTool_SINUA.js):
//   loadOrgan, clearGUI, getCurrentOrganInfo, handleStopEvent,
//   capturePreset, recallPreset, getPresetMenu

function createMIDIModuleWithDI(common, dataLayer, context) {

    // ================================================================================================
    // LAYOUT CONSTANTS
    // ================================================================================================

    var LAYOUT = {
        manualX:      5,    // manual bpatcher x in the main patcher
        btnX:         2,    // buttons inside a manual subpatcher (2px off the edge)
        btnW:        45,
        btnH:        20,
        btnGap:       5,    // vertical gap between PANIC and CANC
        headerY:     10,    // organ name label
        globalPanicY: 45,   // global PANIC — same x as the manual CANC buttons
        manualsY:    95,    // first manual (50px lower than the 45 of v00.01)
        manualGap:    8,
        labelH:      18,    // manual name, top of the left column
        stopPadTop:   4,    // small breathing room above the first stop …
        stopPadBottom: 4,   // … and below the last one
        // Controller dials get their OWN column, always — even for a manual that has
        // none.  That keeps every manual (pedal included) indented identically, and
        // the stop grid starts past the reserved columns.
        ctrlW:       62,    // wide enough to read a name next to a tiny dial
        ctrlH:       22,    // "tiny" appearance is short
        ctrlColW:    66,
        ctrlMaxCols:  2,    // beyond this the manual grows taller instead of wider
        ctrlNameMax:  9     // crop at the length of "Tremulant"
    };
    // Global CANCEL sits directly below the global PANIC, same proportions as in the manuals
    LAYOUT.globalCancelY = LAYOUT.globalPanicY + LAYOUT.btnH + LAYOUT.btnGap;
    // Left column inside a manual: name, then PANIC, then CANC
    LAYOUT.manualPanicY  = LAYOUT.labelH;
    LAYOUT.manualCancelY = LAYOUT.labelH + LAYOUT.btnH + LAYOUT.btnGap;
    // Height the left column needs on its own
    LAYOUT.manualMinH    = LAYOUT.manualCancelY + LAYOUT.btnH + LAYOUT.stopPadBottom;

    // ================================================================================================
    // STATE
    // ================================================================================================

    var organState = {
        name: "No Organ Loaded",
        filepath: null,
        manuals: [],        // [{manualID, name, midiChannel, stopChannel, stops: [...]}] — JSON order
        displayOrder: [],   // same objects, GUI order (highest manual first, pedal last)
        stopsByID: {},      // {stopID: stop}
        allStops: [],       // JSON order — defines the SysEx bit order
        stopSystem: "note",
        outputFormat: "named",
        controlValues: {},   // {controlID: last value} — captured into presets
        panicMethod: "cc123",
        sysex: { header: [240], footer: [247] },
        // Controls from the organ JSON, split by role and scope.
        // manual 0 (or a manualID no manual claims) means "global".
        wheelsByManual: {},  // {manualID: [control, ...]} — continuous, drawn as live.dial
        globalWheels:   [],
        panicsByManual: {},  // {manualID: [control, ...]} — wired to the manual PANIC button
        globalPanics:   []
    };

    var guiObjects = {};
    var listeners  = [];
    // When true, MaxobjListener callbacks do nothing (silent GUI updates during
    // cancel/recall).  btn.message("set", ...) fires listeners ASYNCHRONOUSLY,
    // so the flag is released via a 10ms Task, never synchronously.
    var _suppressListeners = false;
    // Module-scope so Max cannot garbage-collect it mid-flight — see releaseSuppression()
    var _suppressTask = null;

    // ================================================================================================
    // STOP COLOURING  (same classification as SINUA so both systems look alike)
    // ================================================================================================

    var STOP_REED_KEYWORDS = [
        "trompet", "posaune", "schalmei", "schalmey",
        "clarin", "klarinett",
        "tuba", "hautbois", "haubois", "regal", "krummhorn", "krumhorn",
        "fagott", "vox humana", "oboe", "zinke", "dulzian", "dulcian",
        "bombardon", "chamade"
    ];

    function stopColorClass(name) {
        if (!name) return "normal";
        var n = name.toLowerCase();
        for (var i = 0; i < STOP_REED_KEYWORDS.length; i++) {
            if (n.indexOf(STOP_REED_KEYWORDS[i]) >= 0) return "reed";
        }
        // Aliquot: fractional pitch — a digit immediately followed by "/" then a digit
        if (/\d\/\d/.test(name)) return "aliquot";
        return "normal";
    }

    function applyStopColor(liveTextObj, colorClass) {
        try {
            if (colorClass === "reed") {
                liveTextObj.setattr("activebgcolor",     1.0, 0.0, 0.0, 0.2);
                liveTextObj.setattr("activebgoncolor",   1.0, 0.0, 0.0, 1.0);
                liveTextObj.setattr("activetextoncolor", 1.0, 1.0, 1.0, 1.0);
            } else if (colorClass === "aliquot") {
                liveTextObj.setattr("activebgcolor",     0.0, 0.57, 0.57, 0.2);
                liveTextObj.setattr("activebgoncolor",   0.0, 1.0,  1.0,  1.0);
                liveTextObj.setattr("activetextoncolor", 0.0, 0.0,  0.0,  1.0);
            }
            // "normal" → Max defaults
        } catch(e) {
            post("applyStopColor: setattr failed: " + e + "\n");
        }
    }

    // PANIC buttons are red in both states so they read as the emergency control.
    function applyPanicColor(liveTextObj) {
        try {
            liveTextObj.setattr("bgcolor",           0.75, 0.1,  0.1,  1.0);
            liveTextObj.setattr("textcolor",         1.0,  1.0,  1.0,  1.0);
            liveTextObj.setattr("activebgcolor",     0.75, 0.1,  0.1,  1.0);
            liveTextObj.setattr("activebgoncolor",   1.0,  0.25, 0.25, 1.0);
            liveTextObj.setattr("activetextcolor",   1.0,  1.0,  1.0,  1.0);
            liveTextObj.setattr("activetextoncolor", 1.0,  1.0,  1.0,  1.0);
        } catch(e) {
            post("applyPanicColor: setattr failed: " + e + "\n");
        }
    }

    // ================================================================================================
    // MIDI OUTPUT — pluggable stop systems
    // ================================================================================================

    // --- Wire format ---------------------------------------------------------------
    // "raw" (default): status byte + data bytes, which is what [multichanmidiout]
    //                  and [midiout] expect — the js outlet feeds one of those directly.
    // "tagged":        ("midi", "note"|"cc"|"program"|"sysex", ...) for patches that
    //                  route the message themselves before formatting it.

    function clampCh(ch) {
        ch = Math.round(Number(ch) || 1);
        if (ch < 1)  return 1;
        if (ch > 16) return 16;
        return ch;
    }
    function clampData(v) {
        v = Math.round(Number(v) || 0);
        if (v < 0)   return 0;
        if (v > 127) return 127;
        return v;
    }

    function emitNote(ch, note, vel) {
        ch = clampCh(ch);
        note = clampData(note); vel = clampData(vel);
        if      (organState.outputFormat === "raw")    outlet(0, 143 + ch, note, vel);
        else if (organState.outputFormat === "tagged") outlet(0, "midi", "note", ch, note, vel);
        else                                           outlet(0, "note", ch, note, vel);
    }

    function emitCC(ch, cc, val) {
        ch = clampCh(ch);
        cc = clampData(cc); val = clampData(val);
        if      (organState.outputFormat === "raw")    outlet(0, 175 + ch, cc, val);
        else if (organState.outputFormat === "tagged") outlet(0, "midi", "cc", ch, cc, val);
        else                                           outlet(0, "cc", ch, cc, val);
    }

    function emitProgram(ch, pgm) {
        ch = clampCh(ch);
        pgm = clampData(pgm);
        if      (organState.outputFormat === "raw")    outlet(0, 191 + ch, pgm);
        else if (organState.outputFormat === "tagged") outlet(0, "midi", "program", ch, pgm);
        else                                           outlet(0, "pc", ch, pgm);
    }

    // Polyphonic key pressure — some consoles address stops this way
    function emitPoly(ch, note, pressure) {
        ch = clampCh(ch);
        note = clampData(note); pressure = clampData(pressure);
        if      (organState.outputFormat === "raw")    outlet(0, 159 + ch, note, pressure);
        else if (organState.outputFormat === "tagged") outlet(0, "midi", "poly", ch, note, pressure);
        else                                           outlet(0, "poly", ch, note, pressure);
    }

    function emitSysex(bytes) {
        if      (organState.outputFormat === "raw")    outlet.apply(null, [0].concat(bytes));
        else if (organState.outputFormat === "tagged") outlet.apply(null, [0, "midi", "sysex"].concat(bytes));
        else                                           outlet.apply(null, [0, "sysex"].concat(bytes));
    }

    // Send whatever a control definition describes, with an explicit value.
    // Used by the dials, by the panic buttons and by the on/off stop addresses.
    function emitControl(ctl, value) {
        var msg = String(ctl.msg || "CC").toUpperCase();
        if      (msg === "PC" || msg === "PROGRAM") emitProgram(ctl.channel, ctl.nr);
        else if (msg === "NOTE")                    emitNote(ctl.channel, ctl.nr, value);
        else if (msg === "POLY")                    emitPoly(ctl.channel, ctl.nr, value);
        else                                        emitCC(ctl.channel, ctl.nr, value);
    }

    // Stop-output channel: per stop → per manual → stopChannelBase + manual index.
    // Deliberately independent of manual.midiChannel (the key-action channel).
    function stopChannelFor(stop) {
        if (stop.stopChannel) return stop.stopChannel;
        var manual = findManualByID(stop.manualID);
        return (manual && manual.stopChannel) ? manual.stopChannel : 1;
    }

    function sendStopMIDI(stop, state) {
        var ch = stopChannelFor(stop);

        // Explicit per-stop wiring always wins, whatever the organ's nominal system:
        // {msg, channel, nr, value} for each end.  One note with velocity 127/0, two
        // separate CCs, two program changes — all of them are just two addresses.
        var addr = state ? stop.on : stop.off;
        if (addr) {
            emitControl({ msg: addr.msg, nr: addr.nr, channel: addr.channel || ch },
                        (addr.value !== undefined) ? addr.value : (state ? 127 : 0));
            common.log(common.LOG_LEVEL.VERBOSE,
                "MIDI " + addr.msg + " ch" + (addr.channel || ch) + " #" + addr.nr +
                " " + addr.value + " (stop " + stop.stopID + " " + (state ? "on" : "off") + ")");
            return;
        }
        // An "explicit" organ with only one side defined: the missing side sends nothing
        if (organState.stopSystem === "explicit") return;

        switch (organState.stopSystem) {

            case "cc":
                emitCC(ch, stop.midiCC, state ? 127 : 0);
                common.log(common.LOG_LEVEL.VERBOSE,
                    "MIDI cc ch" + ch + " #" + stop.midiCC + " " + (state ? 127 : 0));
                break;

            case "cc2":
                // Casavant: separate controllers address ON and OFF, both sent with 127
                var cc2 = state ? stop.ccOn : stop.ccOff;
                emitCC(ch, cc2, 127);
                common.log(common.LOG_LEVEL.VERBOSE,
                    "MIDI cc2 ch" + ch + " #" + cc2 + " (" + (state ? "on" : "off") + ")");
                break;

            case "program":
                // Laukhuff: odd program = ON, even program = OFF
                var pgm = state ? stop.programOn : stop.programOff;
                emitProgram(ch, pgm);
                common.log(common.LOG_LEVEL.VERBOSE,
                    "MIDI program ch" + ch + " p" + pgm + " (" + (state ? "on" : "off") + ")");
                break;

            case "sysex":
                // Whole-organ dump — the individual stop change is implicit in the state
                sendSysExState();
                break;

            case "note":
            default:
                emitNote(ch, stop.midiNote, state ? 127 : 0);
                common.log(common.LOG_LEVEL.VERBOSE,
                    "MIDI note ch" + ch + " n" + stop.midiNote + " " + (state ? 127 : 0));
                break;
        }
    }

    // Build one SysEx message carrying the on/off bit of every stop, in JSON order.
    // 7 stops per data byte — MIDI data bytes must stay below 128.
    function sendSysExState() {
        var bytes = organState.sysex.header.slice();
        var acc = 0, bitCount = 0;

        organState.allStops.forEach(function(stop) {
            if (isStopOn(stop.stopID)) acc |= (1 << bitCount);
            bitCount++;
            if (bitCount === 7) {
                bytes.push(acc);
                acc = 0;
                bitCount = 0;
            }
        });
        if (bitCount > 0) bytes.push(acc);   // flush partial byte

        bytes = bytes.concat(organState.sysex.footer);
        emitSysex(bytes);
        common.log(common.LOG_LEVEL.VERBOSE, "MIDI sysex: " + bytes.length + " bytes");
    }

    // Current on/off state, read from the per-manual GUI caches (source of truth).
    function isStopOn(stopID) {
        var on = false;
        if (!guiObjects.manuals) return false;
        guiObjects.manuals.manuals.forEach(function(manual) {
            Object.keys(manual.stopState).forEach(function(key) {
                if (!manual.stopState[key]) return;
                var numStr = String(key).replace(/^stop/, "").split("_")[0];
                if (parseInt(numStr, 10) === stopID) on = true;
            });
        });
        return on;
    }

    // Panic targets the KEY ACTION channel — it silences sounding notes, not stops.
    //
    // When the organ JSON declares panic controls (type button, name containing
    // "panic"), those definitions win: this console knows a single CC123 on its own
    // channel is enough, so there is no reason to spray 128 note-offs.
    // Without such definitions we fall back to midi.panicMethod.
    function sendPanicMIDI(manual) {
        var defs = organState.panicsByManual[manual.manualID];
        if (defs && defs.length) {
            defs.forEach(function(ctl) { emitControl(ctl, 0); });
            common.log(common.LOG_LEVEL.INFO,
                "PANIC " + manual.name + ": " + describePanics(defs));
            return;
        }

        var ch = manual.midiChannel || 1;
        if (organState.panicMethod === "allnotesoff") {
            for (var n = 0; n < 128; n++) emitNote(ch, n, 0);
            common.log(common.LOG_LEVEL.INFO, "PANIC ch" + ch + ": 128 note-offs");
        } else {
            emitCC(ch, 123, 0);   // all notes off
            emitCC(ch, 120, 0);   // all sound off
            common.log(common.LOG_LEVEL.INFO, "PANIC ch" + ch + ": CC123 + CC120");
        }
    }

    // Global panic controls: channel 0 means "every key-action channel".
    function sendGlobalPanicMIDI() {
        organState.globalPanics.forEach(function(ctl) {
            if (Number(ctl.channel) === 0) {
                organState.manuals.forEach(function(m) {
                    emitControl({ msg: ctl.msg, nr: ctl.nr, channel: m.midiChannel }, 0);
                });
            } else {
                emitControl(ctl, 0);
            }
        });
        if (organState.globalPanics.length) {
            common.log(common.LOG_LEVEL.INFO,
                "GLOBAL PANIC: " + describePanics(organState.globalPanics));
        }
    }

    function describePanics(defs) {
        return defs.map(function(c) {
            return (c.msg || "CC") + c.nr + "@ch" + c.channel;
        }).join(", ");
    }

    function findManualByID(manualID) {
        var found = null;
        organState.manuals.forEach(function(m) {
            if (m.manualID === manualID) found = m;
        });
        return found;
    }

    // ================================================================================================
    // ORGAN LOADING
    // ================================================================================================

    function loadOrgan(organData, filepath) {
        common.log(common.LOG_LEVEL.INFO, "Loading MIDI organ (traditional, no layers)...");

        if (filepath) {
            organState.filepath = filepath;
            organState.name = common.extractOrganNameFromPath(filepath);
        }
        if (organData.name) organState.name = organData.name;

        try {
            parseOrganData(organData);
            dataLayer.initializeState();
            clearGUI();
            return generateGUI();
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "MIDI loadOrgan error: " + error.message);
            return false;
        }
    }

    function parseOrganData(organData) {
        var midiCfg    = organData.midi || {};
        var manualsRaw = organData.manuals || [];
        var stopsRaw   = organData.stops   || [];

        organState.stopSystem   = midiCfg.stopSystem   || "note";
        organState.panicMethod  = midiCfg.panicMethod  || "cc123";
        organState.outputFormat = midiCfg.outputFormat || "named";

        var sx = midiCfg.sysex || {};
        organState.sysex = {
            header: sx.header || [240],   // F0
            footer: sx.footer || [247]    // F7
        };

        var stopChannelBase = midiCfg.stopChannelBase || 11;
        var programBase     = midiCfg.programBase     || 0;

        organState.manuals   = [];
        organState.stopsByID = {};
        organState.allStops  = [];

        manualsRaw.forEach(function(m, index) {
            organState.manuals.push({
                manualID:    (m.manualID !== undefined) ? m.manualID : index,
                name:        m.name || ("Manual " + index),
                midiChannel: m.midiChannel || (index + 1),          // key action in
                stopChannel: m.stopChannel || (stopChannelBase + index),  // stops out
                stops:       []
            });
        });

        stopsRaw.forEach(function(s) {
            var stop = {
                stopID:      s.stopID,
                name:        s.name || ("Stop " + s.stopID),
                manualID:    (s.manualID !== undefined) ? s.manualID : 0,
                stopChannel: s.stopChannel || null,
                on:          s.on  || null,     // explicit wiring, when the table gives it
                off:         s.off || null
            };
            organState.stopsByID[stop.stopID] = stop;

            var manual = findManualByID(stop.manualID);
            if (!manual) {
                common.log(common.LOG_LEVEL.WARN,
                    "Stop " + stop.stopID + " references unknown manualID " + stop.manualID);
                return;
            }

            // Index within the manual — the basis for all derived addresses
            var i = manual.stops.length;

            // Derived per-system addresses; every one can be overridden in the JSON
            stop.midiNote   = (s.midiNote   !== undefined) ? s.midiNote   : stop.stopID;
            stop.midiCC     = (s.midiCC     !== undefined) ? s.midiCC     : stop.stopID;
            stop.ccOn       = (s.ccOn       !== undefined) ? s.ccOn       : (2 * i);
            stop.ccOff      = (s.ccOff      !== undefined) ? s.ccOff      : (2 * i + 1);
            stop.programOn  = (s.programOn  !== undefined) ? s.programOn  : (programBase + 2 * i + 1);
            stop.programOff = (s.programOff !== undefined) ? s.programOff : (programBase + 2 * i);

            manual.stops.push(stop);
            organState.allStops.push(stop);   // JSON order — SysEx bit order
        });

        organState.displayOrder = buildDisplayOrder(organState.manuals);

        parseControls(organData.controls || []);

        common.log(common.LOG_LEVEL.INFO, "Parsed MIDI organ: " +
            organState.manuals.length + " manuals, " + organState.allStops.length + " stops, " +
            (organData.controls ? organData.controls.length : 0) + " controls, " +
            "system=" + organState.stopSystem + ", out=" + organState.outputFormat);
    }

    // Controls table (see the organ JSON header): controlID, name, type, manual,
    // channel, msg, nr.  Panic buttons are attached to the PANIC buttons that already
    // exist; continuous controls become dials in the manual they belong to.
    // manual 0 — or any manualID no manual claims — is global.
    function parseControls(controlsRaw) {
        organState.wheelsByManual = {};
        organState.globalWheels   = [];
        organState.panicsByManual = {};
        organState.globalPanics   = [];

        controlsRaw.forEach(function(c) {
            var ctl = {
                controlID: c.controlID,
                name:      c.name || c.controlName || ("Control " + c.controlID),
                type:      String(c.type || "wheel").toLowerCase(),
                manual:    (c.manual !== undefined) ? Number(c.manual) : 0,
                // Explicit undefined check — channel 0 is meaningful (global panic:
                // "every key-action channel") and `c.channel || 1` would swallow it.
                channel:   (c.channel === undefined || c.channel === null) ? 1 : Number(c.channel),
                msg:       String(c.msg || c.controlMsg || "CC").toUpperCase(),
                nr:        Number((c.nr !== undefined) ? c.nr : c.controlNr)
            };

            // A button whose name mentions panic drives the existing PANIC control
            var isPanic = (ctl.type === "panic") ||
                          (ctl.type === "button" && /panic/i.test(ctl.name));
            var target  = findManualByID(ctl.manual);   // null → global

            if (isPanic) {
                if (!target) { organState.globalPanics.push(ctl); return; }
                if (!organState.panicsByManual[ctl.manual]) organState.panicsByManual[ctl.manual] = [];
                organState.panicsByManual[ctl.manual].push(ctl);
                return;
            }

            // Everything else is a continuous control drawn as a dial
            if (!target) { organState.globalWheels.push(ctl); return; }
            if (!organState.wheelsByManual[ctl.manual]) organState.wheelsByManual[ctl.manual] = [];
            organState.wheelsByManual[ctl.manual].push(ctl);
        });
    }

    // GUI order: highest manual at the top, descending, pedal always last —
    // the way the stop jambs sit on a real console.
    function buildDisplayOrder(manuals) {
        var pedals = [];
        var others = [];
        manuals.forEach(function(m) {
            if (isPedal(m)) pedals.push(m); else others.push(m);
        });
        others.sort(function(a, b) { return b.manualID - a.manualID; });   // descending
        pedals.sort(function(a, b) { return a.manualID - b.manualID; });
        return others.concat(pedals);
    }

    function isPedal(manual) {
        if (manual.manualID === 0) return true;
        return /^p$|ped/i.test(manual.name || "");
    }

    // ================================================================================================
    // GUI
    // ================================================================================================

    function clearGUI() {
        if (context.patcher) {
            common.clearGUIObjects(context.patcher, ["organ_name_display", "preset_menu"]);
        }
        cleanupAllListeners();
        guiObjects = {};
        common.log(common.LOG_LEVEL.INFO, "GUI cleared with listener cleanup");
    }

    function cleanupAllListeners() {
        listeners.forEach(function(listener) {
            if (listener && typeof listener.remove === 'function') {
                try { listener.remove(); } catch(e) {}
            }
        });
        listeners = [];
    }

    function addListener(listener) {
        listeners.push(listener);
        return listener;
    }

    function generateGUI() {
        if (!context.patcher) {
            common.log(common.LOG_LEVEL.WARN, "No patcher context - skipping GUI");
            return true;
        }

        common.GEOMETRY.clearCache();

        guiObjects.header  = createMainHeader(context.patcher, organState.name);
        // Global dials extend the header downwards; manuals start below whatever it needs
        guiObjects.manuals = createManualSections(context.patcher,
            Math.max(LAYOUT.manualsY, guiObjects.header.bottomY + 10));

        resizeWindowToContent();

        common.log(common.LOG_LEVEL.INFO,
            "MIDI GUI built — " + organState.manuals.length + " manual sections (no layers)");
        return true;
    }

    // *** HEADER: name label, global PANIC + CANCEL, preset_menu ***

    function createMainHeader(p, organName) {
        var G  = common.GEOMETRY;
        var fs = G.button.fontsize;
        // Global buttons share the x of the per-manual buttons (manual bpatcher x + inner offset)
        var gx = LAYOUT.manualX + LAYOUT.btnX;

        var label = common.createLiveComment(p, G.margin.x, LAYOUT.headerY, 200, 20,
            "organNameLabel", organName, 30, 14);

        var panic = createActionButton(p, gx, LAYOUT.globalPanicY, "panic_all", "PANIC",
            fs.large, true, function() { executePanic(null); });

        var cancel = createActionButton(p, gx, LAYOUT.globalCancelY, "cancel_all", "CANCEL",
            fs.small, false, function() { executeCancel(null); });

        var bottomY = LAYOUT.globalCancelY + LAYOUT.btnH;

        // Global controls (manual 0) run along the header, to the right of the buttons
        var globalDials = [];
        var gdx = gx + LAYOUT.btnW + 10;
        organState.globalWheels.forEach(function(ctl) {
            var d = createControlDial(p, gdx, LAYOUT.globalPanicY, ctl, "ctrl_global_");
            if (d) globalDials.push(d);
            gdx += LAYOUT.ctrlColW;
        });
        if (globalDials.length) {
            bottomY = Math.max(bottomY, LAYOUT.globalPanicY + LAYOUT.ctrlH);
        }
        guiObjects.dialsByID = guiObjects.dialsByID || {};

        // preset_menu: reuse the user's existing menu; create + connect only if missing
        // (same pattern as SINUA createMainHeader).
        var pmX = G.margin.x + 320, pmY = LAYOUT.headerY, pmW = 160, pmH = 20;
        var presetMenu = p.getnamed("preset_menu");
        if (!presetMenu) {
            try {
                presetMenu = p.newdefault(pmX, pmY, "live.menu",
                    "@varname",           "preset_menu",
                    "@patching_rect",     pmX, pmY, pmW, pmH,
                    "@presentation_rect", pmX, pmY, pmW, pmH,
                    "@presentation", 1
                );
                if (presetMenu) {
                    presetMenu.setattr("_parameter_longname",  "Preset");
                    presetMenu.setattr("_parameter_shortname", "Prst");
                    presetMenu.setattr("_parameter_invisible", 1);
                    presetMenu.setattr("_parameter_range", ["--", "--"]);
                    var presetMenuSelectObj = p.getnamed("presetMenuSelect");
                    if (presetMenuSelectObj) {
                        try {
                            p.connect(presetMenu, 0, presetMenuSelectObj, 0);
                            post("createMainHeader: preset_menu created and connected to presetMenuSelect\n");
                        } catch(ce) {
                            post("createMainHeader: preset_menu connect failed: " + ce.message + "\n");
                        }
                    } else {
                        post("createMainHeader: presetMenuSelect not found — wire manually\n");
                    }
                }
            } catch(e) {
                post("createMainHeader: preset_menu creation failed: " + e.message + "\n");
            }
        } else {
            post("createMainHeader: reusing existing preset_menu\n");
        }

        return { label: label, panic: panic, cancel: cancel, presetMenu: presetMenu,
                 globalDials: globalDials, bottomY: bottomY };
    }

    // Continuous control → live.dial ("tiny" appearance, wide enough for the name)
    // sending its CC / program / note on change.
    function createControlDial(p, x, y, ctl, varnamePrefix) {
        var varname = varnamePrefix + ctl.controlID;
        var dial;
        try {
            // @appearance 1 = tiny (same as SINUA's controller dials)
            dial = p.newdefault(x, y, "live.dial",
                "@varname",           varname,
                "@patching_rect",     x, y, LAYOUT.ctrlW, LAYOUT.ctrlH,
                "@presentation_rect", x, y, LAYOUT.ctrlW, LAYOUT.ctrlH,
                "@presentation", 1,
                "@appearance", 1);
        } catch(e) {
            post("createControlDial: " + e.message + "\n");
            return null;
        }
        if (!dial) return null;

        try {
            dial.setattr("_parameter_longname",  ctl.name);
            dial.setattr("_parameter_shortname", shortLabel(ctl.name));
            dial.setattr("_parameter_type",  1);      // int
            dial.setattr("_parameter_range", 0, 127);
            dial.setattr("_parameter_unitstyle", 0);
            dial.setattr("_parameter_invisible", 0);
        } catch(e) { /* attribute set is best-effort */ }

        // Remember the object and its value so presets can capture and restore it
        guiObjects.dialsByID = guiObjects.dialsByID || {};
        guiObjects.dialsByID[ctl.controlID] = dial;
        if (organState.controlValues[ctl.controlID] === undefined) {
            organState.controlValues[ctl.controlID] = 0;
        }

        addListener(new MaxobjListener(dial, function(data) {
            if (_suppressListeners) return;
            organState.controlValues[ctl.controlID] = data.value;
            emitControl(ctl, data.value);
            common.log(common.LOG_LEVEL.VERBOSE,
                "Control " + ctl.name + " = " + data.value +
                " (" + ctl.msg + ctl.nr + " ch" + ctl.channel + ")");
        }));

        return dial;
    }

    // The tiny dial shows the shortname beside the slider — crop at the length of
    // "Tremulant" so the common names stay whole and nothing overflows the column.
    function shortLabel(name) {
        var n = String(name).replace(/^[MP]\d*:\s*\d*\s*/, "");   // drop "M4: 12 " prefixes
        n = n.replace(/^PANIC[^:]*:\s*/i, "");                     // drop "PANIC 1: " prefixes
        return n.length > LAYOUT.ctrlNameMax ? n.substring(0, LAYOUT.ctrlNameMax) : n;
    }

    // How many controller columns to reserve, and how tall the manual must be.
    // ALWAYS at least one column, so all manuals line up whether or not they have
    // controls.  Returns {cols, perColumn, height}; height never shrinks below the
    // value passed in.
    function planControlColumns(count, availableHeight) {
        var usable    = availableHeight - LAYOUT.stopPadTop - LAYOUT.stopPadBottom;
        var perColumn = Math.floor(usable / LAYOUT.ctrlH);
        if (perColumn < 1) perColumn = 1;

        if (count <= 0) return { cols: 1, perColumn: perColumn, height: availableHeight };

        var cols = Math.ceil(count / perColumn);
        if (cols < 1) cols = 1;
        if (cols <= LAYOUT.ctrlMaxCols) {
            return { cols: cols, perColumn: perColumn, height: availableHeight };
        }

        // Too many columns — grow the manual downwards instead of sideways
        cols      = LAYOUT.ctrlMaxCols;
        perColumn = Math.ceil(count / cols);
        var needed = LAYOUT.stopPadTop + (perColumn * LAYOUT.ctrlH) + LAYOUT.stopPadBottom;
        return { cols: cols, perColumn: perColumn, height: Math.max(availableHeight, needed) };
    }

    // Momentary button (live.text in button mode) with a click listener.
    // isPanic → red styling.
    function createActionButton(p, x, y, varname, text, fontsize, isPanic, onClick) {
        var obj = common.createLiveText(p, x, y, LAYOUT.btnW, LAYOUT.btnH,
            varname, text, text, text, fontsize);
        if (!obj || !obj.liveText) return null;

        try { obj.liveText.setattr("mode", 0); } catch(e) {}   // button (momentary)
        if (isPanic) applyPanicColor(obj.liveText);

        addListener(new MaxobjListener(obj.liveText, function(data) {
            if (_suppressListeners) return;
            if (data.value) onClick();
        }));
        return obj.liveText;
    }

    // *** MANUAL SECTIONS: stacked vertically, highest manual first, pedal last ***

    function createManualSections(p, startY) {
        var G = common.GEOMETRY;
        var manuals  = [];
        var currentY = startY;

        organState.displayOrder.forEach(function(manualData) {
            var cols   = G.grid.columnsNeeded(manualData.stops.length);
            var rows   = Math.min(manualData.stops.length, common.MAX_STOPS_PER_COLUMN);
            var gridW  = cols * (G.columns.w() + G.columns.margin());
            // Stops hug the top and bottom edge — only stopPad on either side
            var baseH  = Math.max(LAYOUT.stopPadTop + (rows * G.stops.h) + LAYOUT.stopPadBottom,
                                  LAYOUT.manualMinH);

            // Controller columns sit between the button column and the stop grid,
            // so the stops shift right by exactly the space the dials occupy.
            // planControlColumns always reserves at least one, keeping every manual
            // (the pedal included) indented the same amount.
            var wheels = organState.wheelsByManual[manualData.manualID] || [];
            var plan   = planControlColumns(wheels.length, baseH);
            var startX = G.margin.x + (plan.cols * LAYOUT.ctrlColW);
            var w      = startX + gridW + 10;

            var manual = createManualBpatcher(p, LAYOUT.manualX, currentY, w, plan.height,
                                              manualData, startX, wheels, plan);
            if (manual) {
                manual.width = w;          // remembered so the window resize is exact
                manuals.push(manual);
            }
            currentY += plan.height + LAYOUT.manualGap;
        });

        return { manuals: manuals, totalHeight: currentY };
    }

    function createManualBpatcher(p, x, y, w, h, manualData, stopStartX, wheels, plan) {
        var fs = common.GEOMETRY.button.fontsize;
        var bpatcher = common.createBpatcher(p, x, y, w, h, "manual" + manualData.manualID);
        if (!bpatcher) return null;

        var sp = bpatcher.subpatcher();
        try { sp.openinpresentation = 1; } catch(e) {}

        // Left column: name, PANIC, CANC — kept inside the column so it never
        // overlaps the controller column or the stops.
        var label = common.createLiveComment(sp, LAYOUT.btnX, 0, common.GEOMETRY.margin.x - 4, 16,
            "manual_label_" + manualData.manualID,
            manualData.name + " (ch" + manualData.midiChannel + ")", 30, 9);

        // PANIC above CANC, both 2px in from the left edge
        var panicBtn = createActionButton(sp, LAYOUT.btnX, LAYOUT.manualPanicY,
            "panic_m" + manualData.manualID, "PANIC", fs.small, true,
            function() { executePanic(manualData.manualID); });

        var cancelBtn = createActionButton(sp, LAYOUT.btnX, LAYOUT.manualCancelY,
            "cancel_m" + manualData.manualID, "CANC", fs.small, false,
            function() { executeCancel(manualData.manualID); });

        // Controller dials in their own column(s), starting at the top edge like the
        // stops, filling one column before starting the next
        var dials = [];
        (wheels || []).forEach(function(ctl, i) {
            var col = Math.floor(i / plan.perColumn);
            var row = i % plan.perColumn;
            var dx  = common.GEOMETRY.margin.x + (col * LAYOUT.ctrlColW);
            var dy  = LAYOUT.stopPadTop + (row * LAYOUT.ctrlH);
            var d = createControlDial(sp, dx, dy, ctl, "ctrl_m" + manualData.manualID + "_");
            if (d) dials.push(d);
        });

        // Fixed stop grid + per-manual listener cache
        var stopState     = {};   // {varname → bool} — updated by listeners, read by capturePreset
        var stopButtonMap = createStopGrid(sp, stopStartX, LAYOUT.stopPadTop, manualData, stopState);

        return {
            bpatcher:      bpatcher,
            manualData:    manualData,
            panic:         panicBtn,
            cancel:        cancelBtn,
            dials:         dials,
            stopButtonMap: stopButtonMap,   // {varname → live.text MaxObj}
            stopState:     stopState
        };
    }

    function createStopGrid(p, startX, startY, manualData, stateCache) {
        var G = common.GEOMETRY;
        var buttonMap = {};
        var currentColumn = 0;
        var currentRow = 0;
        var seenIDs = {};

        manualData.stops.forEach(function(stop, index) {
            var sid     = stop.stopID;
            var varname = seenIDs[sid] ? ("stop" + sid + "_" + index) : ("stop" + sid);
            seenIDs[sid] = true;

            var marginX = typeof G.columns.margin === 'function' ?
                G.columns.margin() : G.columns.margin;
            var pos = G.grid.pos(currentRow, currentColumn, marginX, marginX);

            var stopLabel = stop.stopID + " " + stop.name;
            var stopObj = common.createLiveText(p, startX + pos.x, startY + pos.y,
                G.stops.w, G.stops.h, varname, stopLabel, stopLabel, stopLabel, 10);

            if (stopObj && stopObj.liveText) {
                applyStopColor(stopObj.liveText, stopColorClass(stop.name));
                buttonMap[varname] = stopObj.liveText;
                addListener(new MaxobjListener(stopObj.liveText, function(data) {
                    if (_suppressListeners) return;
                    if (stateCache) stateCache[varname] = Boolean(data.value);
                    executeStopAction(stop, Boolean(data.value));
                }));
            }

            currentRow++;
            if (currentRow >= common.MAX_STOPS_PER_COLUMN) {
                currentColumn++;
                currentRow = 0;
            }
        });

        return buttonMap;
    }

    function resizeWindowToContent() {
        if (!context.patcher || !context.patcher.wind) return;
        var G = common.GEOMETRY;
        try {
            var contentW = 200;
            var contentH = (guiObjects.manuals && guiObjects.manuals.totalHeight)
                ? guiObjects.manuals.totalHeight + 20 : 400;
            // Use the widths the manuals were actually built with — they already
            // include the controller columns the stops were shifted past.
            if (guiObjects.manuals) {
                guiObjects.manuals.manuals.forEach(function(m) {
                    contentW = Math.max(contentW, LAYOUT.manualX + (m.width || 0) + 15);
                });
            }
            contentW = Math.max(contentW, G.margin.x + 500);   // header row minimum
            context.patcher.wind.size = [contentW, contentH];
            common.log(common.LOG_LEVEL.INFO, "Window resized: " + contentW + " x " + contentH);
        } catch(e) {
            common.log(common.LOG_LEVEL.WARN, "Window resize failed: " + e.message);
        }
    }

    // ================================================================================================
    // ACTIONS
    // ================================================================================================

    function executeStopAction(stop, state) {
        if (_suppressListeners) return;
        common.log(common.LOG_LEVEL.VERBOSE,
            "Stop " + stop.stopID + " -> " + state + " [MAN " + stop.manualID + "]");
        // skipQueue=true: no SINUA OSC bundling — MIDI is sent directly below
        dataLayer.setStopState(stop.stopID, state, true, null);
        sendStopMIDI(stop, state);
    }

    // manualID null → all manuals
    function executeCancel(manualID) {
        var all = guiObjects.manuals ? guiObjects.manuals.manuals : [];
        var targets = (manualID === null || manualID === undefined)
            ? all
            : all.filter(function(m) { return m.manualData.manualID === manualID; });

        _suppressListeners = true;
        targets.forEach(function(manual) {
            Object.keys(manual.stopButtonMap).forEach(function(key) {
                manual.stopState[key] = false;
                manual.stopButtonMap[key].message("set", 0);
            });
            manual.manualData.stops.forEach(function(stop) {
                dataLayer.setStopState(stop.stopID, false, true, null);
                // In sysex mode one dump after the whole loop is enough
                if (organState.stopSystem !== "sysex") sendStopMIDI(stop, false);
            });
        });
        if (organState.stopSystem === "sysex") sendSysExState();
        releaseSuppression();

        common.log(common.LOG_LEVEL.INFO, "Cancel executed" +
            ((manualID !== null && manualID !== undefined) ? " for manual " + manualID : " (all)"));
    }

    // manualID null → every manual, plus any global panic definitions
    function executePanic(manualID) {
        var isGlobal = (manualID === null || manualID === undefined);
        var targets = isGlobal
            ? organState.manuals
            : organState.manuals.filter(function(m) { return m.manualID === manualID; });

        targets.forEach(function(manual) { sendPanicMIDI(manual); });
        if (isGlobal) sendGlobalPanicMIDI();

        common.log(common.LOG_LEVEL.INFO, "PANIC" +
            (isGlobal ? " (all manuals)" : " manual " + manualID));
    }

    // btn.message("set", ...) fires MaxobjListener callbacks ASYNCHRONOUSLY — keep
    // the suppress flag true until they have all arrived.
    //
    // The Task MUST live at module scope.  Held only by a local variable it becomes
    // garbage the moment the function returns, and Max may collect it before it ever
    // fires — leaving _suppressListeners stuck true forever.  Every later stop click
    // then returned early, which is why CANCEL only worked sometimes and why store
    // captured nothing: the per-manual stopState cache was never being updated.
    function releaseSuppression() {
        if (!_suppressTask) {
            _suppressTask = new Task(function() { _suppressListeners = false; });
        }
        try { _suppressTask.cancel(); } catch(e) {}
        _suppressTask.schedule(10);
    }

    // Interface used by Universal.js anything() — stop events arriving from outside
    // the GUI (the console's own stop action).  These must update the button and the
    // cache too, otherwise the change is invisible and capturePreset would miss it.
    function handleStopEvent(stopID, manualID, layerID, divisionID, state) {
        var stop = organState.stopsByID[stopID];
        if (!stop) {
            common.log(common.LOG_LEVEL.WARN, "handleStopEvent: unknown stopID " + stopID);
            return;
        }
        state = Boolean(state);
        // Send BEFORE touching the GUI: setStopGUI raises the suppress flag, which
        // would otherwise gag executeStopAction for this very event.
        dataLayer.setStopState(stop.stopID, state, true, null);
        sendStopMIDI(stop, state);
        setStopGUI(stop, state);
        common.log(common.LOG_LEVEL.VERBOSE,
            "External stop " + stop.stopID + " -> " + state + " [MAN " + stop.manualID + "]");
    }

    // Reflect a stop's state on its button + cache without triggering the listener.
    function setStopGUI(stop, state) {
        if (!guiObjects.manuals) return;
        _suppressListeners = true;
        guiObjects.manuals.manuals.forEach(function(manual) {
            if (manual.manualData.manualID !== stop.manualID) return;
            Object.keys(manual.stopButtonMap).forEach(function(btnKey) {
                var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
                if (parseInt(numStr, 10) !== stop.stopID) return;
                manual.stopState[btnKey] = state;
                manual.stopButtonMap[btnKey].message("set", state ? 1 : 0);
            });
        });
        releaseSuppression();
    }

    function findControlByID(controlID) {
        var found = null;
        var cid = String(controlID);
        function scan(list) {
            list.forEach(function(c) { if (String(c.controlID) === cid) found = c; });
        }
        scan(organState.globalWheels);
        Object.keys(organState.wheelsByManual).forEach(function(m) {
            scan(organState.wheelsByManual[m]);
        });
        return found;
    }

    // ================================================================================================
    // PRESET CAPTURE / RECALL
    // ================================================================================================

    // preset.stops keyed by manualID (no layers): {manualID: [stopID, ...]}
    function capturePreset(name) {
        if (!guiObjects || !guiObjects.manuals) {
            common.log(common.LOG_LEVEL.ERROR, "capturePreset: no GUI loaded");
            return null;
        }

        var preset = {
            name:     name || ("Preset " + new Date().toISOString().slice(0,19).replace("T"," ")),
            type:     "MIDI",
            stops:    {},   // {manualID: [stopID, ...]}
            controls: {}    // {controlID: value}
        };

        guiObjects.manuals.manuals.forEach(function(manual) {
            var mid = manual.manualData.manualID;
            var activeStops = [];
            Object.keys(manual.stopButtonMap).forEach(function(btnKey) {
                if (manual.stopState[btnKey]) {
                    var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
                    var stopID = parseInt(numStr, 10);
                    if (!isNaN(stopID)) activeStops.push(stopID);
                }
            });
            preset.stops[mid] = activeStops;
        });

        // Controller positions travel with the preset — a registration is not just
        // which stops are drawn, but where the swell and the tremulants stand.
        Object.keys(organState.controlValues).forEach(function(cid) {
            preset.controls[cid] = organState.controlValues[cid];
        });

        var stopCount = 0;
        Object.keys(preset.stops).forEach(function(k) { stopCount += preset.stops[k].length; });
        common.log(common.LOG_LEVEL.INFO, "Preset captured: \"" + preset.name + "\" - " +
            stopCount + " stops in " + Object.keys(preset.stops).length + " manuals, " +
            Object.keys(preset.controls).length + " controls");
        return preset;
    }

    function recallPreset(presetJson) {
        var preset = (typeof presetJson === 'string') ? JSON.parse(presetJson) : presetJson;
        if (!preset) {
            common.log(common.LOG_LEVEL.ERROR, "recallPreset: no preset data");
            return;
        }

        common.log(common.LOG_LEVEL.INFO, "Recalling preset: " + preset.name);
        if (!guiObjects || !guiObjects.manuals) return;

        _suppressListeners = true;

        guiObjects.manuals.manuals.forEach(function(manual) {
            var mid = manual.manualData.manualID;
            var activeIDs = (preset.stops && preset.stops[mid]) || [];
            var activeSet = {};
            activeIDs.forEach(function(id) { activeSet[id] = true; });

            // Update GUI + cache silently, then send absolute state for EVERY stop
            // (traditional organ: absolute, not diff — a few dozen messages at most).
            Object.keys(manual.stopButtonMap).forEach(function(btnKey) {
                var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
                var numID  = parseInt(numStr, 10);
                var target = (!isNaN(numID) && activeSet[numID]) ? 1 : 0;

                manual.stopState[btnKey] = Boolean(target);
                manual.stopButtonMap[btnKey].message("set", target);
            });

            manual.manualData.stops.forEach(function(stop) {
                var on = Boolean(activeSet[stop.stopID]);
                dataLayer.setStopState(stop.stopID, on, true, null);
                if (organState.stopSystem !== "sysex") sendStopMIDI(stop, on);
            });
        });

        // One dump covers the whole organ in sysex mode
        if (organState.stopSystem === "sysex") sendSysExState();

        // Restore controller positions: move the dial silently, then send its value
        if (preset.controls) {
            Object.keys(preset.controls).forEach(function(cid) {
                var value = preset.controls[cid];
                var ctl   = findControlByID(cid);
                if (!ctl) return;
                organState.controlValues[cid] = value;
                var dial = guiObjects.dialsByID ? guiObjects.dialsByID[cid] : null;
                if (dial) dial.message("set", value);
                emitControl(ctl, value);
            });
        }

        releaseSuppression();
        common.log(common.LOG_LEVEL.INFO, "Preset recalled: " + preset.name);
    }

    // ================================================================================================
    // PUBLIC API
    // ================================================================================================

    return {
        loadOrgan: loadOrgan,
        clearGUI: clearGUI,

        getCurrentOrganInfo: function() {
            return {
                name: organState.name,
                filepath: organState.filepath,
                hasData: !!organState.name && organState.name !== "No Organ Loaded"
            };
        },

        handleStopEvent: handleStopEvent,

        // Preset system — called from gamut_storage_organ.js
        capturePreset: capturePreset,
        recallPreset:  recallPreset,

        getPresetMenu: function() {
            return guiObjects && guiObjects.header ? guiObjects.header.presetMenu : null;
        }
    };
}

// ================================================================================================
// MODULE REGISTRATION
// ================================================================================================

if (typeof global !== 'undefined') {
    global.createMIDIModuleWithDI = createMIDIModuleWithDI;
}

post("organTool_MIDI.js v00.04 - named MIDI out; controls in presets; suppress-task fix\n");
