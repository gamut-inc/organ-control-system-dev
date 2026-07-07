// organTool_MIDI.js - Traditional MIDI organ module (NO layers, NO moving stops)
// 00.01 - Initial version for the midi-organ branch.
//
// TARGET: traditional pipe organs with MIDI interface — every stop belongs to
// exactly ONE manual (fixed disposition, like the physical console).  There are
// no layers, no movable stops, no division routing, no SINUA OSC.
//
// ORGAN JSON FORMAT (lowercase keys → detectOrganType() returns "MIDI"):
// {
//   "name": "St. Marien",                          // optional, else from filename
//   "midi": { "stopMethod": "note" },              // optional, note|cc (default note)
//   "manuals": [
//     { "manualID": 0, "name": "Pedal",     "midiChannel": 1 },
//     { "manualID": 1, "name": "Hauptwerk", "midiChannel": 2 }
//   ],
//   "stops": [
//     { "stopID": 1, "name": "Principal 8'",  "manualID": 1, "midiNote": 36 },
//     { "stopID": 2, "name": "Subbass 16'",   "manualID": 0, "midiCC":   20 },
//     { "stopID": 3, "name": "Tremulant",     "manualID": 1, "midiNote": 55 }
//   ]
// }
// Tremulants and couplers are ordinary stops here — on a traditional console
// they are stop knobs like any other.  No separate tremulant/controller GUI.
//
// PER-STOP MIDI MAPPING (first match wins):
//   stop.midiNote  → note on/off, velocity 127/0
//   stop.midiCC    → CC value 127/0
//   neither        → note = stopID
//   channel        = stop.midiChannel || manual.midiChannel || 1
//
// MIDI OUTPUT via outlet 0 (shared js outlet, prefix "midi"):
//   ("midi", "note", channel, note, velocity)
//   ("midi", "cc",   channel, controller, value)
// Patcher wiring:  [route midi] → [route note cc] → [midiformat] → [midiout]
//   or simpler:    [route midi] → [route note cc] → noteout / ctlout
//
// PUBLIC API (same interface as organTool_SINUA.js):
//   loadOrgan, clearGUI, getCurrentOrganInfo, handleStopEvent,
//   capturePreset, recallPreset, getPresetMenu

