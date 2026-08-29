// organTool_SINUA_ContextAware.js - CONTEXT-AWARE SINUA MODULE
// 01.09 - File-based layer patchers: generate .maxpat once, load from disk per layer (skip newdefault)
// 01.10 - Layer-div buttons use executeDivisionAction → /M/L/D ±divID (was wrongly /S)
//         parseDivisionStops adds numeric divisionID field
// 01.11 - _suppressListeners flag: updateUIStopsOff visual clear no longer triggers OSC
// 01.12 - clearLayer uses clearButtonMap (sync) not pattrReset (async) — pattrReset
//         fired MaxobjListeners outside the _suppressListeners window
// 01.13 - executeCancel: Task-deferred reset of _suppressListeners + dataLayer.suppressOSC
//         Root cause: message("set",0) schedules MaxobjListener callbacks ASYNCHRONOUSLY;
//         they arrive after executeCancel() returns, after _suppressListeners was reset.
//         Fix: both flags stay true until a 10ms Task fires, covering all async callbacks.
// 01.14 - Organ-level CANCEL: iterate manuals → /Mx/S 0 + divisionsAll → /Dx/S 0
//         Was: getSinuaPath(organCtx)="" → cancelOSCBundle("/S") → invalid "/S 0"
//         formatContextInfo: divisionsAll context now shows "DIVISIONS" (was "ORGAN")
// 01.15 - parseTremulants: extract Name field (was only DivisionName) → label shows correct name
//         Tremulant/Controller OSC: use scheduleOSC/sendOSCDirect (was queueOrganCommand → no output)
//         Tremulant: /T ±ID (same sign convention as stops)
//         Controller: /C <ID> <value> via sendOSCDirect (continuous, bypasses cooldown)
//         +Layer deferred probe: 200ms Task retry if bpatcher loads async
//         Reset: restore all manuals to default 4 layers + suppress OSC during visual clear
// 01.16 - capturePreset / recallPreset exposed in public API; fixed smart-quote SyntaxError
// 01.17 - Fix preset_menu deleted: add "preset_menu" to clearGUIObjects keepObjects
//         Fix recall suppress timing: Task-deferred reset (same 10ms window as cancel)
//         Root cause: applyLayerStateToGUI fires MaxobjListener callbacks ASYNCHRONOUSLY;
//         synchronous _suppressListeners=false let them through as real stop events.
// 01.18 - Add _suppressListeners guard to controller + tremulant MaxobjListeners.
//         Root cause: sendControllerOSC uses sendOSCDirect (bypasses _oscSuppressed);
//         controller dial callbacks fired OSC during recall GUI-update phase (double-send).
//         Same guard added to tremulant on-button + speed-dial (eliminates duplicate logs).
// 01.19 - capturePreset: replace getattr("_parameter_value") with DataLayer + stopDivState cache.
//         getattr is unreliable for live.text inside nested bpatchers → all stops read as OFF.
//         Movable stops now read from DataLayer.organState.stops[id].state (authoritative).
//         Div-routing buttons read from stopDivState {divKey→bool} updated by MaxobjListeners.
//         applyLayerStateToGUI also writes back to stopDivState so next capture is consistent.
// 01.20 - Fix capturePreset all-layers-same-stops: DataLayer.stops is flat (no per-layer info).
//         Add per-layer stopState {varname→bool} cache alongside stopDivState.
//         Movable stop listeners update stopState after _suppressListeners check.
//         applyLayerStateToGUI writes both stopState and stopDivState synchronously.
//         preset_menu: reuse existing or create+connect to presetMenuSelect in createMainHeader.
//         SINUA exports getPresetMenu() → Universal.js passes direct MaxObj ref to organStorage.
//         gamut_storage_organ v00.05: init(patcher, mod, menuRef) uses direct ref in findPresetMenu.
// 01.21 - buildRecallQueue: always send /D 0 per layer (remove "only if activeDivs>0" guard)
//         so empty-div presets correctly CLEAR existing routing (mirrors /S 0 stop-clear).
//         applyLayerStateToGUI: add diagnostic post() for div keys/IDs (temporary, for testing).
// 01.22 - Division stops fully captured and recalled:
//         createStopArray: optional stateCache param → {varname→bool} updated by listeners.
//         createDivisionBpatcher: creates stopState={}, passes to createStopArray, returns it.
//         capturePreset: iterates guiObjects.divisions → preset.divStops {divID: [stopIDs]}.
//         buildRecallQueue: new section 2b sends /D2/S 0 id… for each division.
//         recallPreset: calls applyDivisionStateToGUI for each division (visual + cache update).
//         applyDivisionStateToGUI: new function mirrors applyLayerStateToGUI for divisions.
// 29.05.2026

autowatch = 1;

