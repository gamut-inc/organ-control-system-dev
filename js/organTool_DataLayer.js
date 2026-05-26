// organTool_DataLayer_ContextAware.js - CONTEXT-AWARE STATE MANAGEMENT MODULE
// 01.00 - Complete context-aware state management with dependency injection
// 01.01 - Real OSC output: two-stage bundler replaces dead command queue
//         20ms bundle window + 200ms per-stop cooldown
//         new action types: layerdiv (/M/L/D), cancel sends /S 0 + /D 0, panic/reset wired
// 27.05.2026
// Maciej Sledziecki

autowatch = 1;

// ================================================================================================
// MODULE FACTORY - DEPENDS ON COMMON
// ================================================================================================

function createDataLayerModule(common) {
    if (!common) {
        throw new Error("DataLayer requires Common module dependency");
    }
    
    // Private module state
    var organState = {
        info: {
            name: "No Organ Loaded",
            type: null,
            filepath: null,
            loaded: false
        },
        stops: {},
        tremulants: {},
        controllers: {},
        divisions: {},
        presets: {
            current: null,
            loading: false,
            available: {}
        },
        settings: {
            includeTransmissions: false,
            autoSend: true,
            batchDelay: 50
        },
        _meta: {
            lastChanged: null,
            changeCount: 0,
            listeners: []
        }
    };
    
    var commandQueue = [];
    var stateHistory = [];

    // ================================================================================================
    // OSC OUTPUT — TWO-STAGE BUNDLER WITH PER-STOP COOLDOWN
    // ================================================================================================
    //
    // Stage 1 — Bundle window (20ms):
    //   Commands arriving within BUNDLE_WINDOW_MS for the same OSC path are collected,
    //   then flushed as one message:  /M1/L1/S 10 11 -2
    //
    // Stage 2 — Per-stop cooldown (200ms):
    //   After a stop is sent, it enters COOLDOWN_MS lockout to protect the organ hardware.
    //   If a new command arrives during cooldown, it is remembered (last wins).
    //   When cooldown expires the pending command is submitted to a new bundle window.
    //
    // cancel/panic/reset bypass both stages and send immediately.

    var BUNDLE_WINDOW_MS = 20;
    var COOLDOWN_MS      = 200;

    var pendingBundles = {};
    // pendingBundles["/M1/L1/S"] = { values: { <stopKey>: <signedValue> }, task: <Task> }

    var stopCooldowns = {};
    // stopCooldowns[<stopKey>] = { endTime: <ms>, pendingPath: <str|null>, pendingValue: <num|null>, task: <Task> }

    function scheduleOSC(oscPath, stopKey, signedValue) {
        var cd = stopCooldowns[stopKey];
        if (cd && Date.now() < cd.endTime) {
            // Stop is cooling down — remember last command, will retry after cooldown
            cd.pendingPath  = oscPath;
            cd.pendingValue = signedValue;
            return;
        }
        addToBundle(oscPath, stopKey, signedValue);
    }

    function addToBundle(oscPath, stopKey, signedValue) {
        if (!pendingBundles[oscPath]) {
            pendingBundles[oscPath] = { values: {} };
            (function(p) {
                var task = new Task(function() { flushOSCBundle(p); });
                task.schedule(BUNDLE_WINDOW_MS);
                pendingBundles[p].task = task;
            })(oscPath);
        }
        // Last command wins within the bundle window
        pendingBundles[oscPath].values[stopKey] = signedValue;
    }

    function flushOSCBundle(oscPath) {
        var bundle = pendingBundles[oscPath];
        if (!bundle) return;
        delete pendingBundles[oscPath];

        var keys = Object.keys(bundle.values);
        var vals = [];
        for (var i = 0; i < keys.length; i++) vals.push(bundle.values[keys[i]]);

        if (vals.length === 0) return;
        sendOSCDirect(oscPath, vals);

        // Start per-stop cooldown for every stop just sent
        var now = Date.now();
        for (var j = 0; j < keys.length; j++) {
            (function(sk) {
                // Cancel any existing cooldown task for this stop
                if (stopCooldowns[sk] && stopCooldowns[sk].task) {
                    stopCooldowns[sk].task.cancel();
                }
                stopCooldowns[sk] = {
                    endTime:      now + COOLDOWN_MS,
                    pendingPath:  null,
                    pendingValue: null,
                    task:         null
                };
                var t = new Task(function() { onCooldownExpired(sk); });
                t.schedule(COOLDOWN_MS);
                stopCooldowns[sk].task = t;
            })(keys[j]);
        }
    }

    function onCooldownExpired(stopKey) {
        var cd = stopCooldowns[stopKey];
        if (!cd) return;
        var pendingPath  = cd.pendingPath;
        var pendingValue = cd.pendingValue;
        delete stopCooldowns[stopKey];
        // If a command arrived during the cooldown, submit it now
        if (pendingPath !== null && pendingValue !== null) {
            addToBundle(pendingPath, stopKey, pendingValue);
        }
    }

    function cancelOSCBundle(oscPath) {
        // Kill pending bundle
        if (pendingBundles[oscPath]) {
            if (pendingBundles[oscPath].task) pendingBundles[oscPath].task.cancel();
            delete pendingBundles[oscPath];
        }
        // Clear any pending retry commands for stops on this path
        Object.keys(stopCooldowns).forEach(function(sk) {
            if (stopCooldowns[sk].pendingPath === oscPath) {
                stopCooldowns[sk].pendingPath  = null;
                stopCooldowns[sk].pendingValue = null;
                // Leave the cooldown timer running — it will expire cleanly and send nothing
            }
        });
        sendOSCDirect(oscPath, [0]);
    }

    function cancelAllBundlesForBase(basePath) {
        Object.keys(pendingBundles).forEach(function(path) {
            if (path.indexOf(basePath) === 0) {
                if (pendingBundles[path].task) pendingBundles[path].task.cancel();
                delete pendingBundles[path];
            }
        });
        Object.keys(stopCooldowns).forEach(function(sk) {
            var cd = stopCooldowns[sk];
            if (cd.pendingPath && cd.pendingPath.indexOf(basePath) === 0) {
                cd.pendingPath  = null;
                cd.pendingValue = null;
            }
        });
    }

    function clearAllOSCBundles() {
        Object.keys(pendingBundles).forEach(function(path) {
            if (pendingBundles[path].task) pendingBundles[path].task.cancel();
        });
        pendingBundles = {};
        Object.keys(stopCooldowns).forEach(function(sk) {
            if (stopCooldowns[sk].task) stopCooldowns[sk].task.cancel();
        });
        stopCooldowns = {};
    }

    function sendOSCDirect(oscPath, vals) {
        common.log(common.LOG_LEVEL.INFO, "OSC → " + oscPath + " " + vals.join(" "));
        try {
            outlet.apply(null, [0, oscPath].concat(vals));
        } catch (e) {
            post("OSC outlet error: " + e + "\n");
        }
    }

    // ================================================================================================
    // CONTEXT UTILITIES
    // ================================================================================================
    
    function formatContext(context) {
        if (!context) return '';
        
        var parts = [];
        if (context.manual !== null && context.manual !== undefined) {
            parts.push('M' + context.manual);
        }
        if (context.layer !== null && context.layer !== undefined) {
            parts.push('L' + context.layer);
        }
        if (context.divisionID !== null && context.divisionID !== undefined) {
            parts.push('D' + context.divisionID);
        }
        
        return parts.length > 0 ? ' [' + parts.join('/') + ']' : '';
    }
    
    function createSinuaCommand(context, action, ID, state) {
        if (!context) return null;
        
        var commandType; 
        var path = getSinuaPath(context); 

        switch(action) {
            case "panic": {commandType = "V " + (ID !== undefined && ID !== null ? ID : 0)};
            break;
            case "cancel": {commandType =  "S 0"};
            break;
            case "stop": {commandType =  "S "+(((state*2)-1)*ID)}; 
            break; 
            case "control": {commandType = "C "+state}; // TODO
            break; 
            case "switch": {commandType = "T "+state}; // TODO
            break; 
            default: {"foo"} 
        };
        
        
        return path + '/' + commandType;
    }

    function getSinuaPath(context){
        var path  = '';

        if (context.manual !== null && context.manual !== undefined) {
            path += '/M' + context.manual;
            
            if (context.layer !== null && context.layer !== undefined) {
                path += '/L' + context.layer;
            } 
        } else if (context.divisionID !== null && context.divisionID !== undefined) {
            path += '/D' + context.divisionID;
        }

        return path;

    }
    
    // ================================================================================================
    // STATE MANAGEMENT FUNCTIONS
    // ================================================================================================
  
    function executeCommand(action, id, value, context) {
        switch (action) {
            case 'stop':
                return setStopState(id, value, false, context);
                
            case 'tremulant':
                return setTremulantState(id, value.active, value.speed, context);
                
            case 'controller':
                return setControllerState(id, value, context);
                
            case 'layerdiv': {
                // DIV button in a layer bpatcher — sends /Mx/Lx/D ±divID
                var divID = Number(id);
                if (!isNaN(divID) && divID !== 0) {
                    var divOscPath = getSinuaPath(context) + "/D";
                    scheduleOSC(divOscPath, String(id), value ? divID : -divID);
                }
                return true;
            }

            case 'cancel': {
                // Update DataLayer state silently (no individual stop commands)
                clearStopsInContext(context, true);

                if (context && context.divisionsAll) {
                    // Section-level division cancel: find all division IDs with pending bundles
                    // or active stops, send /D<x>/S 0 for each.
                    var divsToClear = {};
                    Object.keys(pendingBundles).forEach(function(path) {
                        var m = path.match(/^\/D(\d+)\/S$/);
                        if (m) divsToClear[m[1]] = true;
                    });
                    Object.keys(organState.stops).forEach(function(sid) {
                        var s = organState.stops[sid];
                        if (s && !s.movable && s.state && s.divisionID) {
                            divsToClear[s.divisionID] = true;
                        }
                    });
                    Object.keys(divsToClear).forEach(function(dKey) {
                        cancelOSCBundle("/D" + dKey + "/S");
                    });
                } else {
                    var basePath = getSinuaPath(context);
                    // Cancel stops (/S 0)
                    cancelOSCBundle(basePath + "/S");
                    // For manual context: also cancel layer-div assignments (/D 0)
                    if (context && context.manual !== null && context.manual !== undefined) {
                        cancelOSCBundle(basePath + "/D");
                    }
                }
                return true;
            }

            case 'panic': {
                // /Mx/Lx/V 0. 0 1 2 … 127  — all notes off at velocity 0 for this context
                var panicBase = getSinuaPath(context);
                cancelAllBundlesForBase(panicBase);
                var panicArgs = [0.0];
                for (var pn = 0; pn <= 127; pn++) panicArgs.push(pn);
                sendOSCDirect(panicBase + "/V", panicArgs);
                return true;
            }

            case 'reset': {
                // RST button: /panic — clears everything on the console
                clearAllOSCBundles();
                initializeState();
                sendOSCDirect("/panic", []);
                return true;
            }
                
            default:
                common.log(common.LOG_LEVEL.ERROR, "Unknown command: " + action);
                return false;
        }
    }

    function initializeState() {
        organState.stops = {};
        organState.tremulants = {};
        organState.controllers = {};
        organState.divisions = {};
        organState.presets.current = null;
        organState.presets.loading = false;
        organState._meta.lastChanged = Date.now();
        organState._meta.changeCount = 0;
        
        common.log(common.LOG_LEVEL.INFO, "State initialized");
    }
    
    function getOrganState() {
        return organState;
    }
    
    function getStopState(stopID) {
        return organState.stops[stopID] || null;
    }
    
    function setStopState(stopID, state, skipQueue, context) {
        if (!stopID) {
            common.log(common.LOG_LEVEL.WARN, "setStopState(): Invalid stopID");
            return false;
        }

        try {
            var prevState = organState.stops[stopID];

            if (!organState.stops[stopID]) {
                organState.stops[stopID] = { state: false, divisionID: null, movable: false };
            }

            organState.stops[stopID].state = Boolean(state);

            recordStateChange('stop', stopID, prevState, organState.stops[stopID]);

            if (!skipQueue) {
                // Build SINUA path and schedule in bundler
                var oscPath = getSinuaPath(context) + "/S";
                var numID = Number(stopID);
                if (!isNaN(numID) && numID !== 0) {
                    scheduleOSC(oscPath, String(stopID), state ? numID : -numID);
                } else {
                    common.log(common.LOG_LEVEL.WARN,
                        "setStopState: non-numeric stopID, skipping OSC: " + stopID);
                }
            }

            notifyStateChange('stop', stopID, state, context);
            
            var contextInfo = formatContext(context);
            common.log(common.LOG_LEVEL.VERBOSE, "Stop " + stopID + " set to " + state + contextInfo);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "setStopState(): " + error.message);
            return false;
        }
    }
    
    function setTremulantState(tremulantID, active, speed, context) {
        if (!tremulantID) {
            common.log(common.LOG_LEVEL.WARN, "setTremulantState(): Invalid tremulantID");
            return false;
        }
        
        try {
            var prevState = organState.tremulants[tremulantID];
            
            if (!organState.tremulants[tremulantID]) {
                organState.tremulants[tremulantID] = { active: false, speed: 64, divisionID: null };
            }
            
            organState.tremulants[tremulantID].active = Boolean(active);
            if (speed !== null && speed !== undefined) {
                organState.tremulants[tremulantID].speed = Math.max(0, Math.min(127, speed));
            }
            
            recordStateChange('tremulant', tremulantID, prevState, organState.tremulants[tremulantID]);
            
            if (organState.settings.autoSend) {
                queueOrganCommand('tremulant', tremulantID, {
                    active: organState.tremulants[tremulantID].active,
                    speed: organState.tremulants[tremulantID].speed
                }, 2, {
                    context: context,
                    sinuaCommand: createSinuaCommand(context, 'tremulant')
                });
            }
            
            notifyStateChange('tremulant', tremulantID, organState.tremulants[tremulantID], context);
            
            var contextInfo = formatContext(context);
            common.log(common.LOG_LEVEL.VERBOSE, "Tremulant " + tremulantID + " set to active:" + active + ", speed:" + speed + contextInfo);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "setTremulantState(): " + error.message);
            return false;
        }
    }
    
    function setControllerState(controllerID, value, context) {
        if (!controllerID || typeof value !== 'number') {
            common.log(common.LOG_LEVEL.WARN, "setControllerState(): Invalid parameters");
            return false;
        }
        
        try {
            var prevState = organState.controllers[controllerID];
            
            if (!organState.controllers[controllerID]) {
                organState.controllers[controllerID] = { value: 0, type: 'volume' };
            }
            
            organState.controllers[controllerID].value = Math.max(0, Math.min(127, value));
            
            recordStateChange('controller', controllerID, prevState, organState.controllers[controllerID]);
            
            if (organState.settings.autoSend) {
                queueOrganCommand('controller', controllerID, value, 3, {
                    context: context,
                    sinuaCommand: createSinuaCommand(context, 'controller')
                });
            }
            
            notifyStateChange('controller', controllerID, value, context);
            
            var contextInfo = formatContext(context);
            common.log(common.LOG_LEVEL.VERBOSE, "Controller " + controllerID + " set to " + value + contextInfo);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "setControllerState(): " + error.message);
            return false;
        }
    }
    
    // ================================================================================================
    // BATCH OPERATIONS
    // ================================================================================================
    
    function setDivisionState(divisionID, stopStates, context) {
        if (!divisionID || !stopStates || typeof stopStates !== 'object') {
            common.log(common.LOG_LEVEL.WARN, "setDivisionState(): Invalid parameters");
            return false;
        }
        
        try {
            var batchCommands = [];
            var divisionContext = context || { divisionID: divisionID, type: 'division' };
            
            Object.keys(stopStates).forEach(function(stopID) {
                if (organState.stops[stopID] && organState.stops[stopID].divisionID === divisionID) {
                    setStopState(stopID, stopStates[stopID], true, divisionContext);
                    batchCommands.push({ 
                        type: 'stop', 
                        id: stopID, 
                        value: stopStates[stopID],
                        context: divisionContext
                    });
                }
            });
            
            if (organState.settings.autoSend && batchCommands.length > 0) {
                queueOrganCommand('division_batch', divisionID, batchCommands, 1, {
                    context: divisionContext,
                    sinuaCommand: createSinuaCommand(divisionContext, 'batch')
                });
            }
            
            var contextInfo = formatContext(divisionContext);
            common.log(common.LOG_LEVEL.INFO, "Division " + divisionID + " batch update: " + batchCommands.length + " stops" + contextInfo);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "setDivisionState(): " + error.message);
            return false;
        }
    }
    
    function setPresetState(presetName, presetData, context) {
        if (!presetName || !presetData) {
            common.log(common.LOG_LEVEL.WARN, "setPresetState(): Invalid parameters");
            return false;
        }
        
        try {
            organState.presets.loading = true;
            organState.presets.current = presetName;
            
            var stateDiff = calculatePresetDiff(presetData);
            var presetContext = context || { type: 'preset', presetName: presetName };
            
            if (presetData.stops) {
                presetData.stops.forEach(function(stopID) {
                    setStopState(stopID, true, true, presetContext);
                });
            }
            
            if (presetData.tremulants) {
                Object.keys(presetData.tremulants).forEach(function(tremID) {
                    var tremData = presetData.tremulants[tremID];
                    setTremulantState(tremID, tremData.active || tremData, tremData.speed, presetContext);
                });
            }
            
            if (presetData.controllers) {
                Object.keys(presetData.controllers).forEach(function(ctrlID) {
                    setControllerState(ctrlID, presetData.controllers[ctrlID], presetContext);
                });
            }
            
            if (organState.settings.autoSend) {
                queueOrganCommand('preset', presetName, stateDiff, 0, {
                    context: presetContext,
                    sinuaCommand: createSinuaCommand(presetContext, 'preset')
                });
            }
            
            organState.presets.loading = false;
            
            var contextInfo = formatContext(presetContext);
            common.log(common.LOG_LEVEL.INFO, "Preset \"" + presetName + "\" applied" + contextInfo);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "setPresetState(): " + error.message);
            organState.presets.loading = false;
            return false;
        }
    }
    
    // ================================================================================================
    // HIERARCHICAL COMMAND SYSTEM
    // ================================================================================================
    
    function queueLayerCommand(action, manualID, layerID, context) {
        var layerContext = context || {
            manual: manualID,
            layer: layerID,
            type: 'layer'
        };
        
        var sinuaCommand = createSinuaCommand(layerContext, action);
        
        queueOrganCommand('layer_' + action, manualID + '_' + layerID, 0, 1, {
            context: layerContext,
            sinuaCommand: sinuaCommand
        });
        
        var contextInfo = formatContext(layerContext);
        common.log(common.LOG_LEVEL.INFO, "Layer " + action + " queued" + contextInfo + " [" + sinuaCommand + "]");
        return true;
    }
    
    function queueManualCommand(action, manualID, context) {
        var manualContext = context || {
            manual: manualID,
            type: 'manual'
        };
        
        var sinuaCommand = createSinuaCommand(manualContext, action);
        
        queueOrganCommand('manual_' + action, manualID, 0, 1, {
            context: manualContext,
            sinuaCommand: sinuaCommand
        });
        
        var contextInfo = formatContext(manualContext);
        common.log(common.LOG_LEVEL.INFO, "Manual " + action + " queued" + contextInfo + " [" + sinuaCommand + "]");
        return true;
    }
    
    function queueDivisionCommand(action, divisionID, context) {
        var divisionContext = context || {
            divisionID: divisionID,
            type: 'division'
        };
        
        var sinuaCommand = createSinuaCommand(divisionContext, action);
        
        queueOrganCommand('division_' + action, divisionID, 0, 1, {
            context: divisionContext,
            sinuaCommand: sinuaCommand
        });
        
        var contextInfo = formatContext(divisionContext);
        common.log(common.LOG_LEVEL.INFO, "Division " + action + " queued" + contextInfo + " [" + sinuaCommand + "]");
        return true;
    }
    
    function queueResetCommand(context) {
        var organContext = context || {
            type: 'organ'
        };
        
        var sinuaCommand = '/panic';
        
        queueOrganCommand('reset', 'organ', 1, 0, {
            context: organContext,
            sinuaCommand: sinuaCommand
        });
        
        common.log(common.LOG_LEVEL.INFO, "Organ reset queued [" + sinuaCommand + "]");
        return true;
    }
    
    // ================================================================================================
    // STATE PERSISTENCE & HISTORY
    // ================================================================================================
    
    function saveCurrentState() {
        try {
            var stateSnapshot = JSON.parse(JSON.stringify(organState));
            stateHistory.push({
                timestamp: Date.now(),
                state: stateSnapshot,
                description: "Manual save"
            });
            
            if (stateHistory.length > 100) {
                stateHistory.shift();
            }
            
            common.log(common.LOG_LEVEL.VERBOSE, "Current state saved to history");
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "saveCurrentState(): " + error.message);
            return false;
        }
    }
    
    function restoreState(stateSnapshot) {
        if (!stateSnapshot) {
            common.log(common.LOG_LEVEL.WARN, "restoreState(): No state snapshot provided");
            return false;
        }
        
        try {
            saveCurrentState();
            
            var keysToRestore = ['info', 'stops', 'tremulants', 'controllers', 'divisions', 'presets', 'settings'];
            keysToRestore.forEach(function(key) {
                if (stateSnapshot[key]) {
                    organState[key] = JSON.parse(JSON.stringify(stateSnapshot[key]));
                }
            });
            
            organState._meta.lastChanged = Date.now();
            organState._meta.changeCount++;
            
            notifyStateChange('state_restored', null, stateSnapshot);
            
            common.log(common.LOG_LEVEL.INFO, "State restored from snapshot");
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "restoreState(): " + error.message);
            return false;
        }
    }
    
    function undoLastChange() {
        if (stateHistory.length === 0) {
            common.log(common.LOG_LEVEL.WARN, "No state history available for undo");
            return false;
        }
        
        try {
            var previousState = stateHistory.pop();
            restoreState(previousState.state);
            
            common.log(common.LOG_LEVEL.INFO, "Undone to: " + previousState.description);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "undoLastChange(): " + error.message);
            return false;
        }
    }
    
    // ================================================================================================
    // STATE LISTENERS & NOTIFICATIONS
    // ================================================================================================
    
    function addStateListener(callback, types) {
        if (typeof callback !== 'function') {
            common.log(common.LOG_LEVEL.WARN, "addStateListener(): Callback must be a function");
            return false;
        }
        
        types = types || ['stop', 'tremulant', 'controller', 'preset'];
        
        var listener = {
            id: Date.now() + Math.random(),
            callback: callback,
            types: types
        };
        
        organState._meta.listeners.push(listener);
        
        common.log(common.LOG_LEVEL.VERBOSE, "State listener added for types: " + listener.types.join(', '));
        return listener.id;
    }
    
    function removeStateListener(listenerID) {
        for (var i = 0; i < organState._meta.listeners.length; i++) {
            if (organState._meta.listeners[i].id === listenerID) {
                organState._meta.listeners.splice(i, 1);
                common.log(common.LOG_LEVEL.VERBOSE, "State listener " + listenerID + " removed");
                return true;
            }
        }
        return false;
    }
    
    function notifyStateChange(type, id, value, context) {
        organState._meta.listeners.forEach(function(listener) {
            if (listener.types.indexOf(type) !== -1) {
                try {
                    // Pass context as fifth parameter
                    listener.callback(type, id, value, organState, context);
                } catch (error) {
                    common.log(common.LOG_LEVEL.ERROR, "State listener error: " + error.message);
                }
            }
        });
    }
    
    // ================================================================================================
    // COMMAND QUEUE MANAGEMENT
    // ================================================================================================
    
    function queueOrganCommand(type, id, value, priority, metadata) {
        priority = priority || 0;
        metadata = metadata || {};
        
        var command = {
            type: type,
            id: id,
            value: value,
            timestamp: Date.now(),
            priority: priority,
            attempts: 0,
            context: metadata.context || null,
            sinuaCommand: metadata.sinuaCommand || null,
            metadata: metadata
        };
        
        var insertIndex = commandQueue.length;
        for (var i = 0; i < commandQueue.length; i++) {
            if (commandQueue[i].priority < priority) {
                insertIndex = i;
                break;
            }
        }

        // TODO working here ! 
        common.log(common.LOG_LEVEL.DEBUG, "in queue")
        
        commandQueue.splice(insertIndex, 0, command);
        
        var contextInfo = command.context ? formatContext(command.context) : '';
        var sinuaInfo = command.sinuaCommand ? " [" + command.sinuaCommand + "]" : '';
        
        common.log(common.LOG_LEVEL.VERBOSE, 
            "Command queued: " + type + "(" + id + ") = " + JSON.stringify(value) + contextInfo + sinuaInfo);
    }
    
    function getCommandQueue() {
        return commandQueue;
    }
    
    function processCommandQueue() {
        if (commandQueue.length === 0) {
            return null;
        }
        
        var command = commandQueue.shift();
        command.attempts++;
        
        var contextInfo = command.context ? formatContext(command.context) : '';
        var sinuaInfo = command.sinuaCommand ? " [" + command.sinuaCommand + "]" : '';
        
        common.log(common.LOG_LEVEL.VERBOSE, 
            "Processing command: " + command.type + "(" + command.id + ")" + contextInfo + sinuaInfo);
        
        return command;
    }
    
    function requeueCommand(command, delay) {
        delay = delay || 1000;
        
        if (command.attempts < 3) {
            setTimeout(function() {
                queueOrganCommand(command.type, command.id, command.value, command.priority, command.metadata);
            }, delay);
            
            var contextInfo = command.context ? formatContext(command.context) : '';
            common.log(common.LOG_LEVEL.WARN, "Command requeued (attempt " + command.attempts + 1 + "): " + command.type + "(" + command.id + ")" + contextInfo);
        } else {
            var contextInfo = command.context ? formatContext(command.context) : '';
            common.log(common.LOG_LEVEL.ERROR, "Command failed after 3 attempts: " + command.type + "(" + command.id + ")" + contextInfo);
        }
    }
    
    function clearCommandQueue() {
        var count = commandQueue.length;
        commandQueue = [];
        common.log(common.LOG_LEVEL.INFO, "Command queue cleared (" + count + " commands removed)");
    }
    
    // ================================================================================================
    // INTERNAL HELPER FUNCTIONS
    // ================================================================================================
    
    function recordStateChange(type, id, prevState, newState) {
        organState._meta.lastChanged = Date.now();
        organState._meta.changeCount++;
        
        if (JSON.stringify(prevState) !== JSON.stringify(newState)) {
            common.log(common.LOG_LEVEL.DEBUG, "State change recorded: " + type + "(" + id + ")");
        }
    }
    
    function calculatePresetDiff(presetData) {
        var diff = {
            stopsToEnable: [],
            stopsToDisable: [],
            tremulantChanges: {},
            controllerChanges: {}
        };
        
        var currentStops = Object.keys(organState.stops).filter(function(id) {
            return organState.stops[id].state;
        });
        var presetStops = presetData.stops || [];
        
        diff.stopsToEnable = presetStops.filter(function(stopID) {
            return currentStops.indexOf(String(stopID)) === -1;
        });
        diff.stopsToDisable = currentStops.filter(function(stopID) {
            return presetStops.indexOf(parseInt(stopID)) === -1;
        });
        
        if (presetData.tremulants) {
            Object.keys(presetData.tremulants).forEach(function(tremID) {
                var current = organState.tremulants[tremID];
                var preset = presetData.tremulants[tremID];
                
                if (!current || current.active !== preset.active || current.speed !== preset.speed) {
                    diff.tremulantChanges[tremID] = preset;
                }
            });
        }
        
        if (presetData.controllers) {
            Object.keys(presetData.controllers).forEach(function(ctrlID) {
                var current = organState.controllers[ctrlID];
                var preset = presetData.controllers[ctrlID];
                
                if (!current || current.value !== preset) {
                    diff.controllerChanges[ctrlID] = preset;
                }
            });
        }
        
        return diff;
    }
    
    // ================================================================================================
    // ORGAN DATA INTEGRATION
    // ================================================================================================
    
    function populateStateFromOrganData(organData) {
        if (!organData) {
            common.log(common.LOG_LEVEL.ERROR, "populateStateFromOrganData(): No organ data provided");
            return false;
        }
        
        try {
            initializeState();
            
            organState.info.type = organData.type || "UNKNOWN";
            organState.info.name = organData.name || "Unknown Organ";
            organState.info.loaded = true;
            
            if (organData.stops && organData.stops.fixed) {
                organData.stops.fixed.forEach(function(stop) {
                    organState.stops[stop.stopID] = {
                        state: false,
                        divisionID: stop.divisionID,
                        movable: false,
                        name: stop.name
                    };
                });
            }
            
            if (organData.stops && organData.stops.movable) {
                organData.stops.movable.forEach(function(stop) {
                    organState.stops[stop.stopID] = {
                        state: false,
                        divisionID: stop.divisionID,
                        movable: true,
                        name: stop.name
                    };
                });
            }
            
            if (organData.tremulants) {
                organData.tremulants.forEach(function(tremulant, index) {
                    organState.tremulants[index + 1] = {
                        active: false,
                        speed: 64,
                        divisionID: tremulant.divisionID || null,
                        name: tremulant.divisionName || "Tremulant " + (index + 1)
                    };
                });
            }
            
            if (organData.controllers) {
                organData.controllers.forEach(function(controller, index) {
                    organState.controllers[index + 1] = {
                        value: 0,
                        type: 'volume',
                        name: controller.name || "Controller " + (index + 1)
                    };
                });
            }
            
            if (organData.divisions) {
                organData.divisions.forEach(function(division) {
                    organState.divisions[division.divisionID] = {
                        name: division.name,
                        stopCount: division.stops ? division.stops.length : 0,
                        active: false
                    };
                });
            }
            
            common.log(common.LOG_LEVEL.INFO, "State populated from organ data: " + Object.keys(organState.stops).length + " stops, " + Object.keys(organState.divisions).length + " divisions");
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "populateStateFromOrganData(): " + error.message);
            return false;
        }
    }
    
    // ================================================================================================
    // SETTINGS MANAGEMENT
    // ================================================================================================
    
    function getSettings() {
        return organState.settings;
    }
    
    function setSetting(key, value) {
        if (organState.settings.hasOwnProperty(key)) {
            var oldValue = organState.settings[key];
            organState.settings[key] = value;
            
            common.log(common.LOG_LEVEL.INFO, "Setting " + key + " changed from " + oldValue + " to " + value);
            notifyStateChange('setting', key, value);
            return true;
        } else {
            common.log(common.LOG_LEVEL.WARN, "setSetting(): Unknown setting key: " + key);
            return false;
        }
    }
    
    function setIncludeTransmissions(include) {
        return setSetting('includeTransmissions', Boolean(include));
    }
    
    function getIncludeTransmissions() {
        return organState.settings.includeTransmissions;
    }
    
    function toggleTransmissions() {
        return setIncludeTransmissions(!organState.settings.includeTransmissions);
    }
    
    // ================================================================================================
    // GETTER FUNCTIONS
    // ================================================================================================
    
    function getTremulantState(tremulantID) {
        return organState.tremulants[tremulantID] || null;
    }
    
    function getControllerState(controllerID) {
        return organState.controllers[controllerID] || null;
    }
    
    function getDivisionState(divisionID) {
        if (!organState.divisions[divisionID]) return null;
        
        var divisionStops = {};
        Object.keys(organState.stops).forEach(function(stopID) {
            if (organState.stops[stopID].divisionID === divisionID) {
                divisionStops[stopID] = organState.stops[stopID].state;
            }
        });
        return divisionStops;
    }
    
    // ================================================================================================
    // DEBUG AND MONITORING FUNCTIONS
    // ================================================================================================
    
    function displayCurrentState() {
        var state = organState;
        
        common.log(common.LOG_LEVEL.INFO, "=== CURRENT ORGAN STATE ===");
        common.log(common.LOG_LEVEL.INFO, "Organ: " + state.info.name + " (" + state.info.type + ")");
        common.log(common.LOG_LEVEL.INFO, "Loaded: " + state.info.loaded);
        
        var activeStops = Object.keys(state.stops).filter(function(id) {
            return state.stops[id].state;
        });
        common.log(common.LOG_LEVEL.INFO, "Active stops: " + activeStops.length + "/" + Object.keys(state.stops).length);
        
        var activeTremulants = Object.keys(state.tremulants).filter(function(id) {
            return state.tremulants[id].active;
        });
        common.log(common.LOG_LEVEL.INFO, "Active tremulants: " + activeTremulants.length + "/" + Object.keys(state.tremulants).length);
        
        common.log(common.LOG_LEVEL.INFO, "Controllers: " + Object.keys(state.controllers).length);
        common.log(common.LOG_LEVEL.INFO, "Divisions: " + Object.keys(state.divisions).length);
        common.log(common.LOG_LEVEL.INFO, "Current preset: " + state.presets.current || 'None');
        common.log(common.LOG_LEVEL.INFO, "Include transmissions: " + state.settings.includeTransmissions);
        
        // Enhanced command queue display with context
        if (commandQueue.length > 0) {
            common.log(common.LOG_LEVEL.INFO, "Command queue (" + commandQueue.length + "):");
            commandQueue.slice(0, 5).forEach(function(cmd, index) {
                var contextInfo = cmd.context ? formatContext(cmd.context) : '';
                var sinuaInfo = cmd.sinuaCommand ? " [" + cmd.sinuaCommand + "]" : '';
                common.log(common.LOG_LEVEL.INFO, 
                    "  " + (index + 1) + ". " + cmd.type + "(" + cmd.id + ")" + contextInfo + sinuaInfo);
            });
            if (commandQueue.length > 5) {
                common.log(common.LOG_LEVEL.INFO, "  ... and " + commandQueue.length - 5 + " more");
            }
        } else {
            common.log(common.LOG_LEVEL.INFO, "Command queue: empty");
        }
        
        common.log(common.LOG_LEVEL.INFO, "State listeners: " + state._meta.listeners.length);
        common.log(common.LOG_LEVEL.INFO, "============================");
    }
    
    function getStateStatistics() {
        var stats = {
            stops: {
                total: Object.keys(organState.stops).length,
                active: Object.keys(organState.stops).filter(function(id) {
                    return organState.stops[id].state;
                }).length,
                movable: Object.keys(organState.stops).filter(function(id) {
                    return organState.stops[id].movable;
                }).length
            },
            tremulants: {
                total: Object.keys(organState.tremulants).length,
                active: Object.keys(organState.tremulants).filter(function(id) {
                    return organState.tremulants[id].active;
                }).length
            },
            controllers: {
                total: Object.keys(organState.controllers).length
            },
            divisions: {
                total: Object.keys(organState.divisions).length
            },
            commands: {
                queued: commandQueue.length,
                withContext: commandQueue.filter(function(cmd) {
                    return cmd.context !== null;
                }).length,
                withSinuaCommands: commandQueue.filter(function(cmd) {
                    return cmd.sinuaCommand !== null;
                }).length
            },
            meta: {
                changeCount: organState._meta.changeCount,
                historySize: stateHistory.length,
                listeners: organState._meta.listeners.length
            }
        };
        
        return stats;
    }
    
    function validateStateIntegrity() {
        var issues = [];
        
        Object.keys(organState.stops).forEach(function(stopID) {
            var stop = organState.stops[stopID];
            if (stop.divisionID && !organState.divisions[stop.divisionID]) {
                issues.push("Stop " + stopID + " references non-existent division " + stop.divisionID);
            }
        });
        
        Object.keys(organState.tremulants).forEach(function(tremID) {
            var trem = organState.tremulants[tremID];
            if (trem.divisionID && !organState.divisions[trem.divisionID]) {
                issues.push("Tremulant " + tremID + " references non-existent division " + trem.divisionID);
            }
        });
        
        // Validate command queue context integrity
        commandQueue.forEach(function(cmd, index) {
            if (cmd.context) {
                if (cmd.context.manual !== null && cmd.context.manual !== undefined && 
                    typeof cmd.context.manual !== 'number') {
                    issues.push("Command " + index + ": Invalid manual ID type");
                }
                if (cmd.context.layer !== null && cmd.context.layer !== undefined && 
                    typeof cmd.context.layer !== 'number') {
                    issues.push("Command " + index + ": Invalid layer ID type");
                }
                if (cmd.context.divisionID !== null && cmd.context.divisionID !== undefined && 
                    !organState.divisions[cmd.context.divisionID]) {
                    issues.push("Command " + index + ": References non-existent division " + cmd.context.divisionID);
                }
            }
        });
        
        if (issues.length === 0) {
            common.log(common.LOG_LEVEL.INFO, "State integrity check passed");
            return true;
        } else {
            common.log(common.LOG_LEVEL.WARN, "State integrity issues found: " + issues.join(', '));
            return false;
        }
    }
    
    function displayCommandQueue() {
        common.log(common.LOG_LEVEL.INFO, "=== COMMAND QUEUE ===");
        
        if (commandQueue.length === 0) {
            common.log(common.LOG_LEVEL.INFO, "Queue is empty");
        } else {
            commandQueue.forEach(function(cmd, index) {
                var contextInfo = cmd.context ? formatContext(cmd.context) : '';
                var sinuaInfo = cmd.sinuaCommand ? " [" + cmd.sinuaCommand + "]" : '';
                var ageMs = Date.now() - cmd.timestamp;
                var age = ageMs < 1000 ? ageMs + "ms" : (ageMs/1000).toFixed(1) + "s";
                
                common.log(common.LOG_LEVEL.INFO, 
                    index + 1 + ". " + cmd.type + "(" + cmd.id + ") = " + JSON.stringify(cmd.value) + contextInfo + sinuaInfo + " (" + age + " ago, attempt " + cmd.attempts + ")");
            });
        }
        
        common.log(common.LOG_LEVEL.INFO, "=====================");
    }
    
    function getContextualStops(context) {
        if (!context) return [];
        
        var relevantStops = [];
        
        Object.keys(organState.stops).forEach(function(stopID) {
            var stop = organState.stops[stopID];
            var isRelevant = false;
            
            if (context.divisionID && stop.divisionID === context.divisionID) {
                isRelevant = true;
            } else if (context.manual && context.layer && stop.movable) {
                isRelevant = true;
            } else if (context.manual && !context.layer && stop.movable) {
                isRelevant = true;
            } else if (!context.manual && !context.layer && !context.divisionID) {
                isRelevant = true; // Organ-wide context
            }
            
            if (isRelevant) {
                relevantStops.push({
                    stopID: parseInt(stopID),
                    name: stop.name,
                    state: stop.state,
                    divisionID: stop.divisionID,
                    movable: stop.movable
                });
            }
        });
        
        return relevantStops;
    }
    
    // ================================================================================================
    // CONTEXT-AWARE BULK OPERATIONS
    // ================================================================================================
    
    function clearStopsInContext(context, skipQueue) {
        if (!context) {
            common.log(common.LOG_LEVEL.WARN, "clearStopsInContext(): No context provided");
            return false;
        }
        
        var clearedStops = [];
        var contextualStops = getContextualStops(context);
        
        contextualStops.forEach(function(stop) {
            if (stop.state) {
                setStopState(stop.stopID, false, skipQueue, context);
                clearedStops.push(stop.stopID);
            }
        });
        
        var contextInfo = formatContext(context);
        common.log(common.LOG_LEVEL.INFO, 
            "Cleared " + clearedStops.length + " stops in context" + contextInfo + ": [" + clearedStops.join(', ') + "]");
        
        return clearedStops;
    }
    
    function activateStopsInContext(stopIDs, context, skipQueue) {
        if (!Array.isArray(stopIDs) || !context) {
            common.log(common.LOG_LEVEL.WARN, "activateStopsInContext(): Invalid parameters");
            return false;
        }
        
        var activatedStops = [];
        
        stopIDs.forEach(function(stopID) {
            if (organState.stops[stopID]) {
                setStopState(stopID, true, skipQueue, context);
                activatedStops.push(stopID);
            }
        });
        
        var contextInfo = formatContext(context);
        common.log(common.LOG_LEVEL.INFO, 
            "Activated " + activatedStops.length + " stops in context" + contextInfo + ": [" + activatedStops.join(', ') + "]");
        
        return activatedStops;
    }
    
    function getActiveStopsInContext(context) {
        var contextualStops = getContextualStops(context);
        return contextualStops.filter(function(stop) {
            return stop.state;
        });
    }
    
    // ================================================================================================
    // CONTEXT COMMAND UTILITIES
    // ================================================================================================
    
    function executeContextAction(action, context) {
        if (!context || !action) {
            common.log(common.LOG_LEVEL.WARN, "executeContextAction(): Invalid parameters");
            return false;
        }
        
        var contextInfo = formatContext(context);
        
        switch (action) {
            case 'panic':
            case 'cancel':
                clearStopsInContext(context, false);
                queueOrganCommand(action, 'context', 0, action === 'panic' ? 0 : 1, {
                    context: context,
                    sinuaCommand: createSinuaCommand(context, action)
                });
                common.log(common.LOG_LEVEL.INFO, action.toUpperCase() + " executed for context" + contextInfo);
                break;
                
            case 'solo':
                // Clear all stops first, then activate only contextual ones
                var currentActive = getActiveStopsInContext(context);
                clearStopsInContext({ type: 'organ' }, true); // Clear organ-wide
                currentActive.forEach(function(stop) {
                    setStopState(stop.stopID, true, false, context);
                });
                common.log(common.LOG_LEVEL.INFO, "SOLO executed for context" + contextInfo);
                break;
                
            default:
                common.log(common.LOG_LEVEL.WARN, "Unknown context action: " + action);
                return false;
        }
        
        return true;
    }
    
    // ================================================================================================
    // PUBLIC API
    // ================================================================================================
    
    return {
        // State management
        initializeState: initializeState,
        getOrganState: getOrganState,
        getStopState: getStopState,
        executeCommand: executeCommand,
        setStopState: setStopState,
        setTremulantState: setTremulantState,
        setControllerState: setControllerState,
        getTremulantState: getTremulantState,
        getControllerState: getControllerState,
        getDivisionState: getDivisionState,
        
        // Batch operations
        setDivisionState: setDivisionState,
        setPresetState: setPresetState,
        
        // State persistence
        saveCurrentState: saveCurrentState,
        restoreState: restoreState,
        undoLastChange: undoLastChange,
        
        // State listeners
        addStateListener: addStateListener,
        removeStateListener: removeStateListener,
        
        // Command queue
        queueOrganCommand: queueOrganCommand,
        getCommandQueue: getCommandQueue,
        processCommandQueue: processCommandQueue,
        requeueCommand: requeueCommand,
        clearCommandQueue: clearCommandQueue,
        
        // Hierarchical context commands
        queueLayerCommand: queueLayerCommand,
        queueManualCommand: queueManualCommand,
        queueDivisionCommand: queueDivisionCommand,
        queueResetCommand: queueResetCommand,
        
        // Context utilities
        formatContext: formatContext,
        createSinuaCommand: createSinuaCommand,
        getContextualStops: getContextualStops,
        clearStopsInContext: clearStopsInContext,
        activateStopsInContext: activateStopsInContext,
        getActiveStopsInContext: getActiveStopsInContext,
        executeContextAction: executeContextAction,
        
        // Organ data integration
        populateStateFromOrganData: populateStateFromOrganData,
        
        // Settings
        getSettings: getSettings,
        setSetting: setSetting,
        setIncludeTransmissions: setIncludeTransmissions,
        getIncludeTransmissions: getIncludeTransmissions,
        toggleTransmissions: toggleTransmissions,
        
        // Debug and monitoring
        displayCurrentState: displayCurrentState,
        displayCommandQueue: displayCommandQueue,
        getStateStatistics: getStateStatistics,
        validateStateIntegrity: validateStateIntegrity
    };
}

// ================================================================================================
// MODULE REGISTRATION
// ================================================================================================

if (typeof global !== 'undefined') {
    global.createDataLayerModule = createDataLayerModule;
}

post("organTool_DataLayer_ContextAware.js v01.01 - CANCEL consolidated, PANIC sweep, skipQueue fixed\n");