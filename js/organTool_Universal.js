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
outlets = 1;  // outlet 0: OSC messages → connect to udpsend in patcher  (address, arg1, arg2, ...)

// ================================================================================================
// MODULE LOADING SYSTEM - FIXED PATH DETECTION
// ================================================================================================

function getScriptDirectory() {
    var fullPath = this.patcher.filepath;
    if (!fullPath) {
        // Fallback: try parent patcher
        fullPath = this.patcher.parentpatcher ? this.patcher.parentpatcher.filepath : null;
    }
    
    if (!fullPath) {
        post("ERROR: Cannot determine script directory\n");
        return null;
    }
    
    // Handle both Unix and Windows paths
    var scriptDir;
    if (fullPath.indexOf("/") !== -1) {
        // Unix-style path
        scriptDir = fullPath.substring(0, fullPath.lastIndexOf("/")) + "/js/";
    } else {
        // Windows-style path  
        scriptDir = fullPath.substring(0, fullPath.lastIndexOf("\\")) + "\\js\\";
    }
    
    post("Script directory: " + scriptDir + "\n");
    return scriptDir;
}

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
        if (organStorage) organStorage.initStorage(_maxPatcher, scriptDir, _maxBox);

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
            if (organStorage) organStorage.setOrganPath(filepath);

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
                if (o.display_name) return String(o.display_name);
                if (o[prop] && o[prop].display_name) return String(o[prop].display_name);
            }
        } catch (parseError) { /* not JSON — the plain string is the name */ }
        return s;
    } catch (e) {
        return null;
    }
}

function sendTrackPort() {
    if (!_routingAPIs.length) return;
    var api  = _routingAPIs[0];
    var port = routingDisplayName(api, "output_routing_type");
    var chan = routingDisplayName(api, "output_routing_channel");

    post("Track MIDI out — port: " + port + "   channel: " + chan + "\n");

    if (port && port !== "None" && port !== "0") {
        outlet(0, "port", port);
    }
}

function watchTrackOutput() {
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
        post("Watching track MIDI output routing\n");
    } catch (e) {
        post("watchTrackOutput: not available (" + e.message + ")\n");
    }
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
    if (system.organModule && typeof system.organModule.handleStopEvent === "function") {
        system.organModule.handleStopEvent(stopID, null, null, null, velocity > 0);
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
    if (organStorage) organStorage.storePrompt(Number(presetNr));
    else post("presetStorePrompt: organStorage not initialized\n");
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
    if (organStorage) organStorage.recall(Number(presetNr));
    else post("presetRecall: organStorage not initialized\n");
}

function presetDelete(presetNr) {
    if (organStorage) organStorage.deletePreset(Number(presetNr));
    else post("presetDelete: organStorage not initialized\n");
}

function presetDeleteAll() {
    if (organStorage) organStorage.deleteAll();
    else post("presetDeleteAll: organStorage not initialized\n");
}

// Called when the live.menu "preset_menu" fires (outputs 0-based menu index).
function presetMenuSelect(menuIdx) {
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
    post("Organ Control System v01.27 - debug toggle; track MIDI routing follows to multichanmidiout\n");
    post("Commands: loadOrgan(path), selectOrganFile(), presetStore(nr, name), presetRecall(nr)\n");

    // Auto-reload the organ that was loaded when the project was last saved.
    // 400ms: initStorage() may still be waiting on an asynchronous pattrstorage
    // recall (150ms Task) before the bank — and with it the organ path — is readable.
    var autoReloadTask = new Task(function() {
        var savedPath = organStorage ? organStorage.getOrganPath() : null;
        if (savedPath) {
            post("organTool_Universal: auto-reloading organ: " + savedPath + "\n");
            loadOrgan(savedPath);
        } else {
            post("organTool_Universal: no saved organ path (first run)\n");
        }
        // Follow the track's MIDI output routing once Live has settled
        watchTrackOutput();
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