function createSINUAModuleWithDI(common, dataLayer, context) {
    if (!common || !dataLayer || !context) {
        throw new Error("SINUA module requires Common, DataLayer, and Context dependencies");
    }
    
    var organState = {
        name: "No Organ Loaded",
        filepath: null,
        cachedStops: { movable: [], divisions: [] },  // reused by +Layer without DataLayer round-trip
        layerStopFilename: null  // generated layer_stops_{organ}.maxpat, reused across all layers
    };
    var guiObjects = {};
    var listeners = []; // Global listener tracking for cleanup
    var stopRouteReceive = null; // The single "receive organ_stops" box in context.patcher
    // When true, MaxobjListener callbacks in executeStopAction / executeDivisionAction do nothing.
    // Set during updateUIStopsOff() so visual clear does NOT trigger OSC output.
    var _suppressListeners = false;
    
    // ================================================================================================
    // CONTEXT HELPER FUNCTIONS
    // ================================================================================================
    
    function createStopContext(stopID, divisionID, manualID, layerID) {
        var ctx = context.createContextCommand(manualID, layerID, 'stop');
        ctx.stopID = stopID;
        ctx.divisionID = divisionID;
        return ctx;
    }
    
    function createActionContext(manualID, layerID, divisionID) {
        var ctx = context.createContextCommand(manualID, layerID, 'action');
        // createContextCommand does not handle divisionID — add it manually
        if (divisionID !== null && divisionID !== undefined) {
            ctx.divisionID = divisionID;
            ctx.commandPath = '/D' + divisionID + '/';
        }
        return ctx;
    }
    
    // ================================================================================================
    // ORGAN LOADING
    // ================================================================================================
    
    function loadOrgan(organData, filepath) {
        var tLoad = Date.now();
        common.log(common.LOG_LEVEL.INFO, "Loading SINUA organ with context awareness...");

        if (filepath) {
            organState.filepath = filepath;
            organState.name = common.extractOrganNameFromPath(filepath);
        }

        try {
            var t0 = Date.now();
            var parsedData = parseOrganData(organData);
            var t1 = Date.now();

            parsedData.type = "SINUA";
            parsedData.name = organState.name;

            // Cache stop lists so +Layer can recreate layers without DataLayer round-trip
            organState.cachedStops = {
                movable:   parsedData.stops.movable   || [],
                divisions: parsedData.stops.divisions || []
            };

            dataLayer.populateStateFromOrganData(parsedData);
            var t2 = Date.now();

            clearGUI();
            var t3 = Date.now();

            var result = generateGUI(parsedData);
            var t4 = Date.now();

            post("⏱ LOAD total=" + (t4-tLoad) + "ms  [parse=" + (t1-t0) + "  populate=" + (t2-t1) + "  clearGUI=" + (t3-t2) + "  generateGUI=" + (t4-t3) + "]\n");
            return result;

        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "SINUA loadOrgan error: " + error.message);
            return false;
        }
    }
    
    function parseOrganData(organData) {
        var parsed = {};

        parsed.controllers = parseControllers(organData.Controllers);
        parsed.tremulants = parseTremulants(organData.Tremulants);
        parsed.stops = parseStops(organData.Stops, dataLayer.getIncludeTransmissions());

        // DIVISIONS PANEL: only divisions that have fixed (non-movable) stops.
        // DIV buttons in layers derive from the same list — organs with only movable
        // stops (like Malmö) get no division panel AND no DIV buttons.
        parsed.divisions = parseDivisions(parsed.stops.fixed, organData.Divisions);
        parsed.stops.divisions = parseDivisionStops(parsed.stops, parsed.divisions);

        parsed.manuals = parseManuals(organData.Manuals);

        return parsed;
    }
    
    function parseControllers(controllerData) {
        if (!controllerData) return [];
        return controllerData.map(function(controller) {
            return {
                ip: controller.IP,
                pins: controller.Pins,
                name: controller.Description
            };
        });
    }
    
    function parseTremulants(tremulantData) {
        if (!tremulantData) return [];
        return tremulantData.map(function(tremulant, index) {
            return {
                tremulantID: index + 1,
                name:        tremulant.Name       || tremulant.DivisionName || ("Trem " + (index + 1)),
                divisionName: tremulant.DivisionName || tremulant.Name || null,
                divisionID:  tremulant.DivisionID || null
            };
        });
    }
    
    function parseStops(stopData, includeTransmissions) {
        var stops = { fixed: [], movable: [] };
        if (!stopData) return stops;
        
        var filteredStops = includeTransmissions ? stopData : 
        stopData.filter(function(stop) {
            return !stop.Sources || !stop.Sources[0] || 
            !stop.Sources[0].hasOwnProperty('Stop');
        });
        
        filteredStops.forEach(function(stop) {
            var name    = stop.Name    || stop.name    || "";
            var stopID  = stop.StopID  || stop.stopID  || stop.id || "";
            var divID   = stop.DivisionID || stop.divisionID || null;
            var movableRaw = (stop.Movable !== undefined) ? stop.Movable : stop.movable;
            var movable = (movableRaw === true) || (movableRaw === 1) ||
                          (movableRaw === "true") || (movableRaw === "True");
            var parsed = {
                name:        name,
                divisionID:  divID,
                stopID:      stopID,
                short_label: stopID + " " + name
            };

            if (movable) {
                stops.movable.push(parsed);
            } else {
                stops.fixed.push(parsed);
            }
        });
        
        return stops;
    }
    
    // TODO: we could provide the context and sinua command for division stops already here ! 
    function parseDivisions(stopData, divisionData) {
        if (!Array.isArray(stopData) || !Array.isArray(divisionData)) return [];
        
        var activeDivisionIDs = [];
        stopData.forEach(function(stop) {
            if (stop.divisionID && activeDivisionIDs.indexOf(stop.divisionID) === -1) {
                activeDivisionIDs.push(stop.divisionID);
            }
        });
        
        var divisions = [];
        divisionData.forEach(function(division) {
            // normalize: JSON may use DivisionID or divisionID
            var dID  = division.DivisionID || division.divisionID || division.id;
            var name = division.Name || division.name || ("Division " + dID);
            if (activeDivisionIDs.indexOf(dID) !== -1) {
                var divisionStops = stopData.filter(function(stop) {
                    return stop.divisionID === dID;
                });
                divisions.push({
                    divisionID: dID,
                    name: name,
                    stops: divisionStops
                });
            }
        });
        
        return divisions.sort(function(a, b) { return a.divisionID - b.divisionID; });
    }

    function parseDivisionStops(stopData, divisionData){
        if(!divisionData) return []; 

        divisionStops = []; 
        divisionData.forEach(function(division, index) {
            divisionStops.push({
                name: "DIV"+division.divisionID,
                stopID: "division"+division.divisionID,
                short_label: "DIV"+division.divisionID,
                divisionID: division.divisionID  // numeric ID for OSC /M/L/D commands
            });
        }); 
        return divisionStops;
    }
    
    // Format a raw manual name into the display label:
    //   ManualID 0 (Pedal/Pedal/P/…) → "P"
    //   ManualID 1+ with name "I", "II", "III"… → "MAN I", "MAN II", …
    //   Other names kept as-is.
    function formatManualLabel(rawName, manualID) {
        var n = (rawName || "").trim();
        // Pedal heuristic: ID 0, or name starts with "P" or contains "ped" (case-insensitive)
        if (manualID === 0 || /^p(ed|edal)?$/i.test(n)) return "P";
        // Roman-numeral-only names get "MAN " prefix
        if (/^[IVX]+$/i.test(n)) return "MAN " + n.toUpperCase();
        // Anything already containing "MAN" or "MANUAL" → return as-is
        if (/man/i.test(n)) return n;
        // Fallback: prefix with "MAN "
        return "MAN " + n;
    }

    function parseManuals(manualData) {
        if (!manualData) {
            return [
                {"manualID": 0, "name": "P",     "keys": 30, "midiChannel": 1},
                {"manualID": 1, "name": "MAN I",  "keys": 68, "midiChannel": 2},
                {"manualID": 2, "name": "MAN II", "keys": 68, "midiChannel": 3}
            ];
        }

        return manualData.map(function(manual, index) {
            var id      = (manual.ManualID !== undefined) ? manual.ManualID
                        : (manual.manualID !== undefined) ? manual.manualID
                        : index;
            var rawName = manual.Name || manual.name || ("Manual " + (index + 1));
            return {
                manualID:    id,
                name:        formatManualLabel(rawName, id),
                keys:        manual.keys  || manual.Keys  || 61,
                midiChannel: manual.midiChannel || manual.MidiChannel || (index + 1)
            };
        });
    }
    
    // ================================================================================================
    // GUI MANAGEMENT
    // ================================================================================================
    
    function clearGUI() {
        // Remove the global stop-routing receive before clearing other objects
        if (stopRouteReceive && context.patcher) {
            try {
                context.patcher.remove(stopRouteReceive);
            } catch(e) {
                // Ignore — object may already be gone after patcher clear
            }
            stopRouteReceive = null;
        }

        if (context.patcher) {
            common.clearGUIObjects(context.patcher, ["organ_name_display", "preset_menu", "presetControl", "organ_dialog"]);
        }

        cleanupAllListeners();
        guiObjects = {};
        common.log(common.LOG_LEVEL.INFO, "GUI cleared with listener cleanup");
    }
    
    function cleanupAllListeners() {
        listeners.forEach(function(listener) {
            if (listener && typeof listener.remove === 'function') {
                try {
                    listener.remove();
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        });
        listeners = [];
    }
    
    function addListener(listener) {
        if (listener) {
            listeners.push(listener);
        }
        return listener;
    }
    
    function generateGUI(organData) {
        if (!context.patcher) {
            common.log(common.LOG_LEVEL.WARN, "No patcher context - skipping GUI");
            return true;
        }

        // Reset GEOMETRY cache — must be first so all dimension calculations use fresh values.
        // Without this, fixed cache keys ("man", "layer_1" … "layer_4", "col_width_N") retain
        // stale values from the previously loaded organ, causing wrong bpatcher sizes.
        common.GEOMETRY.resetForNewOrgan();

        var G = common.GEOMETRY;
        var hasControllers = organData.controllers && organData.controllers.length > 0;
        var hasTremulants  = organData.tremulants  && organData.tremulants.length  > 0;
        var hasDivisions   = organData.divisions   && organData.divisions.length   > 0;
        var hasManuals     = organData.manuals && organData.stops && organData.stops.movable &&
                             organData.stops.movable.length > 0;

        // --- Dynamic Y layout: compute section start positions ---------------
        // Controls zone: header label (mainControls=60) + buttons reach to ~y=140
        var CTRL_ZONE_BOTTOM = 160; // below the 3 stacked buttons (at rows=5 → y=100+40=140, +gap)
        var SECTION_GAP      = 10;

        // Controllers row stays fixed — side-by-side with the left-hand buttons
        G.rows.controllers = 100;

        var currentY = CTRL_ZONE_BOTTOM;

        // Always stamp G.rows.divisions so stale values from a previous organ never leak.
        G.rows.divisions = currentY;
        if (hasDivisions) {
            currentY += G.stops.h * common.MAX_STOPS_PER_COLUMN + SECTION_GAP;
        }

        G.rows.manualSelector = currentY;
        currentY += G.stops.h + SECTION_GAP;
        G.rows.manuals = currentY;

        common.log(common.LOG_LEVEL.INFO,
            "Y layout — divisions:" + G.rows.divisions +
            " manualSelector:" + G.rows.manualSelector +
            " manuals:" + G.rows.manuals);
        // -------------------------------------------------------------------

        try {
            var tG0 = Date.now();
            guiObjects.header = createMainHeader(context.patcher, organState.name);
            var tG1 = Date.now();

            if (hasControllers) {
                guiObjects.controllers = createControllerSection(context.patcher, organData.controllers);
            } else {
                G._calculatedWidths.controllers = 0;
            }
            var tG2 = Date.now();

            if (hasTremulants) {
                guiObjects.tremulants = createTremulantSection(context.patcher, organData.tremulants);
            }
            var tG3 = Date.now();

            if (hasDivisions) {
                guiObjects.divisions = createDivisionSection(context.patcher, organData.divisions);
            }
            var tG4 = Date.now();

            // Set up ONE global receive in main patcher → js inlet 1 (replaces per-button listeners)
            setupStopRouting();

            // Resolve path to pre-built Python-generated stop file (no runtime generation)
            organState.layerStopFilename = null;
            if (hasManuals) {
                organState.layerStopFilename = resolveLayerStopFilename(organState.name);
                post("Layer stop file: " + (organState.layerStopFilename || "NOT FOUND") + "\n");
            }

            if (hasManuals) {
                guiObjects.manuals = createManualSection(context.patcher, organData.manuals, organData.stops);
                common.log(common.LOG_LEVEL.INFO, "Created " + organData.manuals.length + " manual bpatchers");
            } else {
                common.log(common.LOG_LEVEL.WARN, "No manuals or movable stops found - skipping manual section");
            }
            var tG5 = Date.now();

            common.log(common.LOG_LEVEL.INFO, "GUI built — divisions:" + hasDivisions +
                " manualSelectorY:" + G.rows.manualSelector + " manualsY:" + G.rows.manuals);

            resizeWindowToContent(organData, G, hasDivisions, hasManuals, hasControllers);
            var tG6 = Date.now();

            post("⏱ GUI sections: header=" + (tG1-tG0) + "ms  ctrl=" + (tG2-tG1) + "ms  trem=" + (tG3-tG2) + "ms  div=" + (tG4-tG3) + "ms  manuals=" + (tG5-tG4) + "ms  resize=" + (tG6-tG5) + "ms\n");
            return true;
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "GUI creation error: " + error.message);
            return false;
        }
    }

// *** WINDOW RESIZE ***

    function resizeWindowToContent(organData, G, hasDivisions, hasManuals, hasControllers) {
        if (!context.patcher || !context.patcher.wind) return;

        var contentW = G.margin.x; // minimum: left-hand button column
        var contentH = 200;        // minimum height

        try {
            // Controllers width
            if (hasControllers && organData.controllers.length > 0) {
                var ctrlPos = G.sinua.controllers.bpatcher(organData.controllers.length);
                contentW = Math.max(contentW, ctrlPos.x + ctrlPos.w);
            }

            // Divisions width (cache hit — already computed during GUI build)
            if (hasDivisions) {
                var divPos = G.sinua.divisions.bpatcher(organData.divisions);
                contentW = Math.max(contentW, divPos.w);
                contentH = Math.max(contentH, divPos.y + divPos.h + 10);
            }

            // Manuals width + height (cache hit)
            if (hasManuals) {
                var manPos = G.sinua.manuals.bpatcher(
                    organData.stops.movable, organData.stops.divisions);
                contentW = Math.max(contentW, manPos.w);
                contentH = Math.max(contentH, manPos.y + manPos.h + 20);
            }

            context.patcher.wind.size = [contentW + 10, contentH];
            common.log(common.LOG_LEVEL.INFO,
                "Window resized: " + (contentW + 10) + " x " + contentH);

        } catch (e) {
            common.log(common.LOG_LEVEL.WARN, "Window resize failed: " + e.message);
        }
    }

// *** MAIN HEADER ***

    function createMainHeader(p, organName) {
        var label = common.createLiveComment(p, common.GEOMETRY.margin.x, common.GEOMETRY.rows.mainControls,
            200, 20, "organNameLabel", organName);

        var context = createActionContext(null, null, null); // Organ-level context

        var fs = common.GEOMETRY.button.fontsize;
        var reset  = createGUIButton(p, common.GEOMETRY.button.pos(0, 1), "reset",  "RST",    context, fs.larger); // 20 — 3 chars, prominent
        var panic  = createGUIButton(p, common.GEOMETRY.button.pos(0, 3), "panic",  "PANIC",  context, fs.large);  // 11 — 5 chars, readable
        var cancel = createGUIButton(p, common.GEOMETRY.button.pos(0, 5), "cancel", "CANCEL", context, fs.small);  //  8 — 6 chars

        // Preset selector menu.
        // clearGUIObjects keeps "preset_menu" in its keepObjects list, so any user-placed
        // live.menu with scripting name "preset_menu" survives across organ reloads.
        // If no such menu exists (first load or wrong scripting name), we create one here
        // and wire it programmatically to the "presetMenuSelect" object.
        // If one already exists, we reuse it (preserving the user's manual wiring).
        var pmX = common.GEOMETRY.margin.x + 220;   // right of the 200px organ name label
        var pmY = common.GEOMETRY.rows.mainControls; // same row as label
        var pmW = 220;
        var pmH = common.GEOMETRY.stops.h;          // one stop-height (20px)
        // Search below and above p: the menu may have been moved into a
        // presetControl bpatcher, where a plain getnamed cannot see it —
        // and building a second one there would leave two menus fighting.
        var presetMenu = common.findNamedAround(p, "preset_menu");  // reuse if already in this patcher
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
                    // Wire to presetMenuSelect (prepend/route that feeds js inlet 0)
                    var presetMenuSelectObj = common.findNamedAround(p, "presetMenuSelect");
                    if (presetMenuSelectObj) {
                        try {
                            p.connect(presetMenu, 0, presetMenuSelectObj, 0);
                            post("createMainHeader: preset_menu created and connected to presetMenuSelect\n");
                        } catch(ce) {
                            post("createMainHeader: preset_menu created; connect to presetMenuSelect failed: " + ce.message + "\n");
                        }
                    } else {
                        post("createMainHeader: preset_menu created; presetMenuSelect not found — wire manually\n");
                    }
                }
            } catch(e) {
                post("createMainHeader: preset_menu creation failed: " + e.message + "\n");
            }
        } else {
            post("createMainHeader: reusing existing preset_menu\n");
        }

        return { label: label, presetMenu: presetMenu, reset: reset, panic: panic, cancel: cancel };
    }