function createMIDIModuleWithDI(common, dataLayer, context) {

    var organState = {
        name: "No Organ Loaded",
        filepath: null,
        manuals: [],      // [{manualID, name, midiChannel, stops: [stop, ...]}]
        stopsByID: {},    // {stopID: stop} for handleStopEvent / recall lookups
        stopMethod: "note"
    };

    var guiObjects = {};
    var listeners  = [];
    // When true, MaxobjListener callbacks do nothing (silent GUI updates during
    // cancel/recall).  btn.message("set", ...) fires listeners ASYNCHRONOUSLY,
    // so the flag is released via a 10ms Task, never synchronously.
    var _suppressListeners = false;

    // ================================================================================================
    // MIDI OUTPUT
    // ================================================================================================

    function sendStopMIDI(stop, state) {
        var manual  = findManualByID(stop.manualID);
        var channel = stop.midiChannel ||
                      (manual ? manual.midiChannel : null) || 1;

        if (stop.midiCC !== undefined && stop.midiCC !== null) {
            outlet(0, "midi", "cc", channel, stop.midiCC, state ? 127 : 0);
            common.log(common.LOG_LEVEL.VERBOSE,
                "MIDI cc ch" + channel + " #" + stop.midiCC + " " + (state ? 127 : 0));
        } else {
            var note = (stop.midiNote !== undefined && stop.midiNote !== null)
                ? stop.midiNote : stop.stopID;
            outlet(0, "midi", "note", channel, note, state ? 127 : 0);
            common.log(common.LOG_LEVEL.VERBOSE,
                "MIDI note ch" + channel + " n" + note + " " + (state ? 127 : 0));
        }
    }

    function sendPanicMIDI(manual) {
        // CC 123 all-notes-off + CC 120 all-sound-off on the manual's channel
        var channel = manual.midiChannel || 1;
        outlet(0, "midi", "cc", channel, 123, 0);
        outlet(0, "midi", "cc", channel, 120, 0);
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
        if (organData.midi && organData.midi.stopMethod) {
            organState.stopMethod = organData.midi.stopMethod;
        }

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
        var manualsRaw = organData.manuals || [];
        var stopsRaw   = organData.stops   || [];

        organState.manuals   = [];
        organState.stopsByID = {};

        manualsRaw.forEach(function(m, index) {
            organState.manuals.push({
                manualID:    (m.manualID !== undefined) ? m.manualID : index,
                name:        m.name || ("Manual " + index),
                midiChannel: m.midiChannel || (index + 1),
                stops:       []
            });
        });

        stopsRaw.forEach(function(s) {
            var stop = {
                stopID:      s.stopID,
                name:        s.name || ("Stop " + s.stopID),
                manualID:    (s.manualID !== undefined) ? s.manualID : 0,
                midiNote:    s.midiNote,
                midiCC:      s.midiCC,
                midiChannel: s.midiChannel
            };
            organState.stopsByID[stop.stopID] = stop;
            var manual = findManualByID(stop.manualID);
            if (manual) {
                manual.stops.push(stop);
            } else {
                common.log(common.LOG_LEVEL.WARN,
                    "Stop " + stop.stopID + " references unknown manualID " + stop.manualID);
            }
        });

        common.log(common.LOG_LEVEL.INFO, "Parsed MIDI organ: " +
            organState.manuals.length + " manuals, " + stopsRaw.length + " stops");
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

        var G = common.GEOMETRY;
        G.clearCache();

        guiObjects.header  = createMainHeader(context.patcher, organState.name);
        guiObjects.manuals = createManualSections(context.patcher);

        resizeWindowToContent();

        common.log(common.LOG_LEVEL.INFO,
            "MIDI GUI built — " + organState.manuals.length + " manual sections (no layers)");
        return true;
    }

    // *** HEADER: name label, PANIC, CANCEL, preset_menu ***

    function createMainHeader(p, organName) {
        var G  = common.GEOMETRY;
        var fs = G.button.fontsize;

        var label = common.createLiveComment(p, G.margin.x, 10, 200, 20,
            "organNameLabel", organName, 30, 14);

        var panic  = createHeaderButton(p, G.margin.x + 210, 10, "panic",  "PANIC",  fs.large,
            function() { executePanic(); });
        var cancel = createHeaderButton(p, G.margin.x + 260, 10, "cancel", "CANCEL", fs.small,
            function() { executeCancel(null); });

        // preset_menu: reuse the user's existing menu; create + connect only if missing
        // (same pattern as SINUA createMainHeader).
        var pmX = G.margin.x + 320, pmY = 10, pmW = 160, pmH = 20;
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

        return { label: label, panic: panic, cancel: cancel, presetMenu: presetMenu };
    }

    // Momentary button with a click listener (live.text button mode)
    function createHeaderButton(p, x, y, varname, text, fontsize, onClick) {
        var obj = common.createLiveText(p, x, y, 45, 20, varname, text, text, text, fontsize);
        if (obj && obj.liveText) {
            try { obj.liveText.setattr("mode", 0); } catch(e) {}   // button (momentary)
            addListener(new MaxobjListener(obj.liveText, function(data) {
                if (_suppressListeners) return;
                if (data.value) onClick();
            }));
            return obj.liveText;
        }
        return null;
    }

    // *** MANUAL SECTIONS: stacked vertically, all visible (traditional console view) ***

    function createManualSections(p) {
        var G = common.GEOMETRY;
        var manuals  = [];
        var currentY = 45;   // below header

        organState.manuals.forEach(function(manualData) {
            var cols   = G.grid.columnsNeeded(manualData.stops.length);
            var rows   = Math.min(manualData.stops.length, common.MAX_STOPS_PER_COLUMN);
            var gridW  = cols * (G.columns.w() + G.columns.margin());
            var startX = G.margin.x;                        // room for CANCEL column
            var w      = startX + gridW + 10;
            var h      = 25 + (rows * G.stops.h) + 5;       // label row + grid

            var manual = createManualBpatcher(p, 5, currentY, w, h, manualData, startX);
            if (manual) manuals.push(manual);
            currentY += h + 8;
        });

        return { manuals: manuals, totalHeight: currentY };
    }

    function createManualBpatcher(p, x, y, w, h, manualData, stopStartX) {
        var G  = common.GEOMETRY;
        var fs = G.button.fontsize;
        var bpatcher = common.createBpatcher(p, x, y, w, h, "manual" + manualData.manualID);
        if (!bpatcher) return null;

        var sp = bpatcher.subpatcher();
        try { sp.openinpresentation = 1; } catch(e) {}

        var label = common.createLiveComment(sp, 0, 0, 140, 20,
            "manual_label_" + manualData.manualID,
            manualData.name + "  (ch " + manualData.midiChannel + ")", 30, 11);

        // Per-manual CANCEL under the label
        var cancelBtn = createHeaderButton(sp, 0, 25, "cancel_m" + manualData.manualID,
            "CANC", fs.small, function() { executeCancel(manualData.manualID); });

        // Fixed stop grid + per-manual listener cache
        var stopState     = {};   // {varname → bool} — updated by listeners, read by capturePreset
        var stopButtonMap = createStopGrid(sp, stopStartX, 25, manualData, stopState);

        return {
            bpatcher:      bpatcher,
            manualData:    manualData,
            cancel:        cancelBtn,
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
            organState.manuals.forEach(function(m) {
                var cols = G.grid.columnsNeeded(m.stops.length);
                var w = G.margin.x + (cols * (G.columns.w() + G.columns.margin())) + 25;
                contentW = Math.max(contentW, w);
            });
            contentW = Math.max(contentW, G.margin.x + 500);  // header row minimum
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
        var targets = (manualID === null || manualID === undefined)
            ? (guiObjects.manuals ? guiObjects.manuals.manuals : [])
            : (guiObjects.manuals ? guiObjects.manuals.manuals.filter(function(m) {
                  return m.manualData.manualID === manualID;
              }) : []);

        _suppressListeners = true;
        targets.forEach(function(manual) {
            manual.manualData.stops.forEach(function(stop) {
                sendStopMIDI(stop, false);
                dataLayer.setStopState(stop.stopID, false, true, null);
            });
            Object.keys(manual.stopButtonMap).forEach(function(key) {
                manual.stopState[key] = false;
                manual.stopButtonMap[key].message("set", 0);
            });
        });
        releaseSuppression();

        common.log(common.LOG_LEVEL.INFO, "Cancel executed" +
            ((manualID !== null && manualID !== undefined) ? " for manual " + manualID : " (all)"));
    }

    function executePanic() {
        organState.manuals.forEach(function(manual) {
            sendPanicMIDI(manual);
        });
        common.log(common.LOG_LEVEL.INFO, "PANIC: all-notes-off sent to all manual channels");
    }

    // btn.message("set", ...) fires MaxobjListener callbacks ASYNCHRONOUSLY — keep
    // the suppress flag true until they have all arrived (same pattern as SINUA).
    function releaseSuppression() {
        var t = new Task(function() { _suppressListeners = false; });
        t.schedule(10);
    }

    // Interface used by Universal.js anything() — external stop events
    function handleStopEvent(stopID, manualID, layerID, divisionID, state) {
        var stop = organState.stopsByID[stopID];
        if (!stop) {
            common.log(common.LOG_LEVEL.WARN, "handleStopEvent: unknown stopID " + stopID);
            return;
        }
        executeStopAction(stop, Boolean(state));
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
            name:  name || ("Preset " + new Date().toISOString().slice(0,19).replace("T"," ")),
            type:  "MIDI",
            stops: {}    // {manualID: [stopID, ...]}
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

        common.log(common.LOG_LEVEL.INFO, "Preset captured: \"" + preset.name + "\" - " +
            Object.keys(preset.stops).length + " manuals");
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

            // Update GUI + cache silently, send explicit MIDI on/off for EVERY stop
            // (traditional organ: absolute state, not diff — a few dozen messages max).
            Object.keys(manual.stopButtonMap).forEach(function(btnKey) {
                var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
                var numID  = parseInt(numStr, 10);
                var target = (!isNaN(numID) && activeSet[numID]) ? 1 : 0;

                manual.stopState[btnKey] = Boolean(target);
                manual.stopButtonMap[btnKey].message("set", target);
            });

            manual.manualData.stops.forEach(function(stop) {
                var on = Boolean(activeSet[stop.stopID]);
                sendStopMIDI(stop, on);
                dataLayer.setStopState(stop.stopID, on, true, null);
            });
        });

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

post("organTool_MIDI.js v00.01 - traditional MIDI organ (manuals only, no layers)\n");
