// organTool_Universal_Optimized.js - BEST PRACTICE ORGAN CONTROL SYSTEM
// 01.00 - Context-aware commands with dependency injection
// 08.07.2025

autowatch = 1;

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
        var moduleFile = "organTool_" + organType + ".js";
        var modulePath = scriptDir + moduleFile;
        
        post("Loading organ module: " + modulePath + "\n");
        include(modulePath);
        
        // Explicit factory lookup — no eval(), no global/window (not available in Max js object)
        // Add a new case here when a new organ type module is added
        var factory = null;
        if (organType === "SINUA") {
            factory = (typeof createSINUAModuleWithDI === 'function') ? createSINUAModuleWithDI : null;
        } else if (organType === "MIDI") {
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
        organType: organType,
        
        // Context-aware command generator
        createContextCommand: function(manualID, layerID, type) {
            var baseContext = {
                manual: manualID || null,
                layer: layerID || null,
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
    
    try {
        var organData = loadOrganJSON(filepath);
        if (!organData) return false;
        
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

function configureProtocol(organType) {
    if (!system.modules.protocolLayer) return;
    
    try {
        var config = {};
        
        if (organType === "SINUA") {
            config = {
                targetIP: "127.0.0.1",
                targetPort: 8000,
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
// INITIALIZATION
// ================================================================================================

if (!initializeSystem()) {
    post("ERROR: System initialization failed!\n");
} else {
    post("Organ Control System v01.00 - Ready\n");
    post("Commands: loadOrgan(path), selectOrganFile(), displaySystemStatus()\n");
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