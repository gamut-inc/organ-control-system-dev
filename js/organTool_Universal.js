// organTool_Universal_Optimized.js - BEST PRACTICE ORGAN CONTROL SYSTEM
// 01.11 - Fix division cancel scope: divisionsAll flag replaces divisionID=0 coercion
// 01.12 - Default OSC target: 192.168.0.1:1803 (was 127.0.0.1:8000)
//         console.json / console <OrganName>.json: load alongside organ JSON to get Manuals
// 01.23 - Preset system: require gamut_storage_organ.js; presetStore/Recall/Delete handlers
//         gamut_storage_organ v00.02: fix recall — single module-level Dict prevents GC
// 01.24 - Pass direct presetMenu MaxObj ref to organStorage.init (from SINUA.getPresetMenu())
//         so gamut_storage_organ doesn't rely on getnamed() across patcher boundaries.
// 01.25 - Live project persistence attempt via [dict] alone — dict was empty on reload.
// 01.26 - Persistence fixed in gamut_storage_organ v00.08 (pattrstorage recall + backup file).
//         organStorage.initStorage(patcher, scriptDir) runs during initializeSystem(),
//         before any organ loads, so the bank and the organ path are available.
//         The organ filepath now lives IN the preset bank (setOrganPath/getOrganPath) —
//         one store covers both "which organ" and "which presets".
//         Auto-reload Task moved to 400ms to clear the asynchronous pattrstorage recall.
//         MIDI organ module (organTool_MIDI.js) for traditional consoles without layers.
// 29.05.2026

autowatch = 1;
inlets  = 2;  // inlet 0: control messages; inlet 1: stop events from organ_stops receive
outlets = 2;  // outlet 0: MIDI / OSC → multichanmidiout or udpsend
              // outlet 1: status → "preset <nr> <name>", for number boxes and displays

// ================================================================================================
// MODULE LOADING SYSTEM - FIXED PATH DETECTION
// ================================================================================================

function getScriptDirectory() {
    // Walk the whole chain, not one level: a js object can sit several patchers deep,
    // and only some of them carry a file path.
    var fullPath = null;
    var p = this.patcher;
    while (p && !fullPath) {
        try { fullPath = p.filepath || null; } catch(e) { fullPath = null; }
        p = p.parentpatcher;
    }

    if (!fullPath) {
        post("ERROR: Cannot determine script directory\n");
        return null;
    }

    var sep = (fullPath.indexOf("/") !== -1) ? "/" : "\\";

    // filepath is sometimes the containing FOLDER rather than a file — Live reports
    // it that way for a device it is still setting up.  Chopping at the last
    // separator then removes a real folder, which is how this resolved to
    // "…/_Gamut_Instrumente_Dropbox/js/" and quietly loaded a copy from the search
    // path instead.  Only strip a trailing component that actually looks like a file.
    var last     = fullPath.substring(fullPath.lastIndexOf(sep) + 1);
    var isFile   = /\.(amxd|maxpat|maxhelp)$/i.test(last);
    var baseDir  = isFile ? fullPath.substring(0, fullPath.lastIndexOf(sep)) : fullPath;
    var scriptDir = baseDir + sep + "js" + sep;
    
    // Say which patcher this was derived from.  Two instances printing two different
    // script directories is the only sign that the device is running twice, and
    // without the source path there is no way to tell them apart.
    post("Script directory: " + scriptDir + "\n");
    post("  derived from patcher: " + fullPath + "\n");

    // Does that folder really hold the scripts?  If not, include() still succeeds by
    // falling back to Max's search path — which silently runs whatever copy it finds
    // there, possibly an old one, and hides the fact that this patcher sits in the
    // wrong place.  There are two stale copies of these scripts under the Max search
    // path today, so this is not hypothetical.
    //
    // [File] is the wrong instrument for the test: given a path it cannot resolve it
    // searches by NAME, finds the copy in the search path and reports success.  That
    // is exactly why the warning stayed silent while the folder did not exist.
    // [Folder] resolves the path and nothing else.
    try {
        var probe = new Folder(scriptDir);
        // A folder that is not there iterates as empty.  Treat it as present if either
        // signal says so, so a quirk in one property cannot produce a false warning on
        // every single load.
        var seen    = Number(probe.count);
        var missing = !(seen > 0) && probe.end !== false;
        probe.close();
        if (missing) {
            post("  WARNING: no scripts at that path. Max will load them from its\n");
            post("  search path instead, so the copy that runs may not be this one.\n");
        }
    } catch (e) { /* Folder unavailable — the warning is a convenience, not a gate */ }

    return scriptDir;
}

// The version was a literal inside the startup post() and drifted every time it was
// edited there.  One constant, read by the log line and shown in the header, so what
// the console says and what the device shows can no longer disagree.
var SYSTEM_VERSION      = "01.42";
var SYSTEM_VERSION_NOTE = "note-off on transport stop; cancel leaves the controllers";

var scriptDir = getScriptDirectory();
if (!scriptDir) {
    post("CRITICAL ERROR: Cannot determine script directory!\n");
    post("Current patcher filepath: " + (this.patcher.filepath || "undefined") + "\n");
    post("Parent patcher filepath: " + (this.patcher.parentpatcher ? this.patcher.parentpatcher.filepath : "undefined") + "\n");
} else {
    var modules = ['Geometry', 'Common', 'DataLayer', 'ProtocolLayer'];
    
    modules.forEach(function(module) {
        var modulePath = scriptDir + "organTool_" + module + ".js";
        try {
            post("Loading: " + modulePath + "\n");
            include(modulePath);
            post("✓ Loaded: " + module + "\n");
        } catch (error) {
            post("✗ Failed to load " + module + ": " + error.message + "\n");
            post("  Path: " + modulePath + "\n");
        }
    });
}

// ================================================================================================
// PRESET MANAGER (gamut_storage_organ.js) — loaded via require() so it shares our JS context
// ================================================================================================

var organStorage = null;
if (scriptDir) {
    try {
        organStorage = require(scriptDir + "gamut_storage_organ.js");
        post("✓ Loaded: gamut_storage_organ\n");
    } catch(e) {
        post("✗ gamut_storage_organ.js not loaded: " + e.message + "\n");
    }
}

// ================================================================================================
// MAX PATCHER REFERENCE — shared with included modules (DataLayer, etc.)
// ================================================================================================
// Captured at load time so included modules can call this.patcher.newdefault() etc.
var _maxPatcher = this.patcher;
// The js box itself, so programmatically created objects can be wired back into it
var _maxBox = this.box;

// ================================================================================================
// SYSTEM STATE
// ================================================================================================

var system = {
    modules: {},
    organModule: null,
    currentOrgan: {
        name: "No Organ Loaded",
        type: "UNKNOWN",
        filepath: null,
        loaded: false
    },
    initialized: false
};

// ================================================================================================
// INITIALIZATION
// ================================================================================================

function initializeSystem() {
    try {
        // Check if factory functions are available
        if (typeof createCommonModule !== 'function') {
            throw new Error("createCommonModule not found - check if organTool_Common.js loaded correctly");
        }
        if (typeof createDataLayerModule !== 'function') {
            throw new Error("createDataLayerModule not found - check if organTool_DataLayer.js loaded correctly");
        }
        if (typeof createProtocolLayerModule !== 'function') {
            throw new Error("createProtocolLayerModule not found - check if organTool_ProtocolLayer.js loaded correctly");
        }
        
        // Initialize core modules with dependency injection
        system.modules.common = createCommonModule();
        if (!system.modules.common) {
            throw new Error("Common module initialization failed");
        }
        
        system.modules.dataLayer = createDataLayerModule(system.modules.common);
        if (!system.modules.dataLayer) {
            throw new Error("DataLayer module initialization failed");
        }
        
        system.modules.protocolLayer = createProtocolLayerModule(
            system.modules.common, 
            system.modules.dataLayer
        );
        if (!system.modules.protocolLayer) {
            throw new Error("ProtocolLayer module initialization failed");
        }
        
        // Restore the preset bank + last organ path BEFORE any organ loads, so the
        // auto-reload below has a path to work with.
        if (organStorage) {
            organStorage.initStorage(_maxPatcher, scriptDir, _maxBox);
            // Status outlet: "preset <nr> <name>" whenever the current preset changes
            organStorage.setStatusHandler(function(nr, name) {
                sendStatus("preset", nr, name || "");
            });
        }

        system.initialized = true;
        system.modules.common.log(system.modules.common.LOG_LEVEL.INFO, "System initialized successfully");
        post("✓ All modules initialized successfully\n");
        return true;
        
    } catch (error) {
        post("System initialization failed: " + error.message + "\n");
        
        // Debug information
        post("Available factory functions:\n");
        post("  createCommonModule: " + (typeof createCommonModule !== 'undefined') + "\n");
        post("  createDataLayerModule: " + (typeof createDataLayerModule !== 'undefined') + "\n");  
        post("  createProtocolLayerModule: " + (typeof createProtocolLayerModule !== 'undefined') + "\n");
        post("  createGeometryModule: " + (typeof createGeometryModule !== 'undefined') + "\n");
        
        return false;
    }
}

// ================================================================================================
// ORGAN TYPE DETECTION
// ================================================================================================

function detectOrganType(organData) {
    if (!organData) return "UNKNOWN";
    
    // SINUA format detection
    if (organData.Divisions && organData.Stops && organData.Controllers) {
        return "SINUA";
    }
    
    // MIDI format detection  
    if (organData.manuals && organData.stops) {
        return "MIDI";
    }
    
    return "UNKNOWN";
}

// ================================================================================================
// DYNAMIC MODULE LOADING
// ================================================================================================