// *** DIVISION SECTION ***
    
    function createDivisionSection(p, divisionData) {
        var pos = common.GEOMETRY.sinua.divisions.bpatcher(divisionData);
        var bpatcher = common.createBpatcher(p, pos.x, pos.y, pos.w, pos.h, "divisions");
        if (!bpatcher) return null;

        var context = createActionContext(null, null, null);
        context.divisionsAll = true;  // section-level cancel: clear all divisions, not global

        common.log(common.LOG_LEVEL.DEBUG, "createDivisionSection(): context: "+Object.keys(context))

        var fs = common.GEOMETRY.button.fontsize;
        var labelPos = common.GEOMETRY.label;
        var label  = common.createLiveComment(bpatcher.subpatcher(), labelPos.x, labelPos.y, labelPos.w, labelPos.h, "label", "DIVISIONS");
        var cancel = createGUIButton(bpatcher.subpatcher(), common.GEOMETRY.button.pos(0, 1), "cancel", "CANCEL", context, fs.small);
        
        var divisions = [];
        divisionData.forEach(function(division, index) {
            var divPos = common.GEOMETRY.sinua.divisions.subpatcher(divisionData, index);
            divisions.push(createDivisionBpatcher(bpatcher.subpatcher(), 
                divPos.x, divPos.y, divPos.w, divPos.h, division));
        });
        
        return { bpatcher: bpatcher, cancel: cancel, divisions: divisions};
    }
    

    function createDivisionBpatcher(p, x, y, w, h, divisionData) {
        var bpatcher = common.createBpatcher(p, x, y, w, h, "division" + divisionData.divisionID);
        if (!bpatcher) return null;
        var sp = bpatcher.subpatcher();
        try { sp.openinpresentation = 1; } catch(e) {}

        var labelPos = common.GEOMETRY.sinua.divisions.subpatcherLabel;
        var label = common.createLiveComment(sp, labelPos.x, labelPos.y, labelPos.w, labelPos.h,
            "division_label_" + divisionData.divisionID,
            "D" + divisionData.divisionID + " " + divisionData.name);

        var context = createActionContext(null, null, divisionData.divisionID);
        var cancel  = createGUIButton(sp, common.GEOMETRY.sinua.divisions.cancel, "cancel", "C", context);

        var stopArrayX = typeof common.GEOMETRY.sinua.divisions.stopArray.x === 'function' ?
            common.GEOMETRY.sinua.divisions.stopArray.x() :
            common.GEOMETRY.sinua.divisions.stopArray.x;

        // stopState: {varname → bool} — per-division stop ON/OFF cache for preset capture.
        // Updated by MaxobjListener callbacks (via stateCache arg to createStopArray) when
        // _suppressListeners is false; written directly by applyDivisionStateToGUI during recall.
        var stopState = {};
        var stopButtonMap = createStopArray(sp, stopArrayX, common.GEOMETRY.stops.h,
            divisionData.stops, divisionData.divisionID, null, null, stopState);

        // stopButtonMap holds direct newdefault() refs — message("set", 0) works reliably
        // on direct refs regardless of nesting depth.  No pattr/pattrforward/sp.connect
        // needed here; those create visible patch cables in the embedded patcher.
        return { bpatcher: bpatcher, label: label, context: context,
                 stopButtonMap: stopButtonMap, stopState: stopState };
    }

// *** MANUAL SECTION ***
    
    function createManualSection(p, manualData, stopData) {
        var manuals = [];
        var tMS = Date.now();

        manualData.forEach(function(manual, index) {
            var tM = Date.now();
            var manualBpatcher = createManualBpatcher(p, manual, stopData);
            post("  ⏱ manual[" + index + "] " + manual.name + ": " + (Date.now()-tM) + "ms\n");
            if (manualBpatcher) {
                manuals.push(manualBpatcher);
            }
        });

        var tSel = Date.now();
        var selector = createManualSelector(p, manualData);
        setupManualSelector(selector, manuals);
        post("  ⏱ selector setup: " + (Date.now()-tSel) + "ms  manualSection total: " + (Date.now()-tMS) + "ms\n");

        return { manuals: manuals, selector: selector };
    }
    
    function createManualBpatcher(p, manualData, stopData) {
        var pos = common.GEOMETRY.sinua.manuals.bpatcher(stopData.movable, stopData.divisions);
        var bpatcher = common.createBpatcher(p, pos.x, pos.y, pos.w, pos.h, 
            manualData.name, 1);
        if (!bpatcher) return null;
        
        var context = createActionContext(manualData.manualID, null, null);

        var fs = common.GEOMETRY.button.fontsize;
        var labelPos = common.GEOMETRY.label;
        var label  = common.createLiveComment(bpatcher.subpatcher(), labelPos.x, labelPos.y, labelPos.w, labelPos.h, "label", manualData.name);
        var panic  = createGUIButton(bpatcher.subpatcher(), common.GEOMETRY.button.pos(0, 1), "panic",  "PANIC",  context, fs.large);
        var cancel = createGUIButton(bpatcher.subpatcher(), common.GEOMETRY.button.pos(0, 3), "cancel", "CANCEL", context, fs.small);

        var layers = [];
        var tLayers = Date.now();
        for (var i = 1; i <= common.GEOMETRY.sinua.manuals.defaultLayersPerManual; i++) {
            var layer = createLayerBpatcher(bpatcher.subpatcher(), i, stopData, manualData.manualID);
            if (layer) {
                layers.push(layer);
            }
        }
        post("    ⏱ all " + layers.length + " layers for " + manualData.name + ": " + (Date.now()-tLayers) + "ms  (stops=" + stopData.movable.length + " divs=" + stopData.divisions.length + ")\n");

    // Create manual object first
        var manual = {
            bpatcher: bpatcher,
            manualData: manualData,
            panic: panic, 
            cancel: cancel, 
            layers: layers,
            context: context
        };

    // Fixed: Pass complete manual object in context
        var createLayerContext = createActionContext(manualData.manualID, null, null);
    createLayerContext.manualRef = manual; // Store manual reference
    
    var createLayer = createGUIButton(bpatcher.subpatcher(), 
        common.GEOMETRY.button.pos(0, 6), "createLayer", "+Layer", createLayerContext);
    
    manual.createLayer = createLayer; // Add to manual object
    
    return manual;
}

// Attach MaxobjListeners to all stop and division buttons in a loaded layer_stops bpatcher.
// Called immediately after a successful probe, OR from the 200ms deferred Task for +Layer.
// Mirrors Python generator's duplicate-ID suffix logic exactly.
//
// stopStateCache (optional) — {varname → bool} updated by each movable stop listener.
//   Lets capturePreset() read per-layer ON/OFF state without relying on getattr() or the flat
//   DataLayer (which has no per-layer resolution).
//
// divStateCache (optional) — {divKey → bool} updated by each div-routing listener.
//   applyLayerStateToGUI also writes both caches synchronously during recall.
function connectLayerStopListeners(innerPatcher, stopData, stopButtonMap, manualID, layerID, stopStateCache, divStateCache) {
    var seenStopIDs = {};
    stopData.movable.forEach(function(stop, index) {
        var sid = stop.stopID;
        var varname = seenStopIDs[sid] ? ("stop" + sid + "_" + index) : ("stop" + sid);
        seenStopIDs[sid] = true;

        var liveText = innerPatcher.getnamed(varname);
        if (liveText) {
            stopButtonMap[varname] = liveText;
            var stopCtx = createStopContext(stop.stopID, stop.divisionID, manualID, layerID);
            addListener(new MaxobjListener(liveText, function(data) {
                if (_suppressListeners) return;   // during recall: applyLayerStateToGUI handles cache
                if (stopStateCache) stopStateCache[varname] = Boolean(data.value);
                executeStopAction(stop.stopID, Boolean(data.value), stopCtx);
            }));
        }
    });
    // Division routing buttons — varname "stopdivision<N>" → /Mx/Lx/D ±divID
    stopData.divisions.forEach(function(div) {
        var divVarname = "stop" + div.stopID;  // e.g. "stopdivision1"
        var divKey    = div.stopID;            // e.g. "division1"  (key in stopButtonMap)
        var divBtn = innerPatcher.getnamed(divVarname);
        if (divBtn) {
            stopButtonMap[divKey] = divBtn;
            var numDivID = (div.divisionID !== undefined && div.divisionID !== null)
                ? div.divisionID
                : parseInt(div.stopID.replace("division", ""), 10);
            var divCtx = createStopContext(div.stopID, numDivID, manualID, layerID);
            addListener(new MaxobjListener(divBtn, function(data) {
                // Cache div-routing state so capturePreset() doesn't need getattr()
                if (divStateCache) divStateCache[divKey] = Boolean(data.value);
                if (_suppressListeners) return;
                executeDivisionAction(numDivID, Boolean(data.value), divCtx);
            }));
        }
    });
}

