// organTool_SINUA_ContextAware.js - CONTEXT-AWARE SINUA MODULE
// 01.09 - File-based layer patchers: generate .maxpat once, load from disk per layer (skip newdefault)
// 25.05.2026

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
        return tremulantData.map(function(tremulant) {
            return {
                divisionName: tremulant.DivisionName,
                divisionID: tremulant.DivisionID || null
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
                short_label: "DIV"+division.divisionID
            });
        }); 
        return divisionStops;
    }
    
    function parseManuals(manualData) {
        if (!manualData) {
            return [
                {"manualID": 0, "name": "PEDAL", "keys": 30, "midiChannel": 1},
                {"manualID": 1, "name": "MANUAL I", "keys": 68, "midiChannel": 2},
                {"manualID": 2, "name": "MANUAL II", "keys": 68, "midiChannel": 3}
            ];
        }
        
        return manualData.map(function(manual, index) {
            return {
                manualID: manual.manualID || index,
                name: manual.name || manual.Name || ("MANUAL " + (index + 1)),
                keys: manual.keys || manual.Keys || 61,
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
            common.clearGUIObjects(context.patcher, ["organ_name_display"]);
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
        
        return { label: label, reset: reset, panic: panic, cancel: cancel };
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
        // Presentation mode: hides routing cables (prepend/send from createStopArrayRouted)
        try { bpatcher.subpatcher().openinpresentation = 1; } catch(e) {}

        var labelPos = common.GEOMETRY.sinua.divisions.subpatcherLabel;
        var label = common.createLiveComment(bpatcher.subpatcher(), labelPos.x, labelPos.y, labelPos.w, labelPos.h,
            "division_label_" + divisionData.divisionID, 
            "D" + divisionData.divisionID + " " + divisionData.name);
        
        var context = createActionContext(null, null, divisionData.divisionID);

        // TODO add small cancel here 
        var cancel = createGUIButton(bpatcher.subpatcher(), common.GEOMETRY.sinua.divisions.cancel, "cancel", "C", context);
        
        var stopArrayX = typeof common.GEOMETRY.sinua.divisions.stopArray.x === 'function' ? 
        common.GEOMETRY.sinua.divisions.stopArray.x() : 
        common.GEOMETRY.sinua.divisions.stopArray.x;
        
        // MaxobjListener-based: no cables in division subpatcher
        var stopButtonMap = createStopArray(bpatcher.subpatcher(), stopArrayX, common.GEOMETRY.stops.h,
            divisionData.stops, divisionData.divisionID, null, null);

        return { bpatcher: bpatcher, label: label, context: context, stopButtonMap: stopButtonMap };
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
    var sx = common.GEOMETRY.sinua.layers.stopArray.x();
    var G  = common.GEOMETRY;

    if (organState.layerStopFilename) {
        var stopsW = G.grid.multiColumnWidth(stopData.movable.length, G.columns.margin());
        var stopsH = G.stops.h * common.MAX_STOPS_PER_COLUMN;

        // Load the pre-built stop bpatcher from disk — no per-button newdefault inside JS.
        // Use just the filename (no absolute path): Max searches the main patcher's directory,
        // which is the project root where layer_stops_*.maxpat files live.
        // Absolute POSIX paths fail on APFS because Max converts them to HFS using the
        // wrong volume ("Macintosh HD:" instead of "Macintosh HD - Data:").
        var stopFilename = organState.layerStopFilename
            ? organState.layerStopFilename.replace(/.*[\/\\]/, '')  // extract filename only
            : null;
        var stopsBp = stopFilename ? sp.newdefault(sx, 0, "bpatcher",
            "@varname", "stops_" + layerID,
            "@patching_rect", sx, 0, stopsW, stopsH,
            "@presentation_rect", sx, 0, stopsW, stopsH,
            "@presentation", 1,
            "@name", stopFilename,
            "@embed", 0
        ) : null;

        var innerPatcher = stopsBp ? stopsBp.subpatcher() : null;

        // Probe: verify the first stop is actually present (guards against empty-patcher load)
        var probeStop = stopData.movable.length > 0 ? stopData.movable[0] : null;
        var fileLoadedOK = innerPatcher && probeStop &&
                           (innerPatcher.getnamed("stop" + probeStop.stopID) !== null);

        if (fileLoadedOK) {
            // File loaded OK — harvest references + attach direct MaxobjListeners.
            // NO cable routing in the layer's sp (routePrep/routeSend/connect removed):
            // Patcher.openinpresentation is read-only from Max JS, so cables in patching
            // view can't be hidden that way. Listeners on inner-patcher objects work fine
            // (same mechanism as cancel buttons inside bpatchers) and create zero cables.
            stopData.movable.forEach(function(stop) {
                var liveText = innerPatcher.getnamed("stop" + stop.stopID);
                if (liveText) {
                    stopButtonMap[stop.stopID] = liveText;
                    var stopCtx = createStopContext(stop.stopID, stop.divisionID, manualID, layerID);
                    addListener(new MaxobjListener(liveText, function(data) {
                        executeStopAction(stop.stopID, Boolean(data.value), stopCtx);
                    }));
                }
            });
            post("      L" + layerID + ": file OK — " + Object.keys(stopButtonMap).length + "/" +
                stopData.movable.length + " stops mapped\n");
        } else {
            common.log(common.LOG_LEVEL.WARN,
                "L" + layerID + ": file bpatcher failed — falling back to createStopArray");
            var movableMap = createStopArray(sp, sx, 0, stopData.movable, null, manualID, layerID);
            Object.keys(movableMap).forEach(function(id) { stopButtonMap[id] = movableMap[id]; });
        }
    } else {
        // No file available (e.g. +Layer called before organ reload)
        var movableMap = createStopArray(sp, sx, 0, stopData.movable, null, manualID, layerID);
        Object.keys(movableMap).forEach(function(id) { stopButtonMap[id] = movableMap[id]; });
    }
    var tL3 = Date.now();

    // *** DIVISION (DIV) BUTTONS: MaxobjListener-based — no cables in layer subpatcher ***
    var divisionPos = G.sinua.layers.divisionArray(stopData.movable.length);
    var divMap = createStopArray(sp, divisionPos.x, 0, stopData.divisions, null, manualID, layerID);
    Object.keys(divMap).forEach(function(id) { stopButtonMap[id] = divMap[id]; });
    var tL4 = Date.now();

    post("      ⏱ L" + layerID + ": bpatcher=" + (tL1-tL0) + "ms  buttons=" + (tL2-tL1) + "ms  stopsFile=" + (tL3-tL2) + "ms  divs=" + (tL4-tL3) + "ms\n");

    return {
        bpatcher: bpatcher,
        layerID: layerID,
        panic: panic,
        cancel: cancel,
        context: actionCtx,
        stopsBpatcher: stopsBp || null, // bpatcher ref for bulk reset via inlet 0 (message 0)
        stopButtonMap: stopButtonMap    // JS-created buttons (DIV/division buttons) for CANCEL
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
        var dial = common.createLiveDial(bpatcher.subpatcher(), posCtl.x, posCtl.y, posCtl.w, posCtl.h,
            "control" + controllerID, controller.name, " ");

        if (dial) {
            addListener(new MaxobjListener(dial, function(data) {
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

    var label = bpatcher.subpatcher().newdefault(0, 0, "comment");
    label.message("set", tremulantData.divisionName || "tremulant");

    var onPos = common.GEOMETRY.sinua.tremulants.on;
    var onButton = common.createLiveText(bpatcher.subpatcher(), 
        onPos.x, onPos.y, onPos.w, onPos.h, 
        "on", "on", "on", "ON");

    var speedPos = common.GEOMETRY.sinua.tremulants.speed;
    var speedDial = common.createLiveDial(bpatcher.subpatcher(), 
        speedPos.x, speedPos.y, speedPos.w, speedPos.h, 
        "speed", "speed", "speed");

    if (onButton && onButton.liveText) {
        addListener(new MaxobjListener(onButton.liveText, function(data) {
            var tremContext = createActionContext(null, null, tremulantData.divisionID);
            dataLayer.setTremulantState(tremulantID, Boolean(data.value), null, tremContext);
        }));
    }

    if (speedDial) {
        addListener(new MaxobjListener(speedDial, function(data) {
            var tremContext = createActionContext(null, null, tremulantData.divisionID);
            var currentState = dataLayer.getTremulantState(tremulantID);
            dataLayer.setTremulantState(tremulantID, 
                currentState ? currentState.active : false, data.value, tremContext);
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

// *** LEGACY: still used where jsbox routing is unavailable ***
function createStopArray(p, startX, startY, stopData, divisionID, manualID, layerID) {
    if (!p || !stopData) return {};

    var currentColumn = 0;
    var currentRow = 0;
    var buttonMap = {}; // stopID → live.text object, used by CANCEL to clear visually

    stopData.forEach(function(stop, index) {
        var stopContext = createStopContext(stop.stopID, divisionID || stop.divisionID, manualID, layerID);

        var marginX = typeof common.GEOMETRY.columns.margin === 'function' ?
        common.GEOMETRY.columns.margin() : common.GEOMETRY.columns.margin;

        var pos = common.GEOMETRY.grid.pos(currentRow, currentColumn, marginX, marginX);
        var x = startX + pos.x;
        var y = startY + pos.y;

        var stopObj = common.createLiveText(p, x, y,
            common.GEOMETRY.stops.w, common.GEOMETRY.stops.h,
            "stop" + stop.stopID, stop.name, stop.name, stop.name, 10);

        if (stopObj && stopObj.liveText) {
            buttonMap[stop.stopID] = stopObj.liveText; // store for CANCEL visual update
            addListener(new MaxobjListener(stopObj.liveText, function(data) {
                executeStopAction(stop.stopID, Boolean(data.value), stopContext);
            }));
        }

        currentRow++;
        if (currentRow >= common.MAX_STOPS_PER_COLUMN) {
            currentColumn++;
            currentRow = 0;
        }
    });

    return buttonMap; // {stopID → live.text object}
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

        var stopObj = common.createLiveText(p, x, y,
            common.GEOMETRY.stops.w, common.GEOMETRY.stops.h,
            "stop" + stop.stopID, stop.name, stop.name, stop.name, 10);

        if (stopObj && stopObj.liveText) {
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
function clearButtonMap(buttonMap) {
    // Clears JS-created live.text buttons (DIV buttons in layer, division panel stops).
    // For bpatcher-loaded stops, use clearLayer() which sends message(0) to the bpatcher inlet.
    if (!buttonMap) return;
    Object.keys(buttonMap).forEach(function(stopID) {
        try { buttonMap[stopID].message("set", 0); } catch(e) {}
    });
}

// Clear all stop buttons in a layer: bpatcher stops via inlet 0, JS stops via direct message.
// Background: message() to objects nested inside a bpatcher-inside-bpatcher does not propagate
// to the inlet of the nested object (Max JS limitation). Instead we send one message to the
// BPATCHER itself (inlet 0 → internal prepend-set → all live.text buttons silently set to 0).
function clearLayer(layer) {
    if (!layer) return;
    // 1. Bulk-reset all bpatcher-loaded stops via the reset inlet wired in the generated .maxpat
    if (layer.stopsBpatcher) {
        try { layer.stopsBpatcher.message(0); } catch(e) {}
    }
    // 2. Clear JS-created buttons (DIV/division buttons created by createStopArray)
    clearButtonMap(layer.stopButtonMap);
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

    if (isGlobal) {
        // All layers across all manuals + all division stop buttons
        if (guiObjects.manuals && guiObjects.manuals.manuals) {
            guiObjects.manuals.manuals.forEach(function(manual) {
                manual.layers.forEach(function(layer) { clearLayer(layer); });
            });
        }
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) { clearButtonMap(div.stopButtonMap); });
        }

    } else if (isDivisionsAll) {
        // Section-level division cancel: clear all division stop buttons (not manual layers)
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) { clearButtonMap(div.stopButtonMap); });
        }

    } else if (isDivision) {
        if (guiObjects.divisions && guiObjects.divisions.divisions) {
            guiObjects.divisions.divisions.forEach(function(div) {
                if (div.context && div.context.divisionID === actionContext.divisionID) {
                    clearButtonMap(div.stopButtonMap);
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

function executeReset(){
    common.log(common.LOG_LEVEL.INFO, "RESET executed");

    dataLayer.executeCommand('reset');
}; 

function executePanic(actionContext) {
    common.log(common.LOG_LEVEL.INFO, "PANIC executed for " + formatContextInfo(actionContext));

    dataLayer.executeCommand('panic', null, null, actionContext);
}

function executeCancel(actionContext) {
    common.log(common.LOG_LEVEL.INFO, "CANCEL executed for " + formatContextInfo(actionContext));
    // 1. Turn off buttons visually (no individual stop commands sent)
    updateUIStopsOff(actionContext);
    // 2. Update DataLayer state silently + send ONE consolidated command (M1/L1/S 0 etc.)
    dataLayer.executeCommand('cancel', null, null, actionContext);
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
    common.log(common.LOG_LEVEL.VERBOSE, 
        "Stop " + stopID + " -> " + state + " [" + formatContextInfo(stopContext) + "]");

    dataLayer.executeCommand('stop', stopID, state, stopContext);
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
    if (!context.manual && !context.layer && !context.divisionID) {
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
};
}

// ================================================================================================
// MODULE REGISTRATION
// ================================================================================================

if (typeof global !== 'undefined') {
    global.createSINUAModuleWithDI = createSINUAModuleWithDI;
}

post("organTool_SINUA_ContextAware.js v01.09 - file-based layer patchers eliminate newdefault bottleneck\n");