function loadOrganModule(organType) {
    try {
        // Explicit factory lookup — no eval(), no global/window (not available in Max js object).
        // Only include() the file when the factory is not yet defined — include() re-parses
        // the entire file every call, which is the main loading-time bottleneck.
        // To force a reload during development: touch/save Universal.js → autowatch clears scope.
        var factory = null;
        if (organType === "SINUA") {
            if (typeof createSINUAModuleWithDI !== 'function') {
                post("Loading (first time): " + scriptDir + "organTool_SINUA.js\n");
                include(scriptDir + "organTool_SINUA.js");
            }
            factory = (typeof createSINUAModuleWithDI === 'function') ? createSINUAModuleWithDI : null;
        } else if (organType === "MIDI") {
            if (typeof createMIDIModuleWithDI !== 'function') {
                post("Loading (first time): " + scriptDir + "organTool_MIDI.js\n");
                include(scriptDir + "organTool_MIDI.js");
            }
            factory = (typeof createMIDIModuleWithDI === 'function') ? createMIDIModuleWithDI : null;
        }

        if (typeof factory !== 'function') {
            throw new Error("Factory function not found for organ type: " + organType +
                          " — check that organTool_" + organType + ".js loaded correctly");
        }
        
        // Context object with command context capability
        var context = createOrganContext(organType);
        
        system.organModule = factory(
            system.modules.common,
            system.modules.dataLayer,
            context
        );
        
        if (!system.organModule) {
            throw new Error("Organ module factory returned null");
        }
        
        system.modules.common.log(system.modules.common.LOG_LEVEL.INFO, 
            "Loaded " + organType + " module with context");
        
        return true;
        
    } catch (error) {
        system.modules.common.log(system.modules.common.LOG_LEVEL.ERROR, 
            "Module loading failed: " + error.message);
        
        // Debug info
        post("Debug: Available functions after include:\n");
        post("  createSINUAModuleWithDI available: " + (typeof createSINUAModuleWithDI !== 'undefined') + "\n");
        post("  createMIDIModuleWithDI available:  " + (typeof createMIDIModuleWithDI !== 'undefined') + "\n");
        
        return false;
    }
}

function createOrganContext(organType) {
    return {
        patcher: this.patcher,
        jsbox: this.box,       // js object's own MaxObj — used to connect receive → inlet 1
        stopRouteInlet: 1,     // inlet index for stop routing
        organType: organType,
        
        // Context-aware command generator
        createContextCommand: function(manualID, layerID, type) {
            var baseContext = {
                // Use explicit null check — || null coerces 0 to null, breaking manualID=0 (PEDAL)
                manual: (manualID !== null && manualID !== undefined) ? manualID : null,
                layer:  (layerID  !== null && layerID  !== undefined) ? layerID  : null,
                type: type || 'stop'
            };
            
            // Generate SINUA command path
            if (organType === "SINUA") {
                var path = "";
                if (manualID !== null && layerID !== null) {
                    path = "/M" + manualID + "/L" + layerID + "/";
                } else if (manualID !== null) {
                    path = "/M" + manualID + "/";
                } else {
                    path = "/";
                }
                
                baseContext.commandPath = path;
                baseContext.sinuaCommand = function(action) {
                    var commandType = (action === 'panic') ? 'V' : 'S';
                    return path + commandType + " 0";
                };
            }
            
            return baseContext;
        }
    };
}

// ================================================================================================
// ORGAN LOADING
// ================================================================================================

function loadOrgan(filepath) {
    if (!system.initialized) {
        post("System not initialized\n");
        return false;
    }

    // Guard: only accept organ JSON files — reject .maxpat and other formats.
    // Prevents pattr/stored-state from accidentally loading bpatcher files as organs.
    if (!filepath || !/\.json$/i.test(filepath)) {
        post("loadOrgan: ignored non-JSON path: " + filepath + "\n");
        return false;
    }

    try {
        var organData = loadOrganJSON(filepath);
        if (!organData) return false;

        // Inject Manuals from console JSON if not already in organ JSON.
        // Try "console <OrganName>.json" first, then "console.json" in same dir.
        // Skip for MIDI organs (lowercase "manuals") — they define manuals inline.
        if (!organData.Manuals && !organData.manuals) {
            var consoleManuals = loadConsoleManuals(filepath);
            if (consoleManuals) {
                organData.Manuals = consoleManuals;
                system.modules.common.log(system.modules.common.LOG_LEVEL.INFO,
                    "Manuals loaded from console JSON: " + consoleManuals.length);
            } else {
                // Default: Pedal + I + II (3 manuals)
                organData.Manuals = [
                    { ManualID: 0, Name: "Pedal" },
                    { ManualID: 1, Name: "I" },
                    { ManualID: 2, Name: "II" }
                ];
                system.modules.common.log(system.modules.common.LOG_LEVEL.INFO,
                    "Manuals: using default P/I/II (no console JSON found)");
            }
        }

        var organType = detectOrganType(organData);
        system.modules.common.log(system.modules.common.LOG_LEVEL.INFO,
            "Detected organ type: " + organType);

        // Update system state
        system.currentOrgan = {
            filepath: filepath,
            type: organType,
            name: system.modules.common.extractOrganNameFromPath(filepath),
            loaded: false
        };

        // Load appropriate module
        if (!loadOrganModule(organType)) return false;

        // Load organ data
        var success = system.organModule.loadOrgan(organData, filepath);
        system.currentOrgan.loaded = success;

        if (success) {
            // Configure protocol
            configureProtocol(organType);

            // Persist filepath in the preset bank so a project reopen can auto-reload
            if (organStorage) organStorage.setOrganPath(toPortablePath(filepath));

            // Wire preset manager to the freshly-loaded organ module.
            // Pass the presetMenu MaxObj reference directly so gamut_storage_organ doesn't
            // need to search for it by scripting name (getnamed is unreliable across patcher levels).
            if (organStorage) {
                var presetMenuRef = (system.organModule && typeof system.organModule.getPresetMenu === "function")
                    ? system.organModule.getPresetMenu()
                    : null;
                organStorage.init(_maxPatcher, system.organModule, presetMenuRef);
            }
        }

        return success;
        
    } catch (error) {
        system.modules.common.log(system.modules.common.LOG_LEVEL.ERROR, 
            "loadOrgan error: " + error.message);
        return false;
    }
}

function loadOrganJSON(filepath) {
    try {
        var tempDict = new Dict("temp_organ_load");
        tempDict.import_json(filepath);
        var data = system.modules.common.dictToJson(tempDict);
        tempDict.freepeer();
        return data;
    } catch (error) {
        system.modules.common.log(system.modules.common.LOG_LEVEL.ERROR,
            "JSON load failed: " + error.message);
        return null;
    }
}

// Try to load Manuals from a companion console JSON in the same directory.
// Priority: "console <OrganName>.json" → "console.json"
// Returns Manuals array or null.
function loadConsoleManuals(organFilepath) {
    // Extract directory and organ name from organ filepath
    // filepath is like ".../mapping/config/organ Reinoldi.json"
    var dir = organFilepath.replace(/[^\/\\]*$/, '');  // everything up to last /
    var organName = system.modules.common.extractOrganNameFromPath(organFilepath);

    var candidates = [
        dir + "console " + organName + ".json",
        dir + "console.json"
    ];

    for (var i = 0; i < candidates.length; i++) {
        try {
            var tempDict = new Dict("temp_console_load");
            tempDict.import_json(candidates[i]);
            var data = system.modules.common.dictToJson(tempDict);
            tempDict.freepeer();
            if (data && data.Manuals && data.Manuals.length > 0) {
                post("loadConsoleManuals: loaded from " + candidates[i] + "\n");
                return data.Manuals;
            }
        } catch (e) {
            // File not found or parse error — try next candidate
        }
    }
    return null;
}

function configureProtocol(organType) {
    if (!system.modules.protocolLayer) return;
    
    try {
        var config = {};
        
        if (organType === "SINUA") {
            config = {
                targetIP: "192.168.0.1",
                targetPort: 1803,
                localPort: 9000
            };
            system.modules.protocolLayer.connect("SINUA", config);
        } else if (organType === "MIDI") {
            config = {
                outputDevice: null,
                baseChannel: 1,
                stopMethod: "note"
            };
            system.modules.protocolLayer.connect("MIDI", config);
        }
        
        system.modules.common.log(system.modules.common.LOG_LEVEL.INFO, 
            "Protocol configured: " + organType);
            
    } catch (error) {
        system.modules.common.log(system.modules.common.LOG_LEVEL.ERROR, 
            "Protocol configuration failed: " + error.message);
    }
}

// ================================================================================================
// OSC TARGET CONFIGURATION
// ================================================================================================
// Call from Max:  [message setOSCTarget 192.168.1.10 8000] → [js organTool_Universal.js]
// Or configure via organ JSON in loadOrgan (if OSCTarget field present).

function setOSCTarget(ip, port) {
    if (!system.modules.dataLayer) {
        post("setOSCTarget: DataLayer not ready\n");
        return;
    }
    system.modules.dataLayer.initOSCTransport(ip, port);
}

// ================================================================================================
// STATE MANAGEMENT API
// ================================================================================================

function setStopState(stopID, state, context) {
    if (!system.modules.dataLayer) return false;
    
    // Add context to command if provided
    if (context) {
        system.modules.dataLayer.queueOrganCommand('stop', stopID, state, 1, {
            context: context,
            command: context.sinuaCommand ? context.sinuaCommand('stop') : null
        });
    }
    
    return system.modules.dataLayer.setStopState(stopID, state);
}

function setTremulantState(tremulantID, active, speed, context) {
    if (!system.modules.dataLayer) return false;
    
    if (context) {
        system.modules.dataLayer.queueOrganCommand('tremulant', tremulantID, 
            { active: active, speed: speed }, 2, {
            context: context,
            command: context.sinuaCommand ? context.sinuaCommand('tremulant') : null
        });
    }
    
    return system.modules.dataLayer.setTremulantState(tremulantID, active, speed);
}

function executeContextCommand(action, context) {
    if (!system.modules.dataLayer || !context) return false;
    
    var priority = (action === 'panic') ? 0 : 1;
    var command = context.sinuaCommand ? context.sinuaCommand(action) : null;
    
    system.modules.dataLayer.queueOrganCommand(action, context.type, 0, priority, {
        context: context,
        command: command
    });
    
    system.modules.common.log(system.modules.common.LOG_LEVEL.INFO, 
        action + " executed for " + (context.commandPath || 'unknown context'));
    
    return true;
}

// ================================================================================================
// CONVENIENCE FUNCTIONS
// ================================================================================================

function clearGUI() {
    if (system.organModule && system.organModule.clearGUI) {
        system.organModule.clearGUI();
    }
}

function reloadOrgan() {
    if (!system.currentOrgan.filepath) return false;
    return loadOrgan(system.currentOrgan.filepath);
}

function setIncludeTransmissions(include) {
    if (!system.modules.dataLayer) return false;
    var result = system.modules.dataLayer.setIncludeTransmissions(include);
    if (result && system.currentOrgan.filepath) {
        reloadOrgan(); // Auto-reload with new transmission setting
    }
    return result;
}

function toggleTransmissions() {
    if (!system.modules.dataLayer) return false;
    var result = system.modules.dataLayer.toggleTransmissions();
    if (result && system.currentOrgan.filepath) {
        reloadOrgan();
    }
    return result;
}

// ================================================================================================
// FILE SELECTION
// ================================================================================================