function createLayerBpatcher(p, layerID, stopData, manualID) {
    var tL0 = Date.now();
    var pos = common.GEOMETRY.sinua.layers.bpatcher(layerID, stopData.movable, stopData.divisions);
    var bpatcher = common.createBpatcher(p, pos.x, pos.y, pos.w, pos.h, "layer" + layerID);
    if (!bpatcher) return null;
    var sp = bpatcher.subpatcher();
    // Presentation mode: only @presentation=1 objects are visible — hides routing cables
    try { sp.openinpresentation = 1; } catch(e) {}
    var tL1 = Date.now();

    var actionCtx = createActionContext(manualID, layerID, null);  // renamed to avoid shadowing outer context
    var fs = common.GEOMETRY.button.fontsize;
    var labelPos = common.GEOMETRY.label;
    var label  = common.createLiveComment(sp, labelPos.x, labelPos.y, labelPos.w, labelPos.h, "label", "LAYER " + layerID);
    var panic  = createGUIButton(sp, common.GEOMETRY.button.pos(0, 1), "panic",  "PANIC",  actionCtx, fs.large);
    var cancel = createGUIButton(sp, common.GEOMETRY.button.pos(0, 3), "cancel", "CANCEL", actionCtx, fs.small);
    var tL2 = Date.now();

    // *** MOVABLE STOPS: load from pre-built file (avoids N × newdefault calls) ***
    var stopButtonMap = {};
    // stopState:    {varname → bool} — per-layer movable stop ON/OFF, updated by MaxobjListener.
    //   DataLayer.stops is flat (no per-layer resolution), so this is the authoritative source.
    var stopState    = {};
    // stopDivState: {divKey  → bool} — div-routing button state, updated by MaxobjListener.
    var stopDivState = {};
    var sx = common.GEOMETRY.sinua.layers.stopArray.x();
    var G  = common.GEOMETRY;

    if (organState.layerStopFilename) {
        // Width must match the generated file layout:  movable cols + 1 gap col + div cols
        // (DIV_GAP_COLS = 1 in generate_layer_stops.py)
        var nMovCols  = Math.ceil(stopData.movable.length  / common.MAX_STOPS_PER_COLUMN);
        var nDivCols  = stopData.divisions.length > 0
                        ? Math.ceil(stopData.divisions.length / common.MAX_STOPS_PER_COLUMN) : 0;
        var gapCols   = stopData.divisions.length > 0 ? 1 : 0;
        var totalCols = nMovCols + gapCols + nDivCols;
        var stopsW = G.grid.multiColumnWidth(totalCols * common.MAX_STOPS_PER_COLUMN, G.columns.margin());
        var stopsH = G.stops.h * common.MAX_STOPS_PER_COLUMN;


        // Load the pre-built stop bpatcher from disk.
        // Use resolveStopFileNativePath() which builds an absolute path in the same format
        // as context.patcher.filepath (HFS on macOS, POSIX on others). This ensures Max can
        // resolve the file even when @name is called from a dynamic button-click context
        // (where filename-only search fails because the search root context is lost).
        var stopFilename = organState.layerStopFilename
            ? organState.layerStopFilename.replace(/.*[\/\\]/, '')  // extract filename only
            : null;
        // Prefer absolute native path; fall back to filename-only (works during initial load)
        var stopFileRef = stopFilename ? resolveStopFileNativePath(stopFilename) : null;

        var stopsBp = stopFileRef ? sp.newdefault(sx, 0, "bpatcher",
            "@name", stopFileRef,
            "@varname", "layer" + layerID,
            "@embed", 0,
            "@patching_rect", sx, 0, stopsW, stopsH,
            "@presentation_rect", sx, 0, stopsW, stopsH,
            "@presentation", 1
        ) : null;

        // pattrforward targets pattr "set" inside the stops bpatcher by its varname address.
        // Scripting name must be "layer<N>". Inside a subpatcher, NO leading :: —
        // relative address is  layer<N>::set  (leading :: is only for top-level / absolute paths).
        // pattrReset.message(0)  →  pattrforward sends 0 to  pattr "set"  inside "layer<N>"
        //   →  pattr outlets 0  →  [prepend set]  →  "set 0" to every live.text silently
        var pattrReset = stopFileRef ? sp.newdefault(0, -200, "pattrforward",
            "layer" + layerID + "::set"
        ) : null;

        var innerPatcher = stopsBp ? stopsBp.subpatcher() : null;

        // Probe: verify the first stop is actually present (guards against empty-patcher load)
        var probeStop = stopData.movable.length > 0 ? stopData.movable[0] : null;
        var fileLoadedOK = innerPatcher && probeStop &&
                           (innerPatcher.getnamed("stop" + probeStop.stopID) !== null);

        if (fileLoadedOK) {
            connectLayerStopListeners(innerPatcher, stopData, stopButtonMap, manualID, layerID, stopState, stopDivState);
            post("      L" + layerID + ": file OK — " +
                stopData.movable.length + " stops + " + stopData.divisions.length + " divs\n");
        } else if (stopsBp) {
            // Probe failed: file not yet loaded (shouldn't happen with absolute path, but guard).
            // Schedule a single 200ms retry. If that also fails the file is genuinely missing.
            post("      L" + layerID + ": probe failed — scheduling deferred listener attach (200ms)\n");
            (function(bp, sd, sbm, mID, lID, ss, sds) {
                var retryTask = new Task(function() {
                    var inner = bp.subpatcher();
                    var ps = sd.movable.length > 0 ? sd.movable[0] : null;
                    if (inner && ps && inner.getnamed("stop" + ps.stopID) !== null) {
                        connectLayerStopListeners(inner, sd, sbm, mID, lID, ss, sds);
                        post("      L" + lID + ": deferred probe OK — listeners connected\n");
                    } else {
                        post("      L" + lID + ": deferred probe ALSO failed — check file path\n");
                    }
                });
                retryTask.schedule(200);
            })(stopsBp, stopData, stopButtonMap, manualID, layerID, stopState, stopDivState);
        } else {
            // stopsBp is null = file not found — no overlap risk, safe to use createStopArray
            common.log(common.LOG_LEVEL.WARN,
                "L" + layerID + ": no bpatcher (file not found) — falling back to createStopArray");
            var movableMap = createStopArray(sp, sx, 0, stopData.movable, null, manualID, layerID);
            Object.keys(movableMap).forEach(function(id) { stopButtonMap[id] = movableMap[id]; });
        }
    } else {
        // No file available (e.g. +Layer called before organ reload)
        var movableMap = createStopArray(sp, sx, 0, stopData.movable, null, manualID, layerID);
        Object.keys(movableMap).forEach(function(id) { stopButtonMap[id] = movableMap[id]; });
    }
    var tL3 = Date.now();

    post("      ⏱ L" + layerID + ": bpatcher=" + (tL1-tL0) + "ms  buttons=" + (tL2-tL1) + "ms  stopsFile=" + (tL3-tL2) + "ms\n");

    return {
        bpatcher: bpatcher,
        layerID: layerID,
        panic: panic,
        cancel: cancel,
        context: actionCtx,
        pattrReset: pattrReset || null,  // pattrforward ::stops_<id>::set — clears all buttons in bpatcher
        stopButtonMap: stopButtonMap,    // listener references (movable stops + divs via getnamed)
        stopState:     stopState,        // {varname → bool} per-layer movable stop ON/OFF cache
        stopDivState:  stopDivState      // {divKey  → bool} div-routing button state cache
    };
}


// *** CONTROLLER SECTION ***

function createControllerSection(p, controllerData) {
    var pos = common.GEOMETRY.sinua.controllers.bpatcher(controllerData.length);
    var bpatcher = common.createBpatcher(p, pos.x, pos.y, pos.w, pos.h, "controllers");
    if (!bpatcher) return null;

    // Per-controller name label (replaces single "CONTROLLERS" header):
    // each column gets its own comment at y=0 so long names stay readable.
    // Position computed inline — no GEOMETRY method needed (avoids stale-module issues).
    var dw = common.GEOMETRY.sinua.controllers.dialW;
    var sh = common.GEOMETRY.stops.h;

    controllerData.forEach(function(controller, index) {
        var posCtl       = common.GEOMETRY.sinua.controllers.control(index);
        var controllerID = index + 1;

        // Name label — maxLength=100 so shortenString never adds "…";
        // Max's comment widget clips overflow naturally.
        common.createLiveComment(bpatcher.subpatcher(),
            index * dw, 0, dw, sh,
            "ctrl_label_" + controllerID, controller.name, 100, 9);

        // Dial shortname set to " " (space) so live.dial shows no competing label.
        // Range 0.0–1.0 (float); normalization happens in sendControllerOSC.
        var dial = common.createLiveDial(bpatcher.subpatcher(), posCtl.x, posCtl.y, posCtl.w, posCtl.h,
            "control" + controllerID, controller.name, " ", 0.0, 1.0);

        if (dial) {
            addListener(new MaxobjListener(dial, function(data) {
                if (_suppressListeners) return;  // silent GUI update during recall — no OSC
                // setControllerState handles OSC directly via sendControllerOSC (no Protocol Layer)
                dataLayer.setControllerState(controllerID, data.value);
            }));
        }
    });

    return { bpatcher: bpatcher };
}

// *** TREMULANT SECTION ***

function createTremulantSection(p, tremulantData) {
    var pos = common.GEOMETRY.sinua.tremulants.bpatcher(tremulantData.length);
    var bpatcher = common.createBpatcher(p, pos.x, pos.y, pos.w, pos.h, "tremulants");
    if (!bpatcher) return null;

    tremulantData.forEach(function(tremulant, index) {
        var tremPos = common.GEOMETRY.sinua.tremulants.subpatcher(index);
        createTremulantBpatcher(bpatcher.subpatcher(), tremPos.x, tremPos.y, tremPos.w, tremPos.h, 
            tremulant, index + 1);
    });

    return { bpatcher: bpatcher };
}

function createTremulantBpatcher(p, x, y, w, h, tremulantData, tremulantID) {
    var bpatcher = common.createBpatcher(p, x, y, w, h, "tremulant" + tremulantID);
    if (!bpatcher) return null;

    // Use Name field (e.g. "Trem OW") if available, fall back to DivisionName / generic
    var displayName = tremulantData.name || tremulantData.divisionName || ("Trem " + tremulantID);
    var label = bpatcher.subpatcher().newdefault(0, 0, "comment");
    label.message("set", displayName);

    var onPos = common.GEOMETRY.sinua.tremulants.on;
    var onButton = common.createLiveText(bpatcher.subpatcher(),
        onPos.x, onPos.y, onPos.w, onPos.h,
        "on", "on", "on", "ON");

    var speedPos = common.GEOMETRY.sinua.tremulants.speed;
    var speedDial = common.createLiveDial(bpatcher.subpatcher(),
        speedPos.x, speedPos.y, speedPos.w, speedPos.h,
        "speed", "speed", "speed", 0.0, 1.0);

    if (onButton && onButton.liveText) {
        addListener(new MaxobjListener(onButton.liveText, function(data) {
            if (_suppressListeners) return;  // silent GUI update during recall — no OSC
            var active = Boolean(data.value);
            var tremContext = createActionContext(null, null, tremulantData.divisionID);
            // setTremulantState sends OSC directly (sendTremulantOSC + sendTremulantSpeedOSC)
            dataLayer.setTremulantState(tremulantID, active, null, tremContext);
        }));
    }

    if (speedDial) {
        addListener(new MaxobjListener(speedDial, function(data) {
            if (_suppressListeners) return;  // silent GUI update during recall — no OSC
            var currentState = dataLayer.getTremulantState(tremulantID);
            var active = currentState ? currentState.active : false;
            var tremContext = createActionContext(null, null, tremulantData.divisionID);
            // setTremulantState sends OSC directly (sendTremulantOSC + sendTremulantSpeedOSC)
            dataLayer.setTremulantState(tremulantID, active, data.value, tremContext);
        }));
    }

    return { bpatcher: bpatcher, label: label, onButton: onButton, speedDial: speedDial };
}

// *** MANUAL SELECTOR ***

function createManualSelector(p, manualData) {
    var manualNames = manualData.map(function(manual) { return manual.name; });
    var pos = common.GEOMETRY.sinua.manualSelector.bpatcher(manualData.length);
    return common.createLiveTab(p, pos.x, pos.y, pos.w, pos.h, 
        "manualSelector", "manualSelector", "manualSelector", manualNames);
}

function setupManualSelector(selector, manuals) {
    if (!selector || !manuals) {
        common.log(common.LOG_LEVEL.ERROR, "setupManualSelector: Invalid parameters");
        return;
    }

    addListener(new MaxobjListener(selector, function(data) {
        switchToManual(data.value, manuals);
    }));

        // Show first manual by default and hide others
    if (manuals.length > 0) {
        selector.message("set", 1);
        switchToManual(1, manuals);

        common.log(common.LOG_LEVEL.INFO, 
            "Manual selector configured with " + manuals.length + " manuals");
    } else {
        common.log(common.LOG_LEVEL.WARN, "No manuals available for selector");
    }
}

function switchToManual(selectedIndex, manuals) {
    if (!context.patcher) {
        common.log(common.LOG_LEVEL.ERROR, "switchToManual: No patcher context");
        return;
    }

    if (selectedIndex < 0 || selectedIndex >= manuals.length) {
        common.log(common.LOG_LEVEL.WARN, "switchToManual: Invalid index " + selectedIndex);
        return;
    }

    manuals.forEach(function(manual, index) {
        if (manual && manual.bpatcher) {
            try {
                var visible = (index === selectedIndex) ? 1 : 0;
                // Use presentation visibility only — NOT script hide/show.
                // script hide fully deactivates the bpatcher in Max, which breaks
                // MaxobjListeners on buttons inside the hidden bpatcher even after
                // script show. Keeping all bpatchers Max-active (just invisible in
                // presentation) ensures listeners remain live for all manuals.
                manual.bpatcher.setboxattr("presentation", visible);
                if (index === selectedIndex) {
                    common.log(common.LOG_LEVEL.DEBUG, "Showing manual: " + (manual.bpatcher.varname || index));
                }
            } catch (error) {
                common.log(common.LOG_LEVEL.ERROR,
                    "Error switching manual " + index + ": " + error.message);
            }
        }
    });

    var manualName = (manuals[selectedIndex] && manuals[selectedIndex].manualData && manuals[selectedIndex].manualData.name)
        ? manuals[selectedIndex].manualData.name
        : "Manual " + selectedIndex;
    common.log(common.LOG_LEVEL.INFO, "Switched to: " + manualName);
}

// *** GUI CREATION HELPER ***

function createGUIButton(p, pos, type, display, context, fontsize){
    fontsize = fontsize || common.GEOMETRY.button.fontsize.large;
    var button = common.createLiveButton(p, pos.x, pos.y, pos.w, pos.h,
        type, type, type, display, fontsize);

    if (button && button.liveText) {
        addListener(new MaxobjListener(button.liveText, function(data) {
            if (data.value > 0) {
                executeGUIButton(type, context);
            }
        }));
    }
    var result = {};
    result[type] = button;
    return result;
}