function selectOrganFile() {
    try {
        var dialog = this.patcher.getnamed("dialog_selectFile");
        if (dialog) {
            dialog.message("bang");
        } else {
            system.modules.common.log(system.modules.common.LOG_LEVEL.ERROR, 
                "File dialog not found: dialog_selectFile");
        }
    } catch (error) {
        system.modules.common.log(system.modules.common.LOG_LEVEL.ERROR, 
            "selectOrganFile error: " + error.message);
    }
}

function call_loadOrganFile(filepath) {
    if (!filepath || filepath === "") {
        system.modules.common.log(system.modules.common.LOG_LEVEL.WARN, "No file selected");
        return false;
    }
    return loadOrgan(filepath);
}

// ================================================================================================
// STATUS & DEBUG
// ================================================================================================

function getCurrentOrganInfo() {
    var info = {
        name: system.currentOrgan.name,
        type: system.currentOrgan.type,
        filepath: system.currentOrgan.filepath,
        loaded: system.currentOrgan.loaded
    };
    
    if (system.organModule && system.organModule.getCurrentOrganInfo) {
        var moduleInfo = system.organModule.getCurrentOrganInfo();
        Object.keys(moduleInfo).forEach(function(key) {
            if (key !== 'type') info[key] = moduleInfo[key];
        });
    }
    
    return info;
}

function displaySystemStatus() {
    var info = getCurrentOrganInfo();
    
    post("=== ORGAN CONTROL SYSTEM STATUS ===\n");
    post("Initialized: " + system.initialized + "\n");
    post("Organ: " + info.name + " (" + info.type + ")\n");
    post("Loaded: " + info.loaded + "\n");
    
    if (system.modules.dataLayer) {
        post("Transmissions: " + 
            (system.modules.dataLayer.getIncludeTransmissions() ? 'INCLUDED' : 'EXCLUDED') + "\n");
    }
    
    if (system.modules.protocolLayer) {
        var protocolStatus = system.modules.protocolLayer.getProtocolStatus();
        post("Protocol: " + protocolStatus.type + " (" + 
            (protocolStatus.connected ? 'Connected' : 'Disconnected') + ")\n");
        post("Commands queued: " + protocolStatus.queueLength + "\n");
    }
    
    post("===================================\n");
}

function getSystemHealth() {
    return {
        system: system.initialized,
        modules: {
            common: !!system.modules.common,
            dataLayer: !!system.modules.dataLayer,
            protocolLayer: !!system.modules.protocolLayer,
            organModule: !!system.organModule
        },
        organ: system.currentOrgan,
        protocol: system.modules.protocolLayer ? 
            system.modules.protocolLayer.getProtocolStatus() : null
    };
}

// ================================================================================================
// EMERGENCY FUNCTIONS
// ================================================================================================

function panic() {
    if (system.modules.protocolLayer) {
        system.modules.protocolLayer.sendPanicCommand();
    }
    if (system.modules.dataLayer) {
        system.modules.dataLayer.clearCommandQueue();
    }
    system.modules.common.log(system.modules.common.LOG_LEVEL.INFO, "PANIC executed");
}

function resetSystem() {
    if (system.modules.dataLayer) {
        system.modules.dataLayer.initializeState();
    }
    if (system.modules.protocolLayer) {
        system.modules.protocolLayer.clearCommandQueue();
    }
    system.modules.common.log(system.modules.common.LOG_LEVEL.INFO, "System reset");
}

// ================================================================================================
// OUTLET 1 — port, renameChain, preset
// ================================================================================================
// Wire it by routing only what has to lose its selector; route's rightmost outlet
// passes everything else through unchanged, so renameChain reaches the rack whole:
//
//   outlet 1 ──> [route port ports preset]
//                  ├ port   -> [prepend port] -> [multichanmidiout]
//                  ├ ports  -> [message ports] -> [multichanmidiout]   (it only builds
//                  │            its port list on request, and matches names against it)
//                  ├ preset -> display / number boxes
//                  └ reject -> the rack bpatcher   ("renameChain 0 PRESET 0")
//
// Call outlet directly, never through Function.prototype.apply: it is a native
// binding Max provides, and going through apply sends nothing at all — that cost a
// long hunt once already.
//
// Everything is ALSO sent to [receive organStatus], which needs no patch cord:
//
//   [receive organStatus] -> [route port renameChain preset]
//
// Worth having, because a cord on outlet 1 is fragile in a way that is easy to
// mistake for a bug in here.  If the object is typed as a bare [v8] with the script
// attached as an attribute, Max builds it with one outlet, restores the cords, and
// only then runs the script that asks for two — so the cord to outlet 1 refers to
// nothing yet and is silently dropped, for good, at the next save.  Typing the box
// as [v8 organTool_Universal.js] fixes that; the named send does not care either way.

var STATUS_RECEIVE = "organStatus";

function sendStatus(sel, a, b, c) {
    // Same call twice rather than a loop: outlet and messnamed are both native
    // bindings, and neither may be reached through apply.
    if      (c !== undefined) { outlet(1, sel, a, b, c); messnamed(STATUS_RECEIVE, sel, a, b, c); }
    else if (b !== undefined) { outlet(1, sel, a, b);    messnamed(STATUS_RECEIVE, sel, a, b); }
    else if (a !== undefined) { outlet(1, sel, a);       messnamed(STATUS_RECEIVE, sel, a); }
    else                      { outlet(1, sel);          messnamed(STATUS_RECEIVE, sel); }
}

// ================================================================================================
// CONSOLE VERBOSITY — [message debug 0] / [message debug 1], or [toggle] → [prepend debug]
// ================================================================================================
// Live use wants a quiet console: "debug 0" leaves only warnings and errors,
// "debug 1" restores the full trace.  Every module logs through common.log, so one
// switch covers all of them.

var _debugOn = true;

function debug(on) {
    _debugOn = Boolean(Number(on));
    if (system.modules.common) {
        // DEBUG shows everything; WARN keeps real problems visible but drops the chatter
        system.modules.common.selectLogLevel(_debugOn ? "DEBUG" : "WARN");
    }
    if (organStorage && typeof organStorage.setQuiet === "function") {
        organStorage.setQuiet(!_debugOn);
    }
    post("Organ debug output " + (_debugOn ? "ON" : "OFF") + "\n");
}

// ================================================================================================
// TRACK MIDI OUTPUT ROUTING → multichanmidiout "port"
// ================================================================================================
// Follows the hosting track's MIDI output routing and hands it to multichanmidiout,
// once at startup and again whenever it changes in Live.  Wire the js outlet to
// multichanmidiout as usual — it understands "port <name>".
//
//   [message watchTrackOutput]   start observing (also runs automatically at init)
//   [message sendTrackPort]      re-send the current routing by hand
//
// Live exposes two properties on the track, and they mean different things:
//   output_routing_type    → the destination itself, e.g. "IAC Driver Bus 1"  ← the port
//   output_routing_channel → the channel within it, e.g. "Ch. 1" / "All Channels"
// multichanmidiout wants the destination, so the TYPE is what gets sent as the port;
// the channel is logged alongside so you can see both.

var _routingAPIs = [];   // module-level: a LiveAPI held only by a local is collected

function routingDisplayName(api, prop) {
    try {
        var raw = api.get(prop);
        var s   = (raw && raw.join) ? raw.join(" ") : String(raw);
        // Routing properties come back as a JSON object carrying display_name
        try {
            var o = JSON.parse(s);
            if (o) {
                // An EMPTY display_name is still an answer — an unrouted track reports
                // {"display_name": "", "identifier": 1}.  Testing truthiness let that
                // fall through and dumped the raw JSON into the log as the channel name.
                if (typeof o.display_name === "string") return String(o.display_name);
                if (o[prop] && typeof o[prop].display_name === "string")
                    return String(o[prop].display_name);
            }
        } catch (parseError) { /* not JSON — the plain string is the name */ }
        return s;
    } catch (e) {
        return null;
    }
}

// force=1 skips the de-duplication below.  As a message from a button this is the
// point: you are asking BECAUSE something is wrong, and the value has not changed.
function sendTrackPort(force) {
    if (!_routingAPIs.length) {
        if (force) post("sendTrackPort: no observers yet — send watchTrackOutput first\n");
        return;
    }
    var api  = _routingAPIs[0];
    var port = routingDisplayName(api, "output_routing_type");
    var chan = routingDisplayName(api, "output_routing_channel");

    // A bare number means the API answered before it was up — not a port name.
    // "No Output" / "None" mean the track is not routed anywhere: Live's own answer,
    // not an error, but there is no port to hand to multichanmidiout — passing it on
    // produced "port 'No Output' not found".
    var NOT_A_PORT = { "None": 1, "No Output": 1, "": 1 };
    _routingValid = !!(port && !/^\d+$/.test(String(port)) && !NOT_A_PORT[String(port)]);

    // Two observers (type and channel) both fire on a change, and the retries add
    // more calls on top.  Report and announce only what actually changed, or the
    // console fills with the same line six times over.
    // De-duplicate on what was last REPORTED, not on what was last announced.  Tying it
    // to _routingValid meant an invalid reading was never remembered, so an unrouted
    // track logged the same line on every observer callback and every retry — fifteen
    // times in a row for one unchanged "No Output".
    var reported = String(port) + "\u0000" + String(chan);
    if (!force && reported === _lastReported) return;
    _lastReported = reported;

    // Three different situations, and calling them all "Live API not ready" was wrong:
    // "No Output" is the API answering correctly about a track that goes nowhere.
    var why = "";
    if (!_routingValid) {
        why = /^\d+$/.test(String(port))
            ? "   (not a port name yet — Live API not ready)"
            : "   (track is not routed to a MIDI port — set 'MIDI To' on the track)";
    }
    post("Track MIDI out — port: " + port + "   channel: " + chan + why + "\n");
    if (_routingValid) {
        _lastPortSent = port;
        if (force) post("sendTrackPort: forced — re-announcing the port\n");
        // multichanmidiout matches against a list it only builds on request
        sendStatus("ports");
    }
    if (_routingValid) {
        // NOT outlet 0: that one feeds multichanmidiout AND udpsend, and udpsend's
        // own "port" message takes a number — hence "bad arguments for message port".
        // Out of the status outlet instead:  [route port] → [prepend port] → multichanmidiout
        sendStatus("port", port);
        // A valid port answers the only question the fallback was asking, so stop it
        // before it reports "no bang from [live.thisdevice]" into a session where
        // everything already works — that reads like a fault and is not one.
        try { if (_liveReadyFallback) _liveReadyFallback.cancel(); } catch(e) {}
        // The routing can validate on one of the retries rather than the first try.
        // Whenever it does, that is the moment the organ may build its GUI.
        maybeLoadSavedOrgan();
    }
}

// The Live API is not up when the script loads — every early call answers
// "Live API is not initialized, use live.thisdevice…", and the observers built then
// stay invalid, which is why the port came back as "0" and later "1" instead of a
// name.  [live.thisdevice] bangs once Live is ready; it is created here and wired
// back in, so no manual patching is needed.
var _liveReadyFired = false;
var _liveReadyFallback = null;
var LIVE_READY_FALLBACK_MS = 3000;

// [message portInfo] — print what Live reports and what would be sent, so it can be
// held against multichanmidiout's own "ports" listing.  multichanmidiout matches on the
// NAME, so the two spellings have to agree exactly, character for character.
function portInfo() {
    post("--- MIDI routing ------------------------------------------\n");
    if (!_routingAPIs.length) {
        post("  no observers — send watchTrackOutput first\n");
        return;
    }
    var api  = _routingAPIs[0];
    var port = routingDisplayName(api, "output_routing_type");
    var chan = routingDisplayName(api, "output_routing_channel");
    post("  Live says port    : \"" + port + "\"  (" + (port === null ? "read failed" :
         String(port).length + " chars") + ")\n");
    post("  Live says channel : \"" + chan + "\"\n");
    post("  counts as a port  : " + (_routingValid ? "yes" : "NO — nothing will be sent") + "\n");
    post("  last announced    : \"" + _lastPortSent + "\"\n");
    post("  Send 'ports' to multichanmidiout and compare the spelling: it matches on\n");
    post("  the name, so a port missing from its list is a name that does not agree.\n");
    post("-----------------------------------------------------------\n");
}

function liveReady() {
    if (_liveReadyFired) return;          // the bang can arrive twice: object + fallback
    _liveReadyFired = true;
    try { if (_liveReadyFallback) _liveReadyFallback.cancel(); } catch(e) {}
    post("Live is ready — reading the track's MIDI routing\n");
    watchTrackOutput();
    maybeLoadSavedOrgan();
}

// The organ load waits on two things, and neither one alone is enough:
//
//   _bootReady      the 400ms settle, because initStorage() may still be inside its
//                   own 150ms pattrstorage recall and the organ path not yet readable
//   _liveReadyFired the MIDI port, because building the GUI emits the controller
//                   defaults ("so the organ agrees") and every stop's initial state.
//                   Sent before multichanmidiout has a port, those are dropped —
//                   "no port selected" — and the organ never gets them.
//
// Whichever arrives second starts the load.  Order used to be luck: a saved
// [live.thisdevice] happened to bang before the 400ms task, and once that object was
// removed from the patcher the defaults went out into nothing.
var _bootReady       = false;
var _organAutoLoaded = false;

// ================================================================================================
// PORTABLE ORGAN PATH
// ================================================================================================
// The organ file used to be remembered by its absolute path, which only ever works on
// the machine that saved it.  Opening the set on a second computer asked for
//   /Users/maciej/Meine Ablage (…)/organ-control-system-claudecode/mapping/config/…
// while the project actually sat under /Users/marionworle/DRIVE/… — dictwrap reported
// "file not found", the organ type came out UNKNOWN and no module loaded at all.
//
// Store it relative to the project folder instead, and remap an absolute one that was
// written by an older version (or by the other machine) onto the current root, so an
// existing preset bank keeps working without re-picking the organ.

// scriptDir is "<root>/js/" — the project root is one level up, name included.
function projectRoot() {
    if (!scriptDir) return null;
    var sep  = (scriptDir.indexOf("/") !== -1) ? "/" : "\\";
    var trim = scriptDir.replace(new RegExp("\\" + sep + "+$"), "");   // drop trailing sep
    return trim.substring(0, trim.lastIndexOf(sep) + 1);                 // ".../<root>/"
}

function projectFolderName() {
    var root = projectRoot();
    if (!root) return null;
    var sep  = (root.indexOf("/") !== -1) ? "/" : "\\";
    var trim = root.replace(new RegExp("\\" + sep + "+$"), "");
    return trim.substring(trim.lastIndexOf(sep) + 1);
}

function toPortablePath(abs) {
    var root = projectRoot();
    if (!root || !abs) return abs;
    if (String(abs).indexOf(root) === 0) return String(abs).substring(root.length);
    return abs;                       // outside the project — keep it absolute
}

function fromPortablePath(stored) {
    var root = projectRoot();
    if (!root || !stored) return stored;
    stored = String(stored);
    var sep    = (root.indexOf("/") !== -1) ? "/" : "\\";
    var folder = projectFolderName();
    // Absolute, and pointing into a project folder of this name: rebase onto ours.
    // That is what carries a bank written on the other machine.
    if (folder) {
        var marker = sep + folder + sep;
        var at = stored.indexOf(marker);
        if (at !== -1) return root + stored.substring(at + marker.length);
    }
    // Already relative
    if (stored.indexOf(sep) !== 0 && stored.indexOf(":") === -1) return root + stored;
    return stored;                    // absolute and elsewhere — take it at its word
}

function maybeLoadSavedOrgan() {
    // What the GUI build actually needs is the PORT, so wait on _routingValid.
    // _liveReadyFired is only the give-up signal, for a track routed to None or a
    // patcher opened outside Live — there the port is never coming and the organ
    // still has to load.
    if (!_bootReady || _organAutoLoaded) return;
    if (!_routingValid && !_liveReadyFired) return;
    _organAutoLoaded = true;
    var stored    = organStorage ? organStorage.getOrganPath() : null;
    var savedPath = stored ? fromPortablePath(stored) : null;
    if (savedPath) {
        post("organTool_Universal: auto-reloading organ: " + savedPath + "\n");
        if (savedPath !== stored) post("  (remapped from: " + stored + ")\n");
        loadOrgan(savedPath);
    } else {
        post("organTool_Universal: no saved organ path (first run)\n");
    }
}

// ================================================================================================
// [message cleanupLiveReady] — clear out the leftover trigger objects
// ================================================================================================
// Every load that found no [live.thisdevice] built a fresh one plus a [prepend liveReady]
// to go with it.  Deleting the thisdevice objects by hand left the prepends behind, so
// they piled up at the same spot — eight of them, none of them fed by anything, which is
// why the bang never came and the fallback timer had to cover every start.
//
// Not automatic: removing objects from someone's patcher on load is the wrong kind of
// surprise.  Send "cleanupLiveReady" once, check the patcher, save.
function cleanupLiveReady() {
    if (!_maxPatcher) { post("cleanupLiveReady: no patcher\n"); return; }

    var doomed = [], obj = null;
    try { obj = _maxPatcher.firstobject; } catch(e) { obj = null; }
    while (obj) {
        var next = null;
        try { next = obj.nextobject; } catch(e) { next = null; }
        if (isLiveReadyPrepend(obj)) doomed.push(obj);
        obj = next;
    }

    post("cleanupLiveReady: found " + doomed.length + " [prepend liveReady] object(s)\n");
    var gone = 0;
    doomed.forEach(function(o) {
        try { _maxPatcher.remove(o); gone++; } catch(e) {
            post("  could not remove one: " + e.message + "\n");
        }
    });

    // A thisdevice that already exists keeps its wiring; only build one if none is left.
    var td = findByClassHere("live.thisdevice");
    if (!td) {
        td = _maxPatcher.newdefault(20, 470, "live.thisdevice");
        try { td.varname = "organ_live_ready"; } catch(e) {}
    }
    var fwd = _maxPatcher.newdefault(20, 500, "prepend", "liveReady");
    try { fwd.varname = "organ_live_ready_fwd"; } catch(e) {}
    if (td && fwd) {
        _maxPatcher.connect(td, 0, fwd, 0);
        if (_maxBox) _maxPatcher.connect(fwd, 0, _maxBox, 0);
    }

    post("cleanupLiveReady: removed " + gone + ", rebuilt one [live.thisdevice] → " +
         "[prepend liveReady] → this object.\n");
    post("  Check the patcher, then SAVE — otherwise it is gone again next load.\n");
}

// Box text is the reliable identifier, but the JS API does not always hand it over.
// Fall back on what built these: class "prepend" at the exact spot newdefault used.
function isLiveReadyPrepend(o) {
    var txt = null;
    try { txt = String(o.getattr("text")); } catch(e) { txt = null; }
    if (txt && txt !== "undefined") return txt === "prepend liveReady";

    var cls = "";
    try { cls = String(o.maxclass).toLowerCase(); } catch(e) { return false; }
    if (cls.indexOf("prepend") === -1) return false;
    // Position alone is not enough: any other prepend parked at the same spot would be
    // swept up with them.  newdefault gave these a width of 109, so require that too.
    try {
        var r = o.rect;
        return !!(r && Math.round(r[0]) === 20 && Math.round(r[1]) === 500 &&
                  Math.abs((r[2] - r[0]) - 109) < 2);
    } catch(e) { return false; }
}

function makeLiveReadyTrigger() {
    // The decisive test is not whether we can find the object but whether one already
    // did its job: liveReady() only runs when a wired [live.thisdevice] banged.  By the
    // time this is called (400ms after init, behind the organ load) that has either
    // happened or there is nothing there.  Searching for the box was the unreliable
    // part — a saved one banged correctly and was still not found by name or class.
    if (_liveReadyFired) return;
    try {
        var existing = findNamedAroundHere("organ_live_ready")
                    || findByClassHere("live.thisdevice");
        if (existing) {
            try { existing.varname = "organ_live_ready"; } catch(e) {}
            armLiveReadyFallback();       // in case that one is not wired to us
            return;
        }
        var td = _maxPatcher.newdefault(20, 470, "live.thisdevice");
        if (!td) { armLiveReadyFallback(); return; }
        try { td.varname = "organ_live_ready"; } catch(e) {}
        var fwd = _maxPatcher.newdefault(20, 500, "prepend", "liveReady");
        if (fwd) {
            _maxPatcher.connect(td, 0, fwd, 0);
            if (_maxBox) _maxPatcher.connect(fwd, 0, _maxBox, 0);
        }
        post("Created [live.thisdevice] to wait for the Live API\n");
    } catch (e) {
        post("makeLiveReadyTrigger: " + e.message + "\n");
    }
    armLiveReadyFallback();
}