// ── Stop colour helpers ────────────────────────────────────────────────────────
// Must match Python generate_layer_stops.py classification so in-memory stops
// look identical to the pre-built bpatcher buttons.

var STOP_REED_KEYWORDS = [
    "trompet", "posaune", "schalmei", "schalmey",
    "clarin", "klarinett",   // Clarine / Klarinette
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

// Apply bgcolor / activebgcolor to a live.text object.
// Max JS setattr() accepts multiple scalar args for a colour attribute (R G B A).
function applyStopColor(liveTextObj, colorClass) {
    try {
        // Pattern from working organ-control code:
        //   activebgcolor   = tinted hint when stop is OFF (low alpha)
        //   activebgoncolor = full colour when stop is ON  (alpha 1.0)
        //   activetextoncolor = text colour when ON
        if (colorClass === "reed") {
            liveTextObj.setattr("activebgcolor",    1.0, 0.0, 0.0, 0.2);  // subtle red when OFF
            liveTextObj.setattr("activebgoncolor",  1.0, 0.0, 0.0, 1.0);  // full red when ON
            liveTextObj.setattr("activetextoncolor",1.0, 1.0, 1.0, 1.0);  // white text when ON
        } else if (colorClass === "aliquot") {
            liveTextObj.setattr("activebgcolor",    0.0, 0.57, 0.57, 0.2); // subtle cyan when OFF
            liveTextObj.setattr("activebgoncolor",  0.0, 1.0,  1.0,  1.0); // full cyan when ON
            liveTextObj.setattr("activetextoncolor",0.0, 0.0,  0.0,  1.0); // black text when ON
        } else if (colorClass === "div") {
            // DIV routing buttons — gold/amber style (same as "singletone" in original code)
            liveTextObj.setattr("activebgcolor",    0.57, 0.57, 0.57, 0.3); // subtle grey when OFF
            liveTextObj.setattr("activebgoncolor",  0.95, 0.66, 0.0,  0.9); // gold when ON
            liveTextObj.setattr("activetextoncolor",0.0,  0.0,  0.0,  1.0); // black text when ON
        }
        // "normal" → keep Max defaults, no setattr needed
    } catch(e) {
        post("applyStopColor: setattr failed: " + e + "\n");
    }
}

// *** LEGACY: still used where jsbox routing is unavailable ***
// stateCache (optional) — {varname → bool} object that receives live ON/OFF state.
// Pass a plain {} from the calling context (division bpatcher) to enable preset capture.
function createStopArray(p, startX, startY, stopData, divisionID, manualID, layerID, stateCache) {
    if (!p || !stopData) return {};

    var currentColumn = 0;
    var currentRow = 0;
    var buttonMap = {}; // key → live.text object, used by CANCEL to clear visually
    var seenIDs = {};   // track duplicate stopIDs (e.g. Amsterdam: all IDs=165)

    stopData.forEach(function(stop, index) {
        var stopContext = createStopContext(stop.stopID, divisionID || stop.divisionID, manualID, layerID);

        // Unique varname: first occurrence → "stop<ID>", duplicates → "stop<ID>_<index>"
        // Mirrors the fileLoadedOK branch above and generate_layer_stops.py suffix logic.
        // Prevents Max from auto-renaming objects to "stop165[1]", "stop165[2]" etc.
        var sid = stop.stopID;
        var varname = seenIDs[sid] ? ("stop" + sid + "_" + index) : ("stop" + sid);
        seenIDs[sid] = true;

        var marginX = typeof common.GEOMETRY.columns.margin === 'function' ?
        common.GEOMETRY.columns.margin() : common.GEOMETRY.columns.margin;

        var pos = common.GEOMETRY.grid.pos(currentRow, currentColumn, marginX, marginX);
        var x = startX + pos.x;
        var y = startY + pos.y;

        // Label: "ID Name" — matches generate_layer_stops.py format
        var stopLabel = stop.stopID + " " + stop.name;
        var stopObj = common.createLiveText(p, x, y,
            common.GEOMETRY.stops.w, common.GEOMETRY.stops.h,
            varname, stopLabel, stopLabel, stopLabel, 10);

        if (stopObj && stopObj.liveText) {
            // Apply colour coding (reed = dark red, aliquot = dark blue/cyan)
            applyStopColor(stopObj.liveText, stopColorClass(stop.name));
            // Use varname as key — unique even when stopIDs are duplicated.
            // clearButtonMap iterates all keys, so every button gets cleared.
            buttonMap[varname] = stopObj.liveText;
            addListener(new MaxobjListener(stopObj.liveText, function(data) {
                // Update stateCache while not suppressed (during recall applyDivisionStateToGUI
                // writes the cache directly, listener writes are ignored during suppression).
                if (!_suppressListeners && stateCache) stateCache[varname] = Boolean(data.value);
                executeStopAction(stop.stopID, Boolean(data.value), stopContext);
            }));
        }

        currentRow++;
        if (currentRow >= common.MAX_STOPS_PER_COLUMN) {
            currentColumn++;
            currentRow = 0;
        }
    });

    return buttonMap; // {varname → live.text object}
}

// *** ROUTING VERSION: no per-button MaxobjListeners ***
// Two-stage routing so ALL stop arrays (in-memory AND file-based) use the same message format:
//   live.text → prepend stopID → shared prepend "stop" mID lID dID → send "organ_stops"
// Output message: "stop <mID> <lID> <dID> <stopID> <state>"   (handled by Universal.js anything())
// Used for: small arrays (layer DIV buttons, division panel) where file approach is overkill.
function createStopArrayRouted(p, startX, startY, stopData, manualID, layerID, divisionID) {
    if (!p || !stopData || stopData.length === 0) return {};

    var buttonMap = {};
    var currentColumn = 0;
    var currentRow = 0;
    var mID = (manualID   !== null && manualID   !== undefined) ? manualID   : -1;
    var lID = (layerID    !== null && layerID    !== undefined) ? layerID    : -1;
    var dID = (divisionID !== null && divisionID !== undefined) ? divisionID : -1;

    // Shared context objects — created ONCE for the whole array
    var sendObj  = p.newdefault(-500, -20, "send", "organ_stops");
    var ctxPrep  = p.newdefault(-500, -40, "prepend", "stop", mID, lID, dID);
    try { p.connect(ctxPrep, 0, sendObj, 0); } catch(e) {}

    stopData.forEach(function(stop, index) {
        var marginX = typeof common.GEOMETRY.columns.margin === 'function' ?
            common.GEOMETRY.columns.margin() : common.GEOMETRY.columns.margin;

        var pos = common.GEOMETRY.grid.pos(currentRow, currentColumn, marginX, marginX);
        var x = startX + pos.x;
        var y = startY + pos.y;

        var stopLabel2 = stop.stopID + " " + stop.name;
        var stopObj = common.createLiveText(p, x, y,
            common.GEOMETRY.stops.w, common.GEOMETRY.stops.h,
            "stop" + stop.stopID, stopLabel2, stopLabel2, stopLabel2, 10);

        if (stopObj && stopObj.liveText) {
            applyStopColor(stopObj.liveText, stopColorClass(stop.name));
            buttonMap[stop.stopID] = stopObj.liveText;
            var stopPrep = p.newdefault(-500, -60 - (index * 20), "prepend", stop.stopID);
            try {
                p.connect(stopObj.liveText, 0, stopPrep, 0);
                p.connect(stopPrep, 0, ctxPrep, 0);
            } catch(e) {}
        }

        currentRow++;
        if (currentRow >= common.MAX_STOPS_PER_COLUMN) { currentColumn++; currentRow = 0; }
    });

    return buttonMap;
}

// ================================================================================================
// FILE-BASED LAYER PATCHER — PATH RESOLUTION
// ================================================================================================
// .maxpat files are pre-generated by tools/generate_layer_stops.py (not at runtime).
// SINUA.js just resolves the expected POSIX path for bpatcher @name.
//
// To regenerate after changing organ configs:
//   python3 tools/generate_layer_stops.py

// HFS paths (e.g. "Macintosh HD:/Users/...") → POSIX ("/Users/...").
// Needed because scriptDir / patcher.filepath use HFS format on macOS.
function hfsToPosix(hfsPath) {
    if (!hfsPath || typeof hfsPath !== 'string') return hfsPath;
    if (hfsPath.charAt(0) === '/') return hfsPath;          // already POSIX
    var stripped = hfsPath.replace(/^[^:]+:/, '');           // strip "Volume:"
    return (stripped.charAt(0) === '/') ? stripped : hfsPath;
}

// Returns the project root directory as a POSIX path, or null.
// Uses scriptDir (set by Universal.js at startup) as the primary source.
function resolveProjectDir() {
    if (typeof scriptDir !== 'undefined' && scriptDir) {
        // scriptDir = ".../organ-control-system-claudecode/js/"  (HFS or POSIX)
        var posix  = hfsToPosix(scriptDir);
        var parent = posix.replace(/\/js\/?$/, "/");  // strip trailing /js/
        return (parent && parent !== posix) ? parent : posix;
    }
    // Fallback: traverse parent patcher chain
    var p = context.patcher;
    for (var i = 0; i < 6 && p; i++) {
        if (p.filepath) return hfsToPosix(p.filepath.replace(/\/[^\/]*$/, "/"));
        p = p.parentpatcher;
    }
    return null;
}

// Resolve the POSIX path for the organ's pre-generated layer stop .maxpat.
// Mirrors the Python generator's naming: layer_stops_<safeOrganName>.maxpat
function resolveLayerStopFilename(organName) {
    var dir = resolveProjectDir();
    if (!dir) {
        post("resolveLayerStopFilename: cannot resolve project directory\n");
        return null;
    }
    var safeOrganName = (organName || "organ").replace(/[^a-zA-Z0-9_-]/g, "_");
    var path = dir + "layer_stops_" + safeOrganName + ".maxpat";
    post("resolveLayerStopFilename: " + path + "\n");
    return path;
}

// Build the native (HFS or POSIX) absolute path for a file in the project root.
// Uses _maxPatcher.filepath (global from Universal.js, same object as context.patcher) —
// the same path Max used to open the owning patcher — so the volume name is already
// correct and @name resolution works even for bpatchers created dynamically from a
// button click (where the filename-only search context is lost).
// NOTE: Must use _maxPatcher here because this is a top-level function (outside the
// createSINUAModuleWithDI factory) and `context` is not in scope at top level.
//
// Example: patcher.filepath = "Macintosh HD - Data:/Users/.../organ-control-system-claudecode/OrganPatch_2026.amxd"
//          → dir            = "Macintosh HD - Data:/Users/.../organ-control-system-claudecode/"
//          → returns          "Macintosh HD - Data:/Users/.../organ-control-system-claudecode/layer_stops_Reinoldi.maxpat"
function resolveStopFileNativePath(filename) {
    // Walk the patcher chain to find the outermost patcher with a filepath.
    // NOTE: this is a TOP-LEVEL function (outside the factory), so `context` is NOT in scope.
    // Use `_maxPatcher` which is declared as a global in Universal.js: var _maxPatcher = this.patcher;
    // _maxPatcher is the same object as context.patcher but accessible from any scope.
    var p = (typeof _maxPatcher !== 'undefined') ? _maxPatcher : null;
    for (var i = 0; i < 8 && p; i++) {
        var fp = p.filepath;
        if (fp) {
            // Strip the filename (last path component after the last / or \)
            var lastSlash     = fp.lastIndexOf("/");
            var lastBackslash = fp.lastIndexOf("\\");
            var sep = (lastSlash > lastBackslash) ? lastSlash : lastBackslash;
            if (sep >= 0) {
                var nativePath = fp.substring(0, sep + 1) + filename;
                post("resolveStopFileNativePath: " + nativePath + "\n");
                return nativePath;
            }
        }
        p = p.parentpatcher;
    }
    // Fallback: filename only (works during initial patcher construction)
    post("resolveStopFileNativePath: no patcher filepath found, using filename only: " + filename + "\n");
    return filename;
}

// *** GLOBAL STOP ROUTING SETUP ***
// Called once per organ load (in generateGUI) BEFORE manuals are created.
// Creates receive "organ_stops" in context.patcher and wires it to jsbox inlet 1.
function setupStopRouting() {
    if (!context.patcher) {
        common.log(common.LOG_LEVEL.WARN, "setupStopRouting: no patcher in context");
        return;
    }
    if (!context.jsbox) {
        common.log(common.LOG_LEVEL.WARN, "setupStopRouting: no jsbox in context — routing disabled");
        return;
    }

    // Remove any receive from a previous organ load
    if (stopRouteReceive) {
        try { context.patcher.remove(stopRouteReceive); } catch(e) {}
        stopRouteReceive = null;
    }

    try {
        stopRouteReceive = context.patcher.newdefault(-200, -200, "receive", "organ_stops");
        if (stopRouteReceive) {
            context.patcher.connect(stopRouteReceive, 0, context.jsbox, context.stopRouteInlet || 1);
            common.log(common.LOG_LEVEL.INFO,
                "Stop routing: receive organ_stops → jsbox inlet " + (context.stopRouteInlet || 1));
        }
    } catch(e) {
        common.log(common.LOG_LEVEL.ERROR, "setupStopRouting failed: " + e.message);
    }
}

// *** STOP EVENT HANDLER (called from Universal.js anything() on inlet 1) ***
function handleStopEvent(stopID, manualID, layerID, divisionID, state) {
    var stopCtx = createStopContext(stopID, divisionID, manualID, layerID);
    executeStopAction(stopID, Boolean(state), stopCtx);
}

    // ================================================================================================
    // CREATE LAYER FUNKTIONS 
    // ================================================================================================

function executeCreateLayer(manual) {
    if (!manual || !manual.manualData) {
        common.log(common.LOG_LEVEL.ERROR, "Invalid manual object for createLayer");
        return false;
    }

    common.log(common.LOG_LEVEL.INFO, "Creating new layer for: " + manual.manualData.name);

    if (manual.layers.length >= 8) {
        common.log(common.LOG_LEVEL.WARN, "Maximum layers reached");
        return false;
    }

    // Notify organ hardware that a new layer is being created.
    // Path: /P/createLayer (Pedal) or /M<id>/createLayer (manuals 1+)
    var mid = manual.manualData.manualID;
    var mPath = (mid === 0) ? "/P" : "/M" + mid;
    dataLayer.sendOSCDirect(mPath + "/createLayer", []);

    return addLayerToManual(manual);
}

function addLayerToManual(manual) {
    var newLayerID = manual.layers.length + 1;

    // Use the stop lists cached during loadOrgan — avoids DataLayer state format issues.
    // (getMovableStopsFromState reads stop.movable from state, but parsed stop objects
    //  don't carry a movable property; the classification lives in the two separate arrays.)
    var stopData = organState.cachedStops || { movable: [], divisions: [] };
    
    var newLayer = createLayerBpatcher(
        manual.bpatcher.subpatcher(), 
        newLayerID,
        stopData,  // Fixed: Proper stopData object
        manual.manualData.manualID
        );
    
    if (newLayer) {
        manual.layers.push(newLayer);
        resizeManualForLayers(manual);
        return true;
    }
    return false;
}

function resizeManualForLayers(manual) {
    if (!manual || !manual.bpatcher) {
        common.log(common.LOG_LEVEL.ERROR, "Invalid manual for resize");
        return false;
    }
    
    try {
        var newHeight = common.GEOMETRY.sinua.layers.height() * manual.layers.length;

            // *** CORRECT: Use setboxattr for bpatcher sizing ***
        var currentRect = manual.bpatcher.getboxattr("patching_rect");
        if (currentRect && currentRect.length >= 4) {
            manual.bpatcher.setboxattr("patching_rect", 
                currentRect[0], currentRect[1], currentRect[2], newHeight
                );
            manual.bpatcher.setboxattr("presentation_rect", 
                currentRect[0], currentRect[1], currentRect[2], newHeight
                );
        } else {
                // Fallback: Set both rects with default position
            manual.bpatcher.setboxattr("patching_rect", [0, 360, 400, newHeight]);
            manual.bpatcher.setboxattr("presentation_rect", [0, 360, 400, newHeight]);
        }

        common.log(common.LOG_LEVEL.INFO, "Manual resized to height: " + newHeight);
        return true;
        
    } catch (error) {
        common.log(common.LOG_LEVEL.ERROR, "Resize failed: " + error.message);
        return false;
    }
}

function getMovableStopsFromState() {
    var organState = dataLayer.getOrganState();
    if (!organState || !organState.stops) return [];
    
    var movableStops = [];
    Object.keys(organState.stops).forEach(function(stopID) {
        var stop = organState.stops[stopID];
        if (stop.movable) {
            movableStops.push({
                stopID: parseInt(stopID),
                name: stop.name || "Stop " + stopID,
                divisionID: stop.divisionID
            });
        }
    });
    
    return movableStops;
}

function getDivisionStopsFromState() {
    var organState = dataLayer.getOrganState();
    if (!organState || !organState.divisions) return [];
    
    return Object.keys(organState.divisions).map(function(divID) {
        return {
            stopID: "div_" + divID,
            name: "D" + divID,
            divisionID: parseInt(divID)
        };
    });
}


//

    // ================================================================================================
    // CONTEXT-AWARE EXECUTION FUNCTIONS
    // ================================================================================================

// ================================================================================================
// CANCEL / PANIC HELPERS
// ================================================================================================

// Set all live.text buttons in a map to 0 (visual only, no DataLayer call)
function clearButtonMap(buttonMap, label) {
    // Clears JS-created live.text buttons (DIV buttons in layer, division panel stops).
    // For bpatcher-loaded stops, use clearLayer() which sends message(0) to the bpatcher inlet.
    if (!buttonMap) { post("  clearButtonMap[" + (label||"?") + "]: null map\n"); return; }
    var keys = Object.keys(buttonMap);
    post("  clearButtonMap[" + (label||"?") + "]: " + keys.length + " buttons\n");
    var ok = 0, fail = 0;
    keys.forEach(function(stopID) {
        try { buttonMap[stopID].message("set", 0); ok++; }
        catch(e) { fail++; post("    FAIL " + stopID + ": " + e + "\n"); }
    });
    post("    ok=" + ok + " fail=" + fail + "\n");
}

// Clear all stop buttons in a layer via pattr-based reset.
// Clear all stop buttons in a layer bpatcher.
// Uses clearButtonMap directly (synchronous) so the clear happens within the
// _suppressListeners=true window in executeCancel.
// pattrReset.message(0) fires the pattr chain ASYNCHRONOUSLY — by the time the
// live.text buttons receive "set 0" the _suppressListeners flag is already false,
// so the listeners would fire and schedule wrong OSC bundles.
// clearButtonMap calls message("set", 0) synchronously on each live.text reference.
function clearLayer(layer) {
    if (!layer) return;
    clearButtonMap(layer.stopButtonMap, "layer");
}

// Clear all non-movable stop buttons in a division.
// stopButtonMap holds direct newdefault() refs; message("set", 0) clears each live.text silently.
function clearDivision(div) {
    if (!div) return;
    clearButtonMap(div.stopButtonMap, "div");
}

// Turn off all stop buttons in the UI for the given context — no commands sent
function updateUIStopsOff(actionContext) {
    if (!guiObjects) return;

    // Explicit null/undefined checks throughout — !0 is truthy, which would mis-classify
    // PEDAL (manualID=0) and the first division (divisionID=0) as absent.
    var hasManual   = (actionContext.manual     !== null && actionContext.manual     !== undefined);
    var hasLayer    = (actionContext.layer      !== null && actionContext.layer      !== undefined);
    var hasDivision = (actionContext.divisionID !== null && actionContext.divisionID !== undefined);
    var isGlobal      = !hasManual && !hasLayer && !hasDivision && !actionContext.divisionsAll;
    var isDivisionsAll = !hasManual && !hasLayer && !hasDivision && !!actionContext.divisionsAll;
    var isDivision    = hasDivision;
    var isLayer       = hasManual && hasLayer;
    var isManual      = hasManual && !isLayer;

    post("updateUIStopsOff: isGlobal=" + isGlobal + " isDivisionsAll=" + isDivisionsAll +
         " isDivision=" + isDivision + " isLayer=" + isLayer + " isManual=" + isManual + "\n");

    if (isGlobal) {
        // All layers across all manuals + all division stop buttons
        if (guiObjects.manuals && guiObjects.manuals.manuals) {
            guiObjects.manuals.manuals.forEach(function(manual) {
                manual.layers.forEach(function(layer) { clearLayer(layer); });
            });
        }
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) {
                if (div) clearDivision(div);
            });
        }

    } else if (isDivisionsAll) {
        // Section-level division cancel: clear all division stop buttons (not manual layers)
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) {
                if (div) clearDivision(div);
            });
        }

    } else if (isDivision) {
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) {
                if (div && div.context && div.context.divisionID === actionContext.divisionID) {
                    clearDivision(div);
                }
            });
        }

    } else if (isLayer) {
        if (guiObjects.manuals && guiObjects.manuals.manuals) {
            guiObjects.manuals.manuals.forEach(function(manual) {
                if (manual.manualData.manualID === actionContext.manual) {
                    manual.layers.forEach(function(layer) {
                        if (layer.layerID === actionContext.layer) {
                            clearLayer(layer);
                        }
                    });
                }
            });
        }

    } else if (isManual) {
        // All layers within that manual
        if (guiObjects.manuals && guiObjects.manuals.manuals) {
            guiObjects.manuals.manuals.forEach(function(manual) {
                if (manual.manualData.manualID === actionContext.manual) {
                    manual.layers.forEach(function(layer) { clearLayer(layer); });
                }
            });
        }
    }
}

function executeGUIButton(type, actionContext) {
    switch(type) {
    case "reset": 
        executeReset();
        break;
    case "panic": 
        executePanic(actionContext);
        break;
    case "cancel": 
        executeCancel(actionContext);
        break;
    case "createLayer": 
            // Use the stored manual reference
        if (actionContext.manualRef) {
            executeCreateLayer(actionContext.manualRef);
        } else {
            common.log(common.LOG_LEVEL.ERROR, "No manual reference for createLayer");
        }
        break;
    default: 
        common.log(common.LOG_LEVEL.WARN, "No execute function for type " + type);
    }
}

// ================================================================================================
// PRESET CAPTURE / RECALL
// ================================================================================================

// Read the current state of the entire organ GUI into a plain JSON-serialisable object.
// Keys: layerCount, stops, divRouting, controllers, tremulants.
//
// stops / divRouting are keyed by "<manualID>_<layerID>".
// stops[key]      = [stopID, ...]   — numeric IDs that are currently ON
// divRouting[key] = [divID, ...]    — division IDs that are currently routed to this layer
//
// Returns the preset object, or null on failure.
function capturePreset(name) {
    if (!guiObjects || !guiObjects.manuals) {
        common.log(common.LOG_LEVEL.ERROR, "capturePreset: no GUI loaded");
        return null;
    }

    var preset = {
        name:       name || ("Preset " + new Date().toISOString().slice(0,19).replace("T"," ")),
        layerCount: {},   // {manualID: n}
        stops:      {},   // {"manualID_layerID": [stopID, ...]}
        divRouting: {},   // {"manualID_layerID": [divID, ...]}
        divStops:   {},   // {divisionID: [stopID, ...]}   — stops in the divisions section
        controllers: {},  // {controllerID: floatValue}
        tremulants:  {}   // {tremulantID: {active, speed}}
    };

    // ---- Layer structure + stop/div states ----
    // Both movable stops and div-routing are read from per-layer listener caches:
    //   layer.stopState    {varname → bool}  updated by movable stop MaxobjListener callbacks
    //   layer.stopDivState {divKey  → bool}  updated by div-routing MaxobjListener callbacks
    // These avoid both getattr() (unreliable in nested bpatchers) and the flat DataLayer
    // (which has no per-layer resolution — a stop ON in layer 1 would appear ON in all layers).
    guiObjects.manuals.manuals.forEach(function(manual) {
        var mid = manual.manualData.manualID;
        preset.layerCount[mid] = manual.layers.length;

        manual.layers.forEach(function(layer) {
            var lid  = layer.layerID;
            var key  = mid + "_" + lid;
            var activeStops = [];
            var activeDivs  = [];

            var stopSt = layer.stopState    || {};   // per-layer movable stop cache
            var divSt  = layer.stopDivState || {};   // per-layer div-routing cache

            Object.keys(layer.stopButtonMap).forEach(function(btnKey) {
                if (String(btnKey).indexOf("division") !== -1) {
                    // DIV routing — use per-layer listener cache
                    if (divSt[btnKey]) {
                        var divID = parseInt(String(btnKey).replace("division", ""), 10);
                        if (!isNaN(divID)) activeDivs.push(divID);
                    }
                } else {
                    // Movable stop — use per-layer listener cache
                    if (stopSt[btnKey]) {
                        var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
                        var stopID = parseInt(numStr, 10);
                        if (!isNaN(stopID)) activeStops.push(stopID);
                    }
                }
            });

            preset.stops[key]      = activeStops;
            preset.divRouting[key] = activeDivs;
        });
    });

    // ---- Division stops — read from per-division stopState cache ----
    if (guiObjects.divisions && guiObjects.divisions.divisions) {
        guiObjects.divisions.divisions.forEach(function(div) {
            if (!div || !div.context) return;
            var dID     = div.context.divisionID;
            var stopSt  = div.stopState || {};
            var activeStops = [];
            Object.keys(div.stopButtonMap || {}).forEach(function(btnKey) {
                if (stopSt[btnKey]) {
                    var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
                    var stopID = parseInt(numStr, 10);
                    if (!isNaN(stopID)) activeStops.push(stopID);
                }
            });
            preset.divStops[dID] = activeStops;
        });
    }

    // ---- Controllers + Tremulants — read from DataLayer (flat, global — correct for these) ----
    var state = dataLayer.getOrganState() || {};
    Object.keys(state.controllers || {}).forEach(function(id) {
        preset.controllers[id] = state.controllers[id].value;
    });

    // ---- Tremulants ----
    Object.keys(state.tremulants || {}).forEach(function(id) {
        preset.tremulants[id] = {
            active: state.tremulants[id].active,
            speed:  state.tremulants[id].speed
        };
    });

    common.log(common.LOG_LEVEL.INFO,
        "Preset captured: \"" + preset.name + "\" - " +
        Object.keys(preset.stops).length + " layers, " +
        Object.keys(preset.controllers).length + " controllers, " +
        Object.keys(preset.tremulants).length + " tremulants");

    return preset;
}

// Expose to Max (callable via js message)
exports.capturePreset = function(name) {
    var p = capturePreset(name ? String(name) : undefined);
    if (p) {
        outlet(0, "preset", JSON.stringify(p));
    }
};

// ------------------------------------------------------------------------------------------------
// RECALL
// ------------------------------------------------------------------------------------------------

var RECALL_INTERVAL_MS = 2;  // ms between consecutive OSC bundles

// Ensure a manual has at least `needed` layers, adding synchronously if short.
// Returns true when ready (layers may still be loading their bpatchers).
function ensureLayerCount(manual, needed) {
    while (manual.layers.length < needed) {
        var ok = addLayerToManual(manual);
        if (!ok) break;
    }
    return manual.layers.length >= needed;
}

// Set all stop/div buttons in a layer silently (no OSC callbacks).
// activeStopIDs: array of numeric stopIDs to set ON; everything else → OFF.
// activeDivIDs:  array of numeric divIDs   to set ON; everything else → OFF.
function applyLayerStateToGUI(layer, activeStopIDs, activeDivIDs) {
    var stopSet = {};
    (activeStopIDs || []).forEach(function(id) { stopSet[id] = true; });
    var divSet = {};
    (activeDivIDs  || []).forEach(function(id) { divSet[id]  = true; });

    // Diagnostic: log div state being applied (remove once UI updates are confirmed)
    var divKeys = Object.keys(layer.stopButtonMap).filter(function(k) { return String(k).indexOf("division") !== -1; });
    if (divKeys.length > 0) {
        post("applyLayerStateToGUI: L" + layer.layerID +
             " divBtns=[" + divKeys.join(",") + "]" +
             " activeDivIDs=[" + (activeDivIDs || []).join(",") + "]\n");
    }

    Object.keys(layer.stopButtonMap).forEach(function(btnKey) {
        var btn = layer.stopButtonMap[btnKey];
        if (!btn) return;
        var isDiv   = String(btnKey).indexOf("division") !== -1;
        var numStr  = isDiv
            ? String(btnKey).replace("division", "")
            : String(btnKey).replace(/^stop/, "").split("_")[0];
        var numID   = parseInt(numStr, 10);
        var target  = isNaN(numID) ? 0 : (isDiv ? (divSet[numID] ? 1 : 0) : (stopSet[numID] ? 1 : 0));

        // Keep per-layer caches in sync so the next capturePreset() reads the recalled state.
        // Listener callbacks during recall are suppressed (_suppressListeners=true), so only
        // this synchronous write keeps the caches current.
        if (isDiv) {
            if (layer.stopDivState !== undefined) layer.stopDivState[btnKey] = Boolean(target);
        } else {
            if (layer.stopState    !== undefined) layer.stopState[btnKey]    = Boolean(target);
        }

        btn.message("set", target);
    });
}

// Set all stop buttons in a division section silently (no OSC callbacks).
// Mirrors applyLayerStateToGUI but for guiObjects.divisions.divisions[i].
function applyDivisionStateToGUI(div, activeStopIDs) {
    var stopSet = {};
    (activeStopIDs || []).forEach(function(id) { stopSet[id] = true; });

    post("applyDivisionStateToGUI: D" + (div.context ? div.context.divisionID : "?") +
         " activeStopIDs=[" + (activeStopIDs || []).join(",") + "]\n");

    Object.keys(div.stopButtonMap || {}).forEach(function(btnKey) {
        var btn = div.stopButtonMap[btnKey];
        if (!btn) return;
        var numStr = String(btnKey).replace(/^stop/, "").split("_")[0];
        var numID  = parseInt(numStr, 10);
        var target = isNaN(numID) ? 0 : (stopSet[numID] ? 1 : 0);
        // Keep cache in sync so next capturePreset() reads the recalled state
        if (div.stopState !== undefined) div.stopState[btnKey] = Boolean(target);
        btn.message("set", target);
    });
}

// Build the ordered list of OSC messages for one preset.
// Each entry: {path, args}
// args may contain oscFloat() wrappers (handled by sendOSCDirect).
function buildRecallQueue(preset) {
    var queue = [];

    if (!guiObjects || !guiObjects.manuals) return queue;

    // 1. Stops per layer: /P/L1/S 0 id id … or /M1/L1/S 0 id id …
    //    Leading 0 (int) resets the layer, then active stopIDs follow.
    guiObjects.manuals.manuals.forEach(function(manual) {
        var mid   = manual.manualData.manualID;
        var mPath = (mid === 0) ? "/P" : "/M" + mid;
        manual.layers.forEach(function(layer) {
            var key         = mid + "_" + layer.layerID;
            var activeStops = (preset.stops && preset.stops[key]) || [];
            var args = [0].concat(activeStops);          // leading int 0
            queue.push({ path: mPath + "/L" + layer.layerID + "/S", args: args });
        });
    });

    // 2. DIV routing per layer: /M1/L1/D 0 divID …  (same leading-0 convention)
    //    Always send even when activeDivs is empty so "/D 0" clears existing routing
    //    (mirrors the leading-0 behaviour of /S which always resets stops first).
    guiObjects.manuals.manuals.forEach(function(manual) {
        var mid   = manual.manualData.manualID;
        var mPath = (mid === 0) ? "/P" : "/M" + mid;
        manual.layers.forEach(function(layer) {
            var key        = mid + "_" + layer.layerID;
            var activeDivs = (preset.divRouting && preset.divRouting[key]) || [];
            queue.push({ path: mPath + "/L" + layer.layerID + "/D", args: [0].concat(activeDivs) });
        });
    });

    // 2b. Division stops: /D2/S 0 id id … (leading 0 resets division, then sets active IDs)
    //     Iterate all divisions known to guiObjects so divisions with no stored stops still
    //     receive "/D2/S 0" (clears any stops left from a previous preset).
    if (guiObjects.divisions && guiObjects.divisions.divisions) {
        guiObjects.divisions.divisions.forEach(function(div) {
            if (!div || !div.context) return;
            var dID        = div.context.divisionID;
            var activeStops = (preset.divStops && preset.divStops[dID]) || [];
            queue.push({ path: "/D" + dID + "/S", args: [0].concat(activeStops) });
        });
    }

    // 3. Controllers: /SP<id> float
    if (preset.controllers) {
        Object.keys(preset.controllers).forEach(function(id) {
            queue.push({ path: "/SP" + id, args: [preset.controllers[id]] });
        });
    }

    // 4. Tremulants: /T ±id  then /Tspeed id float (only when active)
    if (preset.tremulants) {
        Object.keys(preset.tremulants).forEach(function(id) {
            var trem     = preset.tremulants[id];
            var numID    = Number(id);
            var signedID = trem.active ? numID : -numID;
            queue.push({ path: "/T",      args: [signedID] });
            if (trem.active && trem.speed !== undefined) {
                queue.push({ path: "/Tspeed", args: [numID, trem.speed] });
            }
        });
    }

    return queue;
}

function recallPreset(presetJson) {
    var preset = (typeof presetJson === 'string') ? JSON.parse(presetJson) : presetJson;
    if (!preset) {
        common.log(common.LOG_LEVEL.ERROR, "recallPreset: no preset data");
        return;
    }

    common.log(common.LOG_LEVEL.INFO, "Recalling preset: " + preset.name);

    // ---- 1. Ensure correct layer count per manual ----
    if (preset.layerCount && guiObjects && guiObjects.manuals) {
        _suppressListeners = true;
        dataLayer.suppressOSC(true);

        guiObjects.manuals.manuals.forEach(function(manual) {
            var mid    = manual.manualData.manualID;
            var needed = preset.layerCount[mid] || 1;
            ensureLayerCount(manual, needed);
        });
    }

    // ---- 2. Update GUI silently to match preset ----
    if (guiObjects && guiObjects.manuals) {
        guiObjects.manuals.manuals.forEach(function(manual) {
            var mid = manual.manualData.manualID;
            manual.layers.forEach(function(layer) {
                var key       = mid + "_" + layer.layerID;
                var stops     = (preset.stops     && preset.stops[key])     || [];
                var divs      = (preset.divRouting && preset.divRouting[key]) || [];
                applyLayerStateToGUI(layer, stops, divs);
            });
        });

        // Update controller dials
        if (preset.controllers && guiObjects.controllers) {
            // dial varnames are "control1", "control2" etc.
            var ctrlBp = guiObjects.controllers.bpatcher;
            if (ctrlBp) {
                Object.keys(preset.controllers).forEach(function(id) {
                    var dial = ctrlBp.subpatcher().getnamed("control" + id);
                    if (dial) dial.message("set", preset.controllers[id]);
                });
            }
        }

        // Update division stop buttons
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) {
                if (!div || !div.context) return;
                var dID   = div.context.divisionID;
                var stops = (preset.divStops && preset.divStops[dID]) || [];
                applyDivisionStateToGUI(div, stops);
            });
        }

        // Update tremulant buttons + speed dials
        if (preset.tremulants && guiObjects.tremulants) {
            // tremulant bpatcher contains sub-bpatchers "tremulant1", "tremulant2" etc.
            var tremBp = guiObjects.tremulants.bpatcher;
            if (tremBp) {
                Object.keys(preset.tremulants).forEach(function(id) {
                    var trem   = preset.tremulants[id];
                    var subBp  = tremBp.subpatcher().getnamed("tremulant" + id);
                    if (subBp) {
                        var sp    = subBp.subpatcher ? subBp.subpatcher() : null;
                        if (sp) {
                            var onBtn  = sp.getnamed("on");
                            var spdDial = sp.getnamed("speed");
                            if (onBtn)   onBtn.message("set",   trem.active ? 1 : 0);
                            if (spdDial) spdDial.message("set", trem.speed !== undefined ? trem.speed : 0.5);
                        }
                    }
                });
            }
        }
    }

    // Release GUI suppression after async callbacks settle.
    // applyLayerStateToGUI calls btn.message("set", ...) which fires MaxobjListener
    // callbacks ASYNCHRONOUSLY — same issue as executeCancel.  If we reset the flags
    // synchronously here they are already false when the callbacks arrive, causing
    // spurious stop/div OSC events.  10ms Task keeps both flags true until all
    // async callbacks have fired.
    var recallSuppressReset = new Task(function() {
        _suppressListeners = false;
        dataLayer.suppressOSC(false);
    });
    recallSuppressReset.schedule(10);

    // ---- 3. Build and send timed OSC queue (2ms between bundles) ----
    var queue = buildRecallQueue(preset);
    var idx   = 0;

    common.log(common.LOG_LEVEL.INFO,
        "Recall queue: " + queue.length + " bundles × " + RECALL_INTERVAL_MS + "ms");

    var recallTask = new Task(function() {
        if (idx >= queue.length) return;
        var msg = queue[idx++];
        dataLayer.sendOSCDirect(msg.path, msg.args);
        if (idx < queue.length) recallTask.schedule(RECALL_INTERVAL_MS);
    });
    recallTask.schedule(0);
}

exports.recallPreset = function(presetJson) {
    recallPreset(presetJson ? String(presetJson) : null);
};

function executeReset(){
    common.log(common.LOG_LEVEL.INFO, "RESET executed");

    // 1. Suppress listener + OSC callbacks during visual clear (same pattern as cancel)
    _suppressListeners = true;
    dataLayer.suppressOSC(true);

    // 2. Clear all stop buttons visually (pattrReset per layer)
    if (guiObjects.manuals && guiObjects.manuals.manuals) {
        guiObjects.manuals.manuals.forEach(function(manual) {
            if (manual.layers) {
                manual.layers.forEach(function(layer) {
                    if (layer.pattrReset) {
                        layer.pattrReset.message(0);
                    }
                });
            }
        });
    }

    // 3. Send /panic (clears organ hardware) + reset DataLayer state
    dataLayer.executeCommand('reset');

    // 4. Restore manuals to default layer count (remove extras, add missing)
    var DEFAULT_LAYERS = common.GEOMETRY.sinua.manuals.defaultLayersPerManual;
    if (guiObjects.manuals && guiObjects.manuals.manuals) {
        guiObjects.manuals.manuals.forEach(function(manual) {
            if (!manual.layers) return;
            // Remove layers beyond default
            while (manual.layers.length > DEFAULT_LAYERS) {
                var removed = manual.layers.pop();
                if (removed && removed.bpatcher) {
                    try { manual.bpatcher.subpatcher().remove(removed.bpatcher); } catch(e) {}
                }
            }
            // Add missing layers
            while (manual.layers.length < DEFAULT_LAYERS) {
                addLayerToManual(manual);
            }
            resizeManualForLayers(manual);
        });
    }

    // 5. Release suppression after async callbacks settle (same 10ms window as cancel)
    var resetTask = new Task(function() {
        _suppressListeners = false;
        dataLayer.suppressOSC(false);
    });
    resetTask.schedule(10);
};

function executePanic(actionContext) {
    common.log(common.LOG_LEVEL.INFO, "PANIC executed for " + formatContextInfo(actionContext));

    dataLayer.executeCommand('panic', null, null, actionContext);
}

function executeCancel(actionContext) {
    common.log(common.LOG_LEVEL.INFO, "CANCEL executed for " + formatContextInfo(actionContext));

    // WHY TWO FLAGS + TASK:
    // message("set", 0) on live.text fires MaxobjListener callbacks ASYNCHRONOUSLY.
    // They arrive after executeCancel() returns — after a synchronous flag reset would
    // already be false.  We must keep both flags true until all async callbacks have fired.
    //
    // _suppressListeners  → executeStopAction / executeDivisionAction return early (no DataLayer call)
    // dataLayer.suppressOSC(true) → scheduleOSC() is a no-op (defence-in-depth)
    //
    // cancelOSCBundle (called inside 'cancel' command below) uses sendOSCDirect, which
    // bypasses _oscSuppressed — so the /S 0 + /D 0 cancels ARE sent immediately.

    _suppressListeners = true;
    dataLayer.suppressOSC(true);

    updateUIStopsOff(actionContext);

    // Send cancel OSC.
    // Organ-level context has no manual/layer/divisionID — getSinuaPath() returns ""
    // and cancelOSCBundle("/S") would emit invalid "/S 0".
    // Instead, iterate guiObjects so we send /Mx/S 0 per manual + /Dx/S 0 per division.
    var hasManual    = (actionContext.manual    !== null && actionContext.manual    !== undefined);
    var hasLayer     = (actionContext.layer     !== null && actionContext.layer     !== undefined);
    var hasDivision  = (actionContext.divisionID !== null && actionContext.divisionID !== undefined);
    var isGlobal     = !hasManual && !hasLayer && !hasDivision && !actionContext.divisionsAll;

    if (isGlobal) {
        // Per manual: /Mx/S 0  (catches all movable stops in that manual across all layers)
        if (guiObjects.manuals && guiObjects.manuals.manuals) {
            guiObjects.manuals.manuals.forEach(function(manual) {
                var mCtx = createActionContext(manual.manualData.manualID, null, null);
                dataLayer.executeCommand('cancel', null, null, mCtx);
            });
        }
        // Per division section: /Dx/S 0 for each known division
        if (guiObjects.divisions) {
            var divCtx = createActionContext(null, null, null);
            divCtx.divisionsAll = true;
            dataLayer.executeCommand('cancel', null, null, divCtx);
        }
    } else {
        // Layer, manual, division, or divisionsAll context — DataLayer handles directly
        dataLayer.executeCommand('cancel', null, null, actionContext);
    }

    // Reset both flags after async callbacks have fired.
    // Async callbacks arrive within ~2ms; 10ms gives a comfortable margin.
    var cancelResetTask = new Task(function() {
        _suppressListeners = false;
        dataLayer.suppressOSC(false);
    });
    cancelResetTask.schedule(10);
}

function executeControl(actionContext, controlID, value){
    common.log(common.LOG_LEVEL.INFO, "CONTROL -> "+ value)
        // TODO: dataLayer.executeCommand('control', controlID, value);
};

function executeTremulant(actionContext, tremulantName, value){
    common.log(common.LOG_LEVEL.INFO, "TREMULANT -> "+ value)
        // TODO: dataLayer.executeCommand('control', controlID, value);
}

function executeStopAction(stopID, state, stopContext) {
    if (_suppressListeners) return;  // visual-only clear — no OSC
    common.log(common.LOG_LEVEL.VERBOSE,
        "Stop " + stopID + " -> " + state + " [" + formatContextInfo(stopContext) + "]");
    dataLayer.executeCommand('stop', stopID, state, stopContext);
}

function executeDivisionAction(divisionID, state, divContext) {
    if (_suppressListeners) return;  // visual-only clear — no OSC
    // Layer-div (DIV button inside a layer bpatcher) → /Mx/Lx/D ±divisionID
    common.log(common.LOG_LEVEL.VERBOSE,
        "LayerDiv " + divisionID + " -> " + state + " [" + formatContextInfo(divContext) + "]");
    dataLayer.executeCommand('layerdiv', divisionID, state, divContext);
}


function clearStopsInContext(actionContext) {
    var currentState = dataLayer.getOrganState();

    Object.keys(currentState.stops).forEach(function(stopID) {
        var stop = currentState.stops[stopID];
        var shouldClear = false;

            // Determine if stop should be cleared based on context
        if (!actionContext.manual && !actionContext.layer && !actionContext.divisionID) {
                // Organ-wide action
            shouldClear = stop.state;
        } else if (actionContext.divisionID && stop.divisionID === actionContext.divisionID) {
                // Division-specific action
            shouldClear = stop.state;
        } else if (actionContext.manual && actionContext.layer) {
                // Layer-specific action (only movable stops in this context)
            shouldClear = stop.state && stop.movable;
        } else if (actionContext.manual && !actionContext.layer) {
                // Manual-wide action (all movable stops for this manual)
            shouldClear = stop.state && stop.movable;
        }

        if (shouldClear) {
            dataLayer.setStopState(stopID, false);
        }
    });
}

function formatContextInfo(context) {
    if (context.divisionsAll) {
        return "DIVISIONS";
    } else if (!context.manual && !context.layer && !context.divisionID) {
        return "ORGAN";
    } else if (context.divisionID) {
        return "DIVISION " + context.divisionID;
    } else if (context.manual && context.layer) {
        return "MANUAL " + context.manual + " LAYER " + context.layer;
    } else if (context.manual) {
        return "MANUAL " + context.manual;
    }
    return "UNKNOWN CONTEXT";
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

        // Context utilities for external use
    createStopContext: createStopContext,
    createActionContext: createActionContext,
    executeStopAction: executeStopAction,
    executePanic: executePanic,
    executeCancel: executeCancel,
    handleStopEvent: handleStopEvent,   // called from Universal.js inlet 1 / anything()
        //executeReset: executeReset

        // Preset system — called from gamut_storage_organ.js
    capturePreset: capturePreset,    // (name?) → preset object  (or null)
    recallPreset:  recallPreset,     // (presetJsonOrObj) → starts timed OSC queue

    // Returns the live.menu Max object created by createMainHeader, so Universal.js can
    // pass it directly to organStorage.init() (avoids unreliable getnamed search).
    getPresetMenu: function() {
        return guiObjects && guiObjects.header ? guiObjects.header.presetMenu : null;
    }
};
}

// ================================================================================================
// MODULE REGISTRATION
// ================================================================================================

if (typeof global !== 'undefined') {
    global.createSINUAModuleWithDI = createSINUAModuleWithDI;
}

post("organTool_SINUA_ContextAware.js v01.22 - division stops captured/recalled via /Dx/S\n");