// Never depend on the object alone: an adopted [live.thisdevice] may not be wired to
// this v8, and then the routing would never be read.  By this point the Live API is up
// regardless, so just go ahead.  Module scope — a local Task is collected before it
// fires.
function armLiveReadyFallback() {
    if (_liveReadyFired) return;
    if (!_liveReadyFallback) _liveReadyFallback = new Task(function() {
        if (_liveReadyFired) return;
        post("Live API ready (fallback timer — no bang from [live.thisdevice])\n");
        liveReady();
    });
    try { _liveReadyFallback.cancel(); } catch(e) {}
    _liveReadyFallback.schedule(LIVE_READY_FALLBACK_MS);
}

// First object of a given class at or below the patcher this v8 sits in.
function findByClassHere(cls) {
    function walk(patcher, depth) {
        if (!patcher || depth > 6) return null;
        var obj = patcher.firstobject;
        while (obj) {
            try {
                var mc = String(obj.maxclass).toLowerCase();
                if (mc === cls || mc.indexOf(cls) !== -1) return obj;
            } catch(e) {}
            var sub = null;
            try { sub = (typeof obj.subpatcher === "function") ? obj.subpatcher() : null; }
            catch(e) { sub = null; }
            if (sub) { var hit = walk(sub, depth + 1); if (hit) return hit; }
            obj = obj.nextobject;
        }
        return null;
    }
    cls = String(cls).toLowerCase();
    try { return walk(_maxPatcher, 0); } catch(e) { return null; }
}

function findNamedAroundHere(name) {
    try {
        return system.modules.common
            ? system.modules.common.findNamedAround(_maxPatcher, name)
            : _maxPatcher.getnamed(name);
    } catch (e) { return null; }
}

function watchTrackOutput() {
    if (_watching) { sendTrackPort(); return; }   // already installed; just re-read
    try {
        // Observers must be module-level, or Max collects them and the callback
        // silently stops firing — the same trap as the suppression Task.
        _routingAPIs = [];
        ["output_routing_type", "output_routing_channel"].forEach(function(prop) {
            var api = new LiveAPI(function() { sendTrackPort(); },
                                  "this_device canonical_parent");
            api.property = prop;          // assigning .property starts the observer
            _routingAPIs.push(api);
        });
        sendTrackPort();                  // and once now, for the initial state
        _watching = _routingValid;        // only count as installed once it answered

        // Opening a set, the track routing is often not restored at this point, and
        // the observer does not fire for a value that was already there.  Ask again
        // a couple of times; re-sending the same port is harmless.
        if (_portRetries.length) return;   // retries already pending
        [1500, 4000].forEach(function(ms) {
            // Rebuild rather than re-read: an observer created before the Live API
            // was up stays invalid, and reading it again only repeats the bad answer.
            var t = new Task(function() {
                if (_routingValid) sendTrackPort();
                else               watchTrackOutput();
            });
            _portRetries.push(t);         // module-level, or Max collects them
            t.schedule(ms);
        });

        post("Watching track MIDI output routing (re-checking at 1.5s and 4s)\n");
    } catch (e) {
        post("watchTrackOutput: not available (" + e.message + ")\n");
    }
}

// ================================================================================================
// LOAD GUARD — nothing fires while Live is restoring the set
// ================================================================================================
// Opening a set makes Live push every stored parameter value back into its widget,
// and a live.numbox or a button restoring its value OUTPUTS it.  A store button
// coming back as 1 would overwrite a preset before the organist has touched
// anything.  So preset commands are ignored for a moment after the script loads.
//
// The guard is a safety net, not the whole answer: turn OFF "Parameter Mode Enable"
// on the trigger buttons (store / recall / clear / move).  Their value means nothing
// between sessions, and a non-parameter object neither stores nor restores.  Keep
// parameter mode only where the value itself matters — the two number boxes.

var BOOT_GUARD_MS = 2000;
var _bootUntil    = Date.now() + BOOT_GUARD_MS;

function bootGuardBlocks(what) {
    if (Date.now() >= _bootUntil) return false;
    post("ignored \"" + what + "\" — still loading (" +
         Math.max(0, _bootUntil - Date.now()) + "ms left)\n");
    return true;
}

/** presetGuard 0 — lift the guard by hand; presetGuard 1 — re-arm it. */
function presetGuard(on) {
    _bootUntil = Number(on) ? (Date.now() + BOOT_GUARD_MS) : 0;
    post("Preset load guard " + (Number(on) ? "armed" : "lifted") + "\n");
}

// ================================================================================================
// NOTE CONTROL — drive presets and stops from incoming MIDI notes
// ================================================================================================
//   note 0            → recall preset, the VELOCITY carries the preset number
//   any other note    → stop (note + offset), velocity > 0 = on, 0 = off
//
// Note 0 is always the preset selector and never a stop, which is why an organ with
// more than 127 stops needs the offset: a second track sends the same notes 1..127
// with offset 127, addressing stops 128..254, and so on.  The offset is a trailing
// argument, so one handler serves every track:
//
//   [notein] → [pack i i] → [prepend organNote]              → [v8]     stops 1..127
//   [notein] → [pack i i] → [append 127] → [prepend organNote] → [v8]   stops 128..254
//
// Sending it as an argument rather than as module state keeps the tracks independent:
// two tracks can address different ranges at the same time without racing each other.

// ---- Stop-offs: untouched by default ----------------------------------------------
//
// A note-off turns its stop off, immediately, exactly as it arrives.  Nothing is
// buffered, reordered or second-guessed.
//
// The machinery below can hold stop-offs back for a moment and discard the ones a
// transport stop caused, which keeps a registration standing when playback halts.
// It is OFF, because a delay between the note and the stop moving is the kind of
// thing that feels broken even when it is working as designed.  Turn it on with
//
//   [message organOffDefer 50]     hold stop-offs 50ms, drop the ones a stop caused
//   [message organOffDefer 0]      back to untouched (the default)
//
// While it is on, an incoming ON removes that stop from the queue, so a jump — offs
// for the old notes, ons for the new — cannot switch off a stop that both sides share.

var _offDefer      = 0;         // 0 = pass stop-offs straight through
var _pendingOffs   = {};        // stopID → queued, waiting out the window
var _offTask       = null;      // module-level: a local Task can be collected before it fires
var _transportAPI  = null;      // likewise — an observer held only by a local stops firing
var _portRetries   = [];        // startup re-checks of the track routing, kept alive
var _lastReported  = null;      // last port+channel logged, valid or not
var _routingValid  = false;     // did the observers come up against a live API?
var _lastPortSent  = null;      // only announce a port that actually changed
var _watching      = false;     // observers already installed and valid
var _wasPlaying    = 0;

function organOffDefer(ms) {
    _offDefer = Math.max(0, Number(ms) || 0);
    if (_offDefer) {
        if (!_transportAPI) watchTransport();   // only needed while offs are held back
        post("Stop-offs held " + _offDefer + "ms; the ones a transport stop causes are dropped\n");
    } else {
        dropPendingOffs("deferral off");
        post("Stop-offs act immediately\n");
    }
}

function setStop(stopID, on) {
    if (system.organModule && typeof system.organModule.handleStopEvent === "function") {
        system.organModule.handleStopEvent(stopID, null, null, null, on);
    }
}

function flushOffs() {
    var ids = Object.keys(_pendingOffs);
    _pendingOffs = {};
    ids.forEach(function(id) { setStop(Number(id), false); });
}

function queueOff(stopID) {
    if (!_offDefer) { setStop(stopID, false); return; }
    _pendingOffs[stopID] = true;
    if (!_offTask) _offTask = new Task(flushOffs);
    try { _offTask.cancel(); } catch(e) {}
    _offTask.schedule(_offDefer);
}

function dropPendingOffs(why) {
    var n = Object.keys(_pendingOffs).length;
    _pendingOffs = {};
    if (_offTask) { try { _offTask.cancel(); } catch(e) {} }
    if (n) post("Transport " + why + " — kept " + n + " stop(s) it would have cancelled\n");
}

function onTransportChange() {
    try {
        var playing = parseInt(_transportAPI.get("is_playing"), 10) ? 1 : 0;
        if (_wasPlaying && !playing) {
            dropPendingOffs("stopped");
            panicOnStop();
        }
        _wasPlaying = playing;
    } catch (e) { /* transport unreadable — nothing else depends on this */ }
}

// A dense passage can leave a note-on behind the last note-off, and the pipe then
// stays open with nothing left to close it.  Stopping the transport is the moment
// the player expects silence, so send the instrument's own note-off command on
// every manual channel — the definitions from the instrument file, so this stays
// right for an organ whose panic is not CC 123.
//
// Only notes.  The registration is untouched: stopping must not cost the stops that
// are drawn, which is exactly the complaint that had the earlier note-off handling
// removed.
function panicOnStop() {
    try {
        if (system.organModule && typeof system.organModule.panicAll === "function") {
            system.organModule.panicAll();
            post("Transport stopped — note-off sent on every manual channel\n");
        }
    } catch (e) {
        post("panicOnStop: " + e.message + "\n");
    }
}

function watchTransport() {
    try {
        _transportAPI = new LiveAPI(function() { onTransportChange(); }, "live_set");
        _transportAPI.property = "is_playing";
        _wasPlaying = parseInt(_transportAPI.get("is_playing"), 10) ? 1 : 0;
        post("Watching the transport — stopping sends a note-off on every manual channel\n");
    } catch (e) {
        post("watchTransport: not available (" + e.message + ")\n");
    }
}

function organNote(note, velocity, offset) {
    note     = Number(note);
    velocity = Number(velocity);
    offset   = Number(offset) || 0;

    if (isNaN(note) || isNaN(velocity)) return;

    if (note === 0) {
        // Preset selector. A note-off arrives as velocity 0, which would read as
        // "preset 0" — ignore it and act on the note-on only.
        if (velocity > 0) {
            if (organStorage) organStorage.recall(velocity);
            else post("organNote: preset " + velocity + " — organStorage not loaded\n");
        }
        return;
    }

    var stopID = note + offset;

    if (velocity > 0) {
        delete _pendingOffs[stopID];   // a fresh ON outranks an off queued before it
        setStop(stopID, true);
    } else {
        queueOff(stopID);
    }
}

// ================================================================================================
// WRITE THE CURRENT REGISTRATION INTO A MIDI CLIP
// ================================================================================================
//   [message registrationClip]           into the arrangement, over the loop brace
//   [message registrationClip session]   into the selected session slot instead
//   [message registrationClip arrangement device]   force the device-facing notes
//
// The loop brace is the selection: set it over the bars the registration should
// hold for, then press the button.  The notes run the full length, so the stops
// come on at the start and release at the end.
//
// WHICH NOTES GO IN — two readings, and the organ decides which one is possible:
//
//   "output" — the addresses this device sends (stop.midiNote on its stop channel).
//              Put that clip on a track routed straight at the organ and the device
//              is not needed to play it back.  Only available when the organ is
//              driven by NOTES.
//   "device" — the stopID as the pitch, which organNote() translates on the way out.
//              Works for every console — cc, two-CC, Laukhuff program changes, sysex —
//              but the clip has to run through this device.
//
// A cc / program / sysex organ gets "device" automatically, and the reason is
// printed: a MIDI clip holds notes, and Live's LOM has no route for writing MIDI CC
// envelopes into one.  A CC-driven registration therefore cannot be expressed as a
// clip that speaks directly to the organ — only as one that speaks to this device.

// ---- Does Live expose the arrangement time selection? -----------------------------
//
// The loop brace is used as "the selection" because I could not find the time
// selection in the LOM.  Rather than keep guessing across Live versions, ask Live:
// this prints what live_set and live_set view actually offer, filtered to the names
// that could plausibly carry a selection.  If something turns up, the clip functions
// can read it directly and the loop brace stops being necessary.
//
//   [message probeSelection]

function probeSelection() {
    ["live_set", "live_set view", "live_app view"].forEach(function(path) {
        try {
            var api  = new LiveAPI(null, path);
            var info = String(api.info || "");
            var hits = info.split("\n").filter(function(line) {
                return /select|loop|time|start|end|punch|highlight/i.test(line);
            });
            post("=== " + path + " ===\n");
            if (hits.length) hits.forEach(function(l) { post("   " + l + "\n"); });
            else             post("   (nothing selection-like)\n");
        } catch (e) {
            post("=== " + path + " === unavailable (" + e.message + ")\n");
        }
    });

    // The values themselves, for comparison.  start_time is the interesting one:
    // Live 12 publishes no selection bounds (play_selection proves it knows the
    // selection, but only as an action), so if start_time tracks where the selection
    // begins, that is the closest thing to a cursor the LOM offers.
    // Move the insert marker, run this again, and see whether it follows.
    try {
        var song = new LiveAPI(null, "live_set");
        post("start_time = "         + song.get("start_time") +
             "   current_song_time = " + song.get("current_song_time") +
             "   last_event_time = "  + song.get("last_event_time") + "\n");
        post("loop_start = "         + song.get("loop_start") +
             "   loop_length = "     + song.get("loop_length") +
             "   loop = "            + song.get("loop") + "\n");
    } catch (e) { /* not in Live */ }
}

function clipLoopSelection() {
    var song = new LiveAPI(null, "live_set");
    return {
        start:  parseFloat(song.get("loop_start")),
        length: parseFloat(song.get("loop_length"))
    };
}

// Arrangement clips on this track that overlap [start, start+length).
// Returns [{clip, start, end}], earliest first.
function clipsOverlapping(start, length) {
    var end = start + length;
    var out = [];
    try {
        var track = new LiveAPI(null, "this_device canonical_parent");
        var ids   = track.get("arrangement_clips") || [];
        for (var i = 0; i < ids.length; i++) {
            if (String(ids[i]) === "id") continue;          // the list interleaves "id" markers
            var clip = new LiveAPI(null, "id " + ids[i]);
            if (!clip.id || String(clip.id) === "0") continue;
            var cs = parseFloat(clip.get("start_time"));
            var ce = parseFloat(clip.get("end_time"));
            if (isNaN(cs) || isNaN(ce)) continue;
            if (cs < end && ce > start) out.push({ clip: clip, start: cs, end: ce });
        }
        out.sort(function(a, b) { return a.start - b.start; });
    } catch (e) {
        post("registrationClip: could not list the track's clips (" + e.message + ")\n");
    }
    return out;
}

// The span one merged clip has to cover: the loop, plus every clip it touches.
// The loop end matters even when no clip reaches it (a clip stopping short must be
// extended), and a clip reaching past the loop matters too (its tail must survive).
function mergeSpan(selStart, selLength, found) {
    var lo = selStart, hi = selStart + selLength;
    for (var i = 0; i < found.length; i++) {
        lo = Math.min(lo, found[i].start);
        hi = Math.max(hi, found[i].end);
    }
    return { lo: lo, hi: hi, noteStart: selStart - lo };
}

// A clip's notes in ARRANGEMENT time.  A clip's own timeline starts at its
// start_marker, which is what the clip shows at its start_time on the timeline —
// so the two have to be reconciled, or every carried note lands displaced.
function readClipNotesAbsolute(entry) {
    var out = [];
    try {
        var clip   = entry.clip;
        var marker = parseFloat(clip.get("start_marker")) || 0;
        var raw    = clip.call("get_notes_extended", 0, 128, 0, 100000);
        var s      = (raw && raw.join) ? raw.join("") : String(raw);
        var obj    = JSON.parse(s);
        (obj.notes || []).forEach(function(n) {
            out.push({
                pitch:    n.pitch,
                start:    entry.start + (n.start_time - marker),
                duration: n.duration,
                velocity: n.velocity,
                mute:     n.mute ? 1 : 0
            });
        });
    } catch (e) {
        post("registrationClip: could not read the notes of the clip at " +
             entry.start + " (" + e.message + ") — they would be lost, aborting\n");
        throw e;
    }
    return out;
}

// Put back the part of a cut-up clip that lies outside the loop, as its own clip.
// Notes crossing the boundary are trimmed to it — that is what cutting a range means;
// a note is not moved or dropped, only shortened to what still fits.
// Returns how many notes survived, so the report can say what was kept.
function notesInWindow(notes, from, to) {
    var out = [];
    notes.forEach(function(n) {
        var noteEnd = n.start + n.duration;
        var a = Math.max(n.start, from);
        var b = Math.min(noteEnd, to);
        if (b <= a) return;                       // nothing of this note is in here
        out.push({
            pitch:    n.pitch,
            start:    a - from,                   // relative to the window's own origin
            duration: b - a,
            velocity: n.velocity,
            mute:     n.mute
        });
    });
    return out;
}

function rebuildRemnant(from, to, notes) {
    var inWindow = notesInWindow(notes, from, to);
    if (!inWindow.length) return 0;

    var remnant = createArrangementClip(from, to - from);
    if (!remnant) return 0;
    fillClipWithNotes(remnant, [], 0, 0, inWindow);
    return inWindow.length;
}

function deleteArrangementClip(clip) {
    try {
        var track = new LiveAPI(null, "this_device canonical_parent");
        track.call("delete_clip", "id", clip.id);
    } catch (e) {
        post("registrationClip: could not delete the clip (" + e.message + ")\n");
        throw e;
    }
}

// ================================================================================================
// MIDI EFFECT RACK — name the chains after the loaded organ
// ================================================================================================
//   [message rackChainNames]  →  outlet 1  →  the rack builder
//
// WIRING outlet 1.  Route only what has to lose its selector; route's rightmost
// outlet passes everything else through UNCHANGED, selector included, so
// renameChain reaches the rack whole and needs no prepend to put it back:
//
//   outlet 1 ──> [route port preset]
//                  ├ port   -> [prepend port] -> [multichanmidiout]   (port is stripped
//                  │                                by route, and multichanmidiout
//                  │                                needs to see the word)
//                  ├ preset -> display / number boxes
//                  └ reject -> the rack bpatcher   ("renameChain 0 PRESET 0")
//
// One "renameChain <id> <name> <colour>" per chain, in the format the rack patch
// already speaks:
//   chain 0        PRESET          — the preset selector; the velocity picks which
//   chain <stopID> "M4: 1 Super IV-IV"
//
// Chain number = stopID = the note that addresses the stop, so the rack, the clips
// and the console all use one numbering.

// Send a marker out of every outlet, so a [print] settles which one it is on
// instead of anyone reasoning about it.  Outlet 0 feeds multichanmidiout, which will
// complain about the marker — that complaint is itself the proof it arrived.
//   [message outletTest]
function outletTest() {
    post("outletTest: marker out of outlet 0, then outlet 1\n");
    outlet(0, "outletTest", 0);
    outlet(1, "outletTest", 1);
    post("outletTest: both sent — whichever number your print shows is the outlet it is on\n");
}

function rackChainNames() {
    if (!system.organModule || typeof system.organModule.getRackChainNames !== "function") {
        post("rackChainNames: no organ loaded that can name its chains\n");
        return;
    }
    var names = system.organModule.getRackChainNames();

    // One message per chain, out of the STATUS outlet.  See the wiring note above:
    // let these fall through route's reject outlet so the selector survives.
    //
    // Not a dict: the rack's own dict is named with #0/#1 so several devices can
    // coexist in one session, and a fixed name from here could never address it.
    names.forEach(function(c) {
        sendStatus("renameChain", c.id, c.name, 0);
    });

    post("rackChainNames: " + names.length + " renameChain message(s) — outlet 1 and [receive organStatus] " +
         "(first: 0 \"" + names[0].name + "\", last: " + names[names.length-1].id +
         " \"" + names[names.length-1].name + "\")\n");
}

// One message per mode, so a button can carry the mode in its own name instead of
// an argument.  All four are the same call.
//   [message makeClip]      merge (the default)
//   [message replaceClip]   cut the loop range out and set the clip into the gap
//   [message newClip]       just make a clip, Live sorts out the overlap
//   [message glueClip]      replace, but leaving ONE continuous clip
function makeClip()    { registrationClip("merge"); }
function mergeClip()   { registrationClip("merge"); }
function replaceClip() { registrationClip("replace"); }
function newClip()     { registrationClip("new"); }
// replace, but leaving one continuous clip rather than three pieces
function glueClip()    { registrationClip("replace", "glue"); }

function registrationClip() {
    if (!system.organModule || typeof system.organModule.getRegistrationNotes !== "function") {
        post("registrationClip: the loaded organ cannot describe its registration\n");
        return;
    }

    // Keywords in any order: session | arrangement, output | device,
    // merge | replace | new
    //   merge    fuse the loop and everything it touches into one clip (default)
    //   replace  cut the loop range out of what is there and set the clip into the
    //            gap; what lies outside the loop stays, as its own clip
    //   new      just make a clip and let Live sort out the overlap
    //   glue     with replace: leave ONE continuous clip instead of three pieces
    var where = "arrangement", modeArg = null, how = "merge", glue = false;
    Array.prototype.slice.call(arguments).forEach(function(a) {
        a = String(a).toLowerCase();
        if      (a === "session" || a === "arrangement")          where   = a;
        else if (a === "output"  || a === "device")               modeArg = a;
        else if (a === "merge" || a === "replace" || a === "new") how     = a;
        else if (a === "glue")                                    glue    = true;
    });
    var merge = (how === "merge");

    // Which reading of "the notes" is available for this organ
    var system_ = (typeof system.organModule.getStopSystem === "function")
        ? system.organModule.getStopSystem() : "note";
    // Device-facing notes by default: they pass through organNote, so the clip plays
    // on any console this tool can drive — cc, two-CC, program changes, sysex.
    // "output" writes the organ's own addresses instead, which plays without this
    // device in the chain but only exists for a note-driven organ.
    var mode = modeArg || "device";
    if (mode === "output" && system_ !== "note") {
        post("registrationClip: this organ drives stops by \"" + system_ + "\", which a MIDI " +
             "clip cannot carry — writing device-facing notes instead\n");
        mode = "device";
    }

    var notes = system.organModule.getRegistrationNotes(mode);
    if (!notes.length) {
        post("registrationClip: no stops are drawn — nothing to write\n");
        return;
    }

    // A MIDI clip carries no per-note channel; the channel comes from the track's
    // routing.  Say so plainly rather than writing a clip that is quietly wrong.
    if (mode === "output") {
        var channels = [];
        notes.forEach(function(n) {
            if (n.channel !== null && channels.indexOf(n.channel) === -1) channels.push(n.channel);
        });
        if (channels.length > 1) {
            post("registrationClip: this registration spans channels " + channels.join(", ") +
                 " — one clip can only carry one, set the track routing to the right channel\n");
        }
    }

    try {
        var sel   = clipLoopSelection();
        var clip  = null;
        var into  = "a new clip";
        var noteStart = 0;              // where inside the clip the notes belong

        // Merging rebuilds the whole loop span as ONE clip: the notes have to run
        // across the entire selection, and writing into just the first overlapping
        // clip left every gap between clips empty and stopped at that clip's end.
        var carried = [];
        if (how === "replace" && glue && where === "arrangement") {
            // Cut the loop out AND leave one continuous clip.  Built as a single
            // clip from the start rather than made in pieces and glued afterwards:
            // gluing would only repair a state there is no reason to create.
            var gEnd = sel.start + sel.length;
            var gHit = clipsOverlapping(sel.start, sel.length);

            if (gHit.length) {
                var gSpan = mergeSpan(sel.start, sel.length, gHit);
                var gOld  = [];
                gHit.forEach(function(f) { gOld = gOld.concat(readClipNotesAbsolute(f)); });
                gHit.forEach(function(f) { deleteArrangementClip(f.clip); });

                // Everything outside the loop survives, trimmed at its edges, and is
                // re-based onto the new clip's origin.
                carried = notesInWindow(gOld, gSpan.lo, sel.start);
                notesInWindow(gOld, gEnd, gSpan.hi).forEach(function(n) {
                    n.start += (gEnd - gSpan.lo);
                    carried.push(n);
                });

                clip      = createArrangementClip(gSpan.lo, gSpan.hi - gSpan.lo);
                noteStart = sel.start - gSpan.lo;
                into      = "one clip from " + gSpan.lo + " to " + gSpan.hi +
                            ", loop range replaced (" + carried.length + " note(s) kept around it)";
            } else {
                // Empty stretch of arrangement: there is nothing to cut or glue, but
                // the registration still has to be written.  Falling through with a
                // null clip made the button do nothing at all.
                clip      = createArrangementClip(sel.start, sel.length);
                noteStart = 0;
                into      = "a new clip over the loop (nothing was there to replace)";
            }
        } else if (how === "replace" && where === "arrangement") {
            var selEnd = sel.start + sel.length;
            var hit    = clipsOverlapping(sel.start, sel.length);
            var kept   = 0;

            hit.forEach(function(f) {
                // Read before deleting: what lies outside the loop has to come back
                var old = readClipNotesAbsolute(f);
                deleteArrangementClip(f.clip);
                if (f.start < sel.start) kept += rebuildRemnant(f.start, sel.start, old);
                if (f.end   > selEnd)    kept += rebuildRemnant(selEnd,   f.end,    old);
            });

            clip      = createArrangementClip(sel.start, sel.length);
            noteStart = 0;
            into      = "the loop, cut out of " + hit.length + " clip(s)" +
                        (kept ? " (" + kept + " note(s) kept outside it)" : "");
        } else if (merge && where === "arrangement") {
            var found = clipsOverlapping(sel.start, sel.length);
            if (found.length) {
                // The new clip spans the loop AND every clip it touches — a clip
                // reaching past the loop must not lose the part that sticks out.
                var span = mergeSpan(sel.start, sel.length, found);
                var lo = span.lo, hi = span.hi;
                found.forEach(function(f) {
                    carried = carried.concat(readClipNotesAbsolute(f));
                });
                found.forEach(function(f) { deleteArrangementClip(f.clip); });

                clip      = createArrangementClip(lo, hi - lo);
                noteStart = sel.start - lo;      // where the loop sits inside the new clip
                into      = "one clip from " + lo + " to " + hi +
                            " (merged " + found.length + ", " + carried.length + " note(s) kept)";

                // Carried notes move with the new clip's origin
                carried.forEach(function(n) { n.start = n.start - lo; });
            } else {
                // Nothing under the loop to merge with — write the clip anyway.
                // merge is the default mode, so this was the most common way to press
                // the button and get silence.
                clip      = createArrangementClip(sel.start, sel.length);
                noteStart = 0;
                into      = "a new clip over the loop (nothing was there to merge)";
            }
        } else if (how === "new" && where === "arrangement") {
            // "just make a clip and let Live sort out the overlap" — which no branch
            // ever did.  clip stayed null, nothing was written, and the report blamed
            // an empty clip that had never been created.
            clip      = createArrangementClip(sel.start, sel.length);
            noteStart = 0;
            into      = "a new clip over the loop";
        } else if (merge && where === "session") {
            var slot = new LiveAPI(null, "live_set view highlighted_clip_slot");
            if (parseInt(slot.get("has_clip"), 10)) {
                clip = new LiveAPI(null, "live_set view highlighted_clip_slot clip");
                into = "the clip in the selected slot";
            } else if (slot.id && String(slot.id) !== "0") {
                // Empty slot: make the clip rather than doing nothing.
                slot.call("create_clip", sel.length);
                clip = new LiveAPI(null, "live_set view highlighted_clip_slot clip");
                into = "a new clip in the selected slot";
            } else {
                post("registrationClip: no clip slot is selected — select one in the " +
                     "session view first\n");
            }
        }

        // Held for the whole selection: the note-off at its end is the registration
        // ending, which is exactly what should happen.  Only a note-off caused by
        // the TRANSPORT stopping is discarded — see the deferral above.
        if (!clip) {
            post("registrationClip: no clip could be made for this selection — " +
                 "nothing was written\n");
            return;
        }

        var result = fillClipWithNotes(clip, notes, sel.length, noteStart, carried);

        if (result.count === 0) {
            post("registrationClip: the clip was created but stayed EMPTY — neither " +
                 "add_new_notes nor set_notes put anything in it\n");
        } else if (result.count < 0) {
            post("registrationClip: sent " + notes.length + " stop(s) via " + result.how +
                 " (length " + sel.length + " beats); the clip could not be read back " +
                 "to confirm\n");
        } else {
            post("registrationClip: " + notes.length + " stop(s) as " + mode +
                 " notes into " + into + " via " + result.how +
                 " — " + result.count + " note(s) in it now, length " +
                 sel.length + " beats\n");
        }
    } catch (e) {
        post("registrationClip failed: " + e.message + "\n");
    }
}

// LiveAPI.call() reports a new object in several shapes depending on the call:
// 123, "123", "id 123" or the list ["id", 123].  Taking the trailing number covers
// all of them; building "id " + the raw value does not, and an API pointing at
// nothing then swallows every later call in silence — which is how a clip ends up
// created but empty.
function idFromResult(res) {
    if (res === null || res === undefined) return null;
    var m = String(res).match(/(\d+)\s*$/);
    return m ? m[1] : null;
}

function createArrangementClip(startTime, length) {
    var track = new LiveAPI(null, "this_device canonical_parent");
    try {
        var res = track.call("create_midi_clip", startTime, length);
        var id  = idFromResult(res);
        if (!id) throw new Error("create_midi_clip returned " + JSON.stringify(res));

        var clip = new LiveAPI(null, "id " + id);
        if (!clip.id || String(clip.id) === "0") {
            throw new Error("no clip at id " + id);
        }
        return clip;
    } catch (e) {
        post("registrationClip: could not create an arrangement clip (" + e.message + ").\n" +
             "  Try [message registrationClip session] to write into a session slot instead.\n");
        return null;
    }
}

function createSessionClip(length) {
    var slot = new LiveAPI(null, "live_set view highlighted_clip_slot");
    try {
        if (parseInt(slot.get("has_clip"), 10)) {
            post("registrationClip: the selected session slot already holds a clip — " +
                 "pick an empty one\n");
            return null;
        }
        slot.call("create_clip", length);
        return new LiveAPI(null, "live_set view highlighted_clip_slot clip");
    } catch (e) {
        post("registrationClip: could not create a session clip (" + e.message + ")\n");
        return null;
    }
}

// Put the notes in, then read them back.
//
// Two ways in, because neither is safe to assume: add_new_notes (Live 11+, takes a
// Dictionary) is the current one, and the old set_notes / note / done sequence is
// deprecated — a deprecated call can be a silent no-op, which leaves a clip created
// but empty with nothing reported. So: try the modern path, count what landed, and
// fall back to the classic sequence only if nothing did.
//
// Notes are held for the whole selection, so the stops draw at its start and
// release at its end.
function fillClipWithNotes(clip, notes, length, startAt, carried) {
    startAt = startAt || 0;
    carried = carried || [];
    // 0 means the call itself failed; -1 means it went through but the clip could
    // not be read back.  Only a hard 0 justifies the fallback — retrying after an
    // unverifiable success would write every note twice.
    var wrote = writeViaAddNewNotes(clip, notes, length, startAt, carried);
    if (wrote !== 0) return { count: wrote, how: "add_new_notes" };

    wrote = writeViaSetNotes(clip, notes, length, startAt, carried);
    return { count: wrote, how: (wrote !== 0 ? "set_notes" : "nothing worked") };
}

function writeViaAddNewNotes(clip, notes, length, startAt, carried) {
    try {
        var spec = { notes: [] };
        carried.forEach(function(n) {
            spec.notes.push({ pitch: n.pitch, start_time: n.start, duration: n.duration,
                              velocity: n.velocity, mute: n.mute });
        });
        notes.forEach(function(n) {
            spec.notes.push({
                pitch:      n.pitch,
                start_time: startAt,
                duration:   length,
                velocity:   127,
                mute:       0
            });
        });

        var d = new Dict();               // local is fine: consumed before we return
        d.parse(JSON.stringify(spec));
        clip.call("add_new_notes", d);
        d.freepeer();

        return countClipNotes(clip, length);
    } catch (e) {
        post("registrationClip: add_new_notes unavailable (" + e.message + ")\n");
        return 0;
    }
}

function writeViaSetNotes(clip, notes, length, startAt, carried) {
    try {
        clip.call("set_notes");
        clip.call("notes", notes.length + carried.length);
        carried.forEach(function(n) {
            clip.call("note", n.pitch, n.start, n.duration, n.velocity, n.mute);
        });
        notes.forEach(function(n) {
            // pitch, time, duration, velocity, muted
            clip.call("note", n.pitch, startAt, length, 127, 0);
        });
        clip.call("done");
        return countClipNotes(clip, length);
    } catch (e) {
        post("registrationClip: set_notes failed (" + e.message + ")\n");
        return 0;
    }
}

// How many notes the clip actually holds.  Returns -1 when it cannot be read, so a
// failed count is never mistaken for an empty clip.
function countClipNotes(clip, length) {
    try {
        var raw = clip.call("get_notes_extended", 0, 128, 0, 100000);
        var s   = (raw && raw.join) ? raw.join("") : String(raw);
        var obj = JSON.parse(s);
        return (obj && obj.notes) ? obj.notes.length : 0;
    } catch (e) {
        return -1;
    }
}

// ================================================================================================
// PRESET SYSTEM — message handlers callable from Max patch
// ================================================================================================
// Wire in Max:
//   [message presetStore 1 My Registration]  → [js organTool_Universal.js]
//   [message presetRecall 1]                 → [js organTool_Universal.js]
//   [live.menu preset_menu] → [prepend presetMenuSelect] → [js organTool_Universal.js]
//
// Optional patcher objects (looked up by varname):
//   pattrstorage named "storage"  — XML persistence across sessions
//   live.menu    named "preset_menu" — dropdown selector in the UI

function presetStore(presetNr, presetName) {
    if (bootGuardBlocks("presetStore")) return;
    // presetNr  : integer slot number (0–127)
    // presetName: string (rest of message). Max passes multi-word args as separate arguments,
    //             so we join them.
    var args  = Array.prototype.slice.call(arguments);
    var nr    = Number(args[0]);
    var name  = args.length > 1 ? args.slice(1).join(" ") : undefined;
    if (organStorage) organStorage.store(nr, name);
    else post("presetStore: organStorage not initialized\n");
}

// Guided store: confirms an overwrite, then asks for the name.
//   [message presetStorePrompt 3]  or  a preset button → [prepend presetStorePrompt]
function presetStorePrompt(presetNr) {
    if (bootGuardBlocks("presetStorePrompt")) return;
    if (!organStorage) { post("presetStorePrompt: organStorage not initialized\n"); return; }
    // Hand "no number" through as such.  Number(undefined) is NaN, and a NaN looks
    // like a bad argument rather than an absent one — which is what stopped the
    // bare [message presetStorePrompt] from ever opening its first dialog.
    organStorage.storePrompt(presetNr === undefined ? undefined : Number(presetNr));
}

// Move a preset to another slot, keeping its name.  Asks before overwriting.
//   [message presetMove]          asks which preset, then where to  ← button
//   [message presetMove 3 7]      both slots given outright
function presetMove(fromNr, toNr) {
    if (!organStorage) { post("presetMove: organStorage not initialized\n"); return; }
    if (fromNr === undefined || toNr === undefined) organStorage.movePrompt();
    else organStorage.movePreset(Number(fromNr), Number(toNr));
}

function presetMovePrompt() {
    if (organStorage) organStorage.movePrompt();
    else post("presetMovePrompt: organStorage not initialized\n");
}

// Stepping through the bank — for footswitches and page-turner pedals.
//   [message presetRecallCurrent]   load the current preset again
//   [message presetNext] / [message presetPrevious]
function presetRecallCurrent() {
    if (bootGuardBlocks("presetRecallCurrent")) return;
    if (organStorage) organStorage.recallCurrent();
    else post("presetRecallCurrent: organStorage not initialized\n");
}

function presetNext() {
    if (bootGuardBlocks("presetNext")) return;
    if (organStorage) organStorage.recallNext();
    else post("presetNext: organStorage not initialized\n");
}

function presetPrevious() {
    if (bootGuardBlocks("presetPrevious")) return;
    if (organStorage) organStorage.recallPrevious();
    else post("presetPrevious: organStorage not initialized\n");
}

// Write the current registration back into the preset in play, keeping its name.
//   [message presetStoreCurrent]
function presetStoreCurrent() {
    if (bootGuardBlocks("presetStoreCurrent")) return;
    if (organStorage) organStorage.storeCurrentPrompt();
    else post("presetStoreCurrent: organStorage not initialized\n");
}

// Rename the preset in play; the dialog opens pre-filled with its current name.
//   [message presetRename]
function presetRename() {
    if (bootGuardBlocks("presetRename")) return;
    if (organStorage) organStorage.renameCurrentPrompt();
    else post("presetRename: organStorage not initialized\n");
}

// Turn the MIDI rack chain naming back on (off by default).
//   [message presetChainNaming 1]
function presetChainNaming(on) {
    if (organStorage) organStorage.setChainRenaming(on);
    else post("presetChainNaming: organStorage not initialized\n");
}

// Delete the preset in play, after naming it in the prompt.
//   [message presetClearCurrent]
function presetClearCurrent() {
    if (bootGuardBlocks("presetClearCurrent")) return;
    if (organStorage) organStorage.clearCurrentPrompt();
    else post("presetClearCurrent: organStorage not initialized\n");
}

// Wipe the whole bank.  Asks twice — the first prompt can be dismissed by reflex.
//   [message presetClearAll]
function presetClearAll() {
    if (bootGuardBlocks("presetClearAll")) return;
    if (organStorage) organStorage.clearAllPrompt();
    else post("presetClearAll: organStorage not initialized\n");
}

// The [dialog] object's answer on its way back — wired automatically when the
// dialog is created, or by hand as [dialog] → [prepend fromDialog] → this object.
// Max dispatches on the exact symbol, so both spellings are accepted: a patch built
// by hand and one built by the script must not depend on the capital letter.
function fromDialog() {
    if (!organStorage) {
        post("fromDialog: organStorage not initialized\n");
        return;
    }
    organStorage.fromDialog.apply(null, Array.prototype.slice.call(arguments));
}

function FromDialog() {
    fromDialog.apply(null, Array.prototype.slice.call(arguments));
}

function presetRecall(presetNr) {
    if (bootGuardBlocks("presetRecall")) return;
    if (organStorage) organStorage.recall(Number(presetNr));
    else post("presetRecall: organStorage not initialized\n");
}

function presetDelete(presetNr) {
    if (bootGuardBlocks("presetDelete")) return;
    if (organStorage) organStorage.deletePreset(Number(presetNr));
    else post("presetDelete: organStorage not initialized\n");
}

function presetDeleteAll() {
    if (organStorage) organStorage.deleteAll();
    else post("presetDeleteAll: organStorage not initialized\n");
}

// Called when the live.menu "preset_menu" fires (outputs 0-based menu index).
function presetMenuSelect(menuIdx) {
    if (bootGuardBlocks("presetMenuSelect")) return;
    if (organStorage) organStorage.recallFromMenuIndex(Number(menuIdx));
    else post("presetMenuSelect: organStorage not initialized\n");
}

// ================================================================================================
// STOP EVENT ROUTING  (inlet 1 — routed from organ_stops send/receive)
// ================================================================================================
// Format: "stop <manualID|-1> <layerID|-1> <divisionID|-1> <stopID> <state 0|1>"
// Sent from every stop button via:  prepend stopID → prepend "stop" mID lID dID → send organ_stops
// OR (for file-based layer patchers): bpatcher outlet → prepend "stop" mID lID dID → send organ_stops
// This replaces per-button MaxobjListeners (each cost ~36 ms of newdefault overhead at load time).

function anything() {
    if (inlet !== 1 || messagename !== "stop") return;
    if (!system.organModule || typeof system.organModule.handleStopEvent !== "function") return;

    // arguments: [manualID, layerID, divisionID, stopID, state]
    var manualID   = (arguments[0] !== -1) ? arguments[0] : null;
    var layerID    = (arguments[1] !== -1) ? arguments[1] : null;
    var divisionID = (arguments[2] !== -1) ? arguments[2] : null;
    var stopID     = arguments[3];
    var state      = Boolean(arguments[4]);

    system.organModule.handleStopEvent(stopID, manualID, layerID, divisionID, state);
}

// ================================================================================================
// INITIALIZATION
// ================================================================================================

if (!initializeSystem()) {
    post("ERROR: System initialization failed!\n");
} else {
    post("Organ Control System v" + SYSTEM_VERSION + " - " + SYSTEM_VERSION_NOTE + "\n");
    post("Commands: loadOrgan(path), selectOrganFile(), presetStore(nr, name), presetRecall(nr)\n");

    // Auto-reload the organ that was loaded when the project was last saved.
    // 400ms: initStorage() may still be waiting on an asynchronous pattrstorage
    // recall (150ms Task) before the bank — and with it the organ path — is readable.
    var autoReloadTask = new Task(function() {
        _bootReady = true;
        // Routing first: the GUI build sends MIDI, so the port has to exist by then.
        // live.thisdevice tells us when the Live API is actually up, and the fallback
        // timer inside makeLiveReadyTrigger guarantees this resolves either way —
        // including outside Live, where no bang is ever coming.
        makeLiveReadyTrigger();
        // Only read the routing if Live has already reported in.  Asking earlier makes
        // v8liveapi print "Live API is not initialized" once per property per attempt —
        // eight lines in a fresh set — and returns nothing usable anyway.  When a saved
        // [live.thisdevice] bangs before this task, liveReady has already run and this
        // is the fast path; otherwise the fallback timer gets us there.
        if (_liveReadyFired) watchTrackOutput();
        if (!_transportAPI) watchTransport();   // for the note-off on a transport stop
        maybeLoadSavedOrgan();
    });
    autoReloadTask.schedule(400);
}

// Export for testing
if (typeof global !== 'undefined') {
    global.organControlSystem = {
        loadOrgan: loadOrgan,
        setStopState: setStopState,
        setTremulantState: setTremulantState,
        executeContextCommand: executeContextCommand,
        getCurrentOrganInfo: getCurrentOrganInfo,
        getSystemHealth: getSystemHealth,
        panic: panic,
        resetSystem: resetSystem
    };
}