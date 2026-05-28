// organTool_ProtocolLayer.js - PROTOCOL COMMUNICATION LAYER
// 00.10 - Best Practice with Dependency Injection
// 05.07.2025
// Maciej Sledziecki 
// Protocol abstraction layer for SINUA (OSC) and MIDI communication

autowatch = 1;

// ================================================================================================
// PROTOCOL LAYER MODULE FACTORY - DEPENDS ON COMMON AND DATALAYER
// ================================================================================================

function createProtocolLayerModule(common, dataLayer) {
    if (!common || !dataLayer) {
        throw new Error("ProtocolLayer requires Common and DataLayer dependencies");
    }
    
    // Private module state
    var protocolConfig = {
        type: "UNKNOWN",  // "SINUA", "MIDI"
        connected: false,
        lastCommand: null,
        commandQueue: [],
        retryQueue: [],
        stats: {
            commandsSent: 0,
            commandsFailed: 0,
            lastActivity: null
        }
    };
    
    var connectionHandlers = {};
    var protocolImplementations = {};
    
    // ================================================================================================
    // PROTOCOL REGISTRATION SYSTEM
    // ================================================================================================
    
    function registerProtocol(protocolType, implementation) {
        if (!protocolType || !implementation) {
            common.log(common.LOG_LEVEL.ERROR, "Invalid protocol registration");
            return false;
        }
        
        // Validate implementation interface
        var requiredMethods = ['initialize', 'sendCommand', 'disconnect', 'isConnected'];
        for (var i = 0; i < requiredMethods.length; i++) {
            var method = requiredMethods[i];
            if (typeof implementation[method] !== 'function') {
                common.log(common.LOG_LEVEL.ERROR, "Protocol " + protocolType + " missing required method: " + method);
                return false;
            }
        }
        
        protocolImplementations[protocolType] = implementation;
        common.log(common.LOG_LEVEL.INFO, "Protocol registered: " + protocolType);
        return true;
    }
    
    function setActiveProtocol(protocolType, config) {
        if (!protocolImplementations[protocolType]) {
            common.log(common.LOG_LEVEL.ERROR, "Unknown protocol: " + protocolType);
            return false;
        }
        
        try {
            // Disconnect current protocol if active
            if (protocolConfig.type !== "UNKNOWN" && protocolImplementations[protocolConfig.type]) {
                protocolImplementations[protocolConfig.type].disconnect();
            }
            
            // Initialize new protocol
            var success = protocolImplementations[protocolType].initialize(config || {});
            if (success) {
                protocolConfig.type = protocolType;
                protocolConfig.connected = true;
                common.log(common.LOG_LEVEL.INFO, "Active protocol set to: " + protocolType);
            } else {
                common.log(common.LOG_LEVEL.ERROR, "Failed to initialize protocol: " + protocolType);
            }
            
            return success;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "Error setting active protocol: " + error.message);
            return false;
        }
    }
    
    // ================================================================================================
    // COMMAND QUEUE PROCESSING
    // ================================================================================================
    
    function processCommandQueue() {
        if (protocolConfig.commandQueue.length === 0) {
            return;
        }
        
        if (protocolConfig.type === "UNKNOWN" || !protocolConfig.connected) {
            common.log(common.LOG_LEVEL.WARN, "No active protocol for command processing");
            return;
        }
        
        var implementation = protocolImplementations[protocolConfig.type];
        if (!implementation) {
            common.log(common.LOG_LEVEL.ERROR, "Protocol implementation not found");
            return;
        }
        
        while (protocolConfig.commandQueue.length > 0) {
            var command = protocolConfig.commandQueue.shift();
            
            try {
                var success = implementation.sendCommand(command);
                if (success) {
                    protocolConfig.stats.commandsSent++;
                    protocolConfig.stats.lastActivity = Date.now();
                    protocolConfig.lastCommand = command;
                    
                    common.log(common.LOG_LEVEL.VERBOSE, "Command sent: " + command.type + "(" + command.id + ")");
                } else {
                    // Retry failed commands
                    command.attempts = (command.attempts || 0) + 1;
                    if (command.attempts < 3) {
                        protocolConfig.retryQueue.push(command);
                        common.log(common.LOG_LEVEL.WARN, "Command failed, queued for retry: " + command.type + "(" + command.id + ")");
                    } else {
                        protocolConfig.stats.commandsFailed++;
                        common.log(common.LOG_LEVEL.ERROR, "Command failed after 3 attempts: " + command.type + "(" + command.id + ")");
                    }
                }
                
            } catch (error) {
                protocolConfig.stats.commandsFailed++;
                common.log(common.LOG_LEVEL.ERROR, "Error processing command: " + error.message);
            }
        }
        
        // Process retry queue with delay
        if (protocolConfig.retryQueue.length > 0) {
            setTimeout(function() {
                protocolConfig.commandQueue = protocolConfig.commandQueue.concat(protocolConfig.retryQueue);
                protocolConfig.retryQueue = [];
                processCommandQueue();
            }, 1000);
        }
    }
    
    function queueCommand(command) {
        if (!command || !command.type) {
            common.log(common.LOG_LEVEL.ERROR, "Invalid command for queue");
            return false;
        }
        
        command.timestamp = Date.now();
        command.attempts = 0;
        
        // Handle priority queue insertion
        var priority = command.priority || 0;
        var insertIndex = protocolConfig.commandQueue.length;
        
        for (var i = 0; i < protocolConfig.commandQueue.length; i++) {
            if ((protocolConfig.commandQueue[i].priority || 0) < priority) {
                insertIndex = i;
                break;
            }
        }
        
        protocolConfig.commandQueue.splice(insertIndex, 0, command);
        
        common.log(common.LOG_LEVEL.VERBOSE, "Command queued: " + command.type + "(" + (command.id || 'N/A') + ")");
        
        // Process queue immediately if connected
        if (protocolConfig.connected) {
            processCommandQueue();
        }
        
        return true;
    }
    
    // ================================================================================================
    // SINUA PROTOCOL IMPLEMENTATION
    // ================================================================================================
    
    var SINUAProtocol = (function() {
        var oscSender = null;
        var config = {
            targetIP: "127.0.0.1",
            targetPort: 8000,
            localPort: 9000
        };
        
        return {
            initialize: function(protocolConfig) {
                try {
                    config.targetIP = protocolConfig.targetIP || config.targetIP;
                    config.targetPort = protocolConfig.targetPort || config.targetPort;
                    config.localPort = protocolConfig.localPort || config.localPort;
                    
                    // In real Max/MSP implementation, create udpsend object:
                    // oscSender = this.patcher.newdefault(0, 0, "udpsend", config.targetIP, config.targetPort);
                    
                    common.log(common.LOG_LEVEL.INFO, "SINUA Protocol initialized - Target: " + config.targetIP + ":" + config.targetPort);
                    return true;
                    
                } catch (error) {
                    common.log(common.LOG_LEVEL.ERROR, "SINUA Protocol initialization failed: " + error.message);
                    return false;
                }
            },
            
            sendCommand: function(command) {
                try {
                    var oscMessage = convertToOSC(command);
                    if (!oscMessage) {
                        return false;
                    }
                    
                    // In real implementation, send via OSC:
                    // if (oscSender) {
                    //     oscSender.message(oscMessage.address, oscMessage.value);
                    // }
                    
                    common.log(common.LOG_LEVEL.DEBUG, "SINUA OSC: " + oscMessage.address + " " + oscMessage.value);
                    return true;
                    
                } catch (error) {
                    common.log(common.LOG_LEVEL.ERROR, "SINUA send error: " + error.message);
                    return false;
                }
            },
            
            disconnect: function() {
                if (oscSender) {
                    // oscSender.freepeer();
                    oscSender = null;
                }
                common.log(common.LOG_LEVEL.INFO, "SINUA Protocol disconnected");
            },
            
            isConnected: function() {
                return oscSender !== null;
            }
        };
        
        function convertToOSC(command) {
            switch (command.type) {
                case 'stop':
                    return {
                        address: "/stop/" + command.id,
                        value: command.value ? 1 : 0
                    };
                    
                case 'tremulant':
                    if (command.value && typeof command.value === 'object') {
                        return {
                            address: "/tremulant/" + command.id + "/speed",
                            value: command.value.speed || 64
                        };
                    }
                    return {
                        address: "/tremulant/" + command.id,
                        value: command.value ? 1 : 0
                    };
                    
                case 'controller':
                    return {
                        address: "/controller/" + command.id,
                        value: Math.max(0, Math.min(127, command.value))
                    };
                    
                case 'division_batch':
                    // For batch commands, send multiple OSC messages
                    if (Array.isArray(command.value)) {
                        command.value.forEach(function(batchCmd) {
                            var oscMsg = convertToOSC(batchCmd);
                            if (oscMsg) {
                                // Send immediately for batch
                                common.log(common.LOG_LEVEL.DEBUG, "SINUA Batch OSC: " + oscMsg.address + " " + oscMsg.value);
                            }
                        });
                    }
                    return null; // Already processed
                    
                case 'preset':
                    return {
                        address: "/preset/" + command.id,
                        value: 1
                    };
                    
                default:
                    common.log(common.LOG_LEVEL.WARN, "Unknown SINUA command type: " + command.type);
                    return null;
            }
        }
    })();
    
    // ================================================================================================
    // MIDI PROTOCOL IMPLEMENTATION
    // ================================================================================================
    
    var MIDIProtocol = (function() {
        var midiOut = null;
        var config = {
            outputDevice: null,
            baseChannel: 1,
            stopMethod: "note",  // "note", "cc", "program"
            presetMethod: "program"
        };
        
        return {
            initialize: function(protocolConfig) {
                try {
                    config.outputDevice = protocolConfig.outputDevice || config.outputDevice;
                    config.baseChannel = protocolConfig.baseChannel || config.baseChannel;
                    config.stopMethod = protocolConfig.stopMethod || config.stopMethod;
                    config.presetMethod = protocolConfig.presetMethod || config.presetMethod;
                    
                    // In real Max/MSP implementation:
                    // midiOut = this.patcher.newdefault(0, 0, "midiout");
                    // if (config.outputDevice) {
                    //     midiOut.message("port", config.outputDevice);
                    // }
                    
                    common.log(common.LOG_LEVEL.INFO, "MIDI Protocol initialized - Device: " + (config.outputDevice || "Default"));
                    return true;
                    
                } catch (error) {
                    common.log(common.LOG_LEVEL.ERROR, "MIDI Protocol initialization failed: " + error.message);
                    return false;
                }
            },
            
            sendCommand: function(command) {
                try {
                    var midiMessages = convertToMIDI(command);
                    if (!midiMessages || midiMessages.length === 0) {
                        return false;
                    }
                    
                    midiMessages.forEach(function(msg) {
                        // In real implementation:
                        // if (midiOut) {
                        //     switch (msg.type) {
                        //         case 'note':
                        //             midiOut.message('note', msg.note, msg.velocity, msg.channel);
                        //             break;
                        //         case 'cc':
                        //             midiOut.message('controller', msg.controller, msg.value, msg.channel);
                        //             break;
                        //         case 'program':
                        //             midiOut.message('program', msg.program, msg.channel);
                        //             break;
                        //     }
                        // }
                        
                        common.log(common.LOG_LEVEL.DEBUG, "MIDI " + msg.type + ": Ch" + msg.channel + 
                                  (msg.note ? " Note" + msg.note + " Vel" + msg.velocity : "") +
                                  (msg.controller ? " CC" + msg.controller + " Val" + msg.value : "") +
                                  (msg.program ? " Prog" + msg.program : ""));
                    });
                    
                    return true;
                    
                } catch (error) {
                    common.log(common.LOG_LEVEL.ERROR, "MIDI send error: " + error.message);
                    return false;
                }
            },
            
            disconnect: function() {
                if (midiOut) {
                    // midiOut.freepeer();
                    midiOut = null;
                }
                common.log(common.LOG_LEVEL.INFO, "MIDI Protocol disconnected");
            },
            
            isConnected: function() {
                return midiOut !== null;
            }
        };
        
        function convertToMIDI(command) {
            var messages = [];
            
            switch (command.type) {
                case 'stop':
                    if (config.stopMethod === "note") {
                        messages.push({
                            type: 'note',
                            channel: command.channel || config.baseChannel,
                            note: command.midiNote || (command.id + 60),
                            velocity: command.value ? 127 : 0
                        });
                    } else if (config.stopMethod === "cc") {
                        messages.push({
                            type: 'cc',
                            channel: command.channel || config.baseChannel,
                            controller: command.midiCC || command.id,
                            value: command.value ? 127 : 0
                        });
                    } else if (config.stopMethod === "program" && command.value) {
                        messages.push({
                            type: 'program',
                            channel: command.channel || config.baseChannel,
                            program: command.programChange || command.id
                        });
                    }
                    break;
                    
                case 'tremulant':
                    if (command.value && typeof command.value === 'object') {
                        // Tremulant speed control via CC
                        messages.push({
                            type: 'cc',
                            channel: command.channel || config.baseChannel,
                            controller: command.speedCC || (100 + command.id),
                            value: command.value.speed || 64
                        });
                        
                        // Tremulant on/off
                        messages.push({
                            type: 'cc',
                            channel: command.channel || config.baseChannel,
                            controller: command.onOffCC || (120 + command.id),
                            value: command.value.active ? 127 : 0
                        });
                    }
                    break;
                    
                case 'controller':
                    messages.push({
                        type: 'cc',
                        channel: command.channel || config.baseChannel,
                        controller: command.midiCC || command.id,
                        value: Math.max(0, Math.min(127, command.value))
                    });
                    break;
                    
                case 'preset':
                    if (config.presetMethod === "program") {
                        messages.push({
                            type: 'program',
                            channel: command.channel || config.baseChannel,
                            program: command.programNumber || command.id
                        });
                    }
                    break;
                    
                case 'division_batch':
                    // Process batch commands
                    if (Array.isArray(command.value)) {
                        command.value.forEach(function(batchCmd) {
                            var batchMessages = convertToMIDI(batchCmd);
                            messages = messages.concat(batchMessages);
                        });
                    }
                    break;
                    
                default:
                    common.log(common.LOG_LEVEL.WARN, "Unknown MIDI command type: " + command.type);
                    break;
            }
            
            return messages;
        }
    })();
    
    // ================================================================================================
    // PROTOCOL LAYER INITIALIZATION
    // ================================================================================================
    
    function initializeProtocolLayer() {
        // Register built-in protocols
        registerProtocol("SINUA", SINUAProtocol);
        registerProtocol("MIDI", MIDIProtocol);
        
        // Set up command queue processor from DataLayer
        dataLayer.addStateListener(function(type, id, value, state) {
            // Convert state changes to protocol commands
            var command = null;
            
            switch (type) {
                case 'stop':
                    command = {
                        type: 'stop',
                        id: id,
                        value: value,
                        priority: 1
                    };
                    break;
                    
                // 'tremulant' intentionally omitted — handled directly via sendTremulantOSC in DataLayer
                // 'controller' intentionally omitted — handled directly via sendControllerOSC in DataLayer

                case 'preset':
                    command = {
                        type: 'preset',
                        id: id,
                        value: value,
                        priority: 0  // Highest priority
                    };
                    break;
            }
            
            if (command) {
                queueCommand(command);
            }
            
        }, ['stop', 'preset']);
        
        common.log(common.LOG_LEVEL.INFO, "Protocol Layer initialized with state listener");
    }
    
    // ================================================================================================
    // CONNECTION MANAGEMENT
    // ================================================================================================
    
    function connect(protocolType, config) {
        return setActiveProtocol(protocolType, config);
    }
    
    function disconnect() {
        if (protocolConfig.type !== "UNKNOWN" && protocolImplementations[protocolConfig.type]) {
            protocolImplementations[protocolConfig.type].disconnect();
            protocolConfig.connected = false;
            protocolConfig.type = "UNKNOWN";
            common.log(common.LOG_LEVEL.INFO, "Protocol disconnected");
        }
    }
    
    function isConnected() {
        return protocolConfig.connected && 
               protocolConfig.type !== "UNKNOWN" && 
               protocolImplementations[protocolConfig.type] &&
               protocolImplementations[protocolConfig.type].isConnected();
    }
    
    function reconnect() {
        if (protocolConfig.type !== "UNKNOWN") {
            var currentType = protocolConfig.type;
            disconnect();
            setTimeout(function() {
                connect(currentType, {});
            }, 1000);
        }
    }
    
    // ================================================================================================
    // DIRECT COMMAND INTERFACE
    // ================================================================================================
    
    function sendStopCommand(stopID, state, options) {
        options = options || {};
        
        var command = {
            type: 'stop',
            id: stopID,
            value: state,
            priority: options.priority || 1,
            channel: options.channel,
            midiNote: options.midiNote,
            midiCC: options.midiCC,
            programChange: options.programChange
        };
        
        return queueCommand(command);
    }
    
    function sendTremulantCommand(tremulantID, active, speed, options) {
        options = options || {};
        
        var command = {
            type: 'tremulant',
            id: tremulantID,
            value: {
                active: active,
                speed: speed || 64
            },
            priority: options.priority || 2,
            channel: options.channel,
            speedCC: options.speedCC,
            onOffCC: options.onOffCC
        };
        
        return queueCommand(command);
    }
    
    function sendControllerCommand(controllerID, value, options) {
        options = options || {};
        
        var command = {
            type: 'controller',
            id: controllerID,
            value: Math.max(0, Math.min(127, value)),
            priority: options.priority || 3,
            channel: options.channel,
            midiCC: options.midiCC
        };
        
        return queueCommand(command);
    }
    
    function sendPresetCommand(presetID, presetData, options) {
        options = options || {};
        
        var command = {
            type: 'preset',
            id: presetID,
            value: presetData,
            priority: options.priority || 0,
            channel: options.channel,
            programNumber: options.programNumber
        };
        
        return queueCommand(command);
    }
    
    function sendBatchCommand(commands, options) {
        options = options || {};
        
        var batchCommand = {
            type: 'division_batch',
            id: options.divisionID || 'batch',
            value: commands,
            priority: options.priority || 1
        };
        
        return queueCommand(batchCommand);
    }
    
    // ================================================================================================
    // EMERGENCY FUNCTIONS
    // ================================================================================================
    
    function sendAllNotesOff(channel) {
        if (protocolConfig.type === "MIDI") {
            var channels = channel ? [channel] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
            
            channels.forEach(function(ch) {
                var command = {
                    type: 'controller',
                    id: 123,  // All Notes Off CC
                    value: 0,
                    priority: 0,  // Highest priority
                    channel: ch,
                    midiCC: 123
                };
                queueCommand(command);
            });
            
            common.log(common.LOG_LEVEL.INFO, "All Notes Off sent" + (channel ? " for channel " + channel : " for all channels"));
        } else if (protocolConfig.type === "SINUA") {
            // Send panic command via OSC
            var command = {
                type: 'panic',
                id: 'all',
                value: 1,
                priority: 0
            };
            queueCommand(command);
            common.log(common.LOG_LEVEL.INFO, "SINUA panic command sent");
        }
    }
    
    function sendPanicCommand() {
        // Clear all queues first
        protocolConfig.commandQueue = [];
        protocolConfig.retryQueue = [];
        
        // Send emergency stop commands
        sendAllNotesOff();
        
        // Force immediate processing
        processCommandQueue();
        
        common.log(common.LOG_LEVEL.INFO, "Panic command executed - all queues cleared");
    }
    
    // ================================================================================================
    // MONITORING AND STATISTICS
    // ================================================================================================
    
    function getProtocolStatus() {
        return {
            type: protocolConfig.type,
            connected: protocolConfig.connected,
            isActive: isConnected(),
            queueLength: protocolConfig.commandQueue.length,
            retryQueueLength: protocolConfig.retryQueue.length,
            stats: {
                commandsSent: protocolConfig.stats.commandsSent,
                commandsFailed: protocolConfig.stats.commandsFailed,
                lastActivity: protocolConfig.stats.lastActivity,
                successRate: protocolConfig.stats.commandsSent > 0 ? 
                    ((protocolConfig.stats.commandsSent / (protocolConfig.stats.commandsSent + protocolConfig.stats.commandsFailed)) * 100).toFixed(1) + '%' : 'N/A'
            },
            lastCommand: protocolConfig.lastCommand,
            availableProtocols: Object.keys(protocolImplementations)
        };
    }
    
    function clearStatistics() {
        protocolConfig.stats = {
            commandsSent: 0,
            commandsFailed: 0,
            lastActivity: null
        };
        common.log(common.LOG_LEVEL.INFO, "Protocol statistics cleared");
    }
    
    function displayProtocolStatus() {
        var status = getProtocolStatus();
        
        common.log(common.LOG_LEVEL.INFO, "=== PROTOCOL STATUS ===");
        common.log(common.LOG_LEVEL.INFO, "Type: " + status.type);
        common.log(common.LOG_LEVEL.INFO, "Connected: " + status.connected);
        common.log(common.LOG_LEVEL.INFO, "Active: " + status.isActive);
        common.log(common.LOG_LEVEL.INFO, "Queue Length: " + status.queueLength);
        common.log(common.LOG_LEVEL.INFO, "Retry Queue: " + status.retryQueueLength);
        common.log(common.LOG_LEVEL.INFO, "Commands Sent: " + status.stats.commandsSent);
        common.log(common.LOG_LEVEL.INFO, "Commands Failed: " + status.stats.commandsFailed);
        common.log(common.LOG_LEVEL.INFO, "Success Rate: " + status.stats.successRate);
        common.log(common.LOG_LEVEL.INFO, "Available Protocols: " + status.availableProtocols.join(', '));
        
        if (status.lastActivity) {
            var timeSince = Date.now() - status.lastActivity;
            common.log(common.LOG_LEVEL.INFO, "Last Activity: " + (timeSince / 1000).toFixed(1) + "s ago");
        } else {
            common.log(common.LOG_LEVEL.INFO, "Last Activity: Never");
        }
        
        common.log(common.LOG_LEVEL.INFO, "=====================");
    }
    
    // ================================================================================================
    // CONFIGURATION MANAGEMENT
    // ================================================================================================
    
    function configureProtocol(protocolType, config) {
        if (!protocolImplementations[protocolType]) {
            common.log(common.LOG_LEVEL.ERROR, "Cannot configure unknown protocol: " + protocolType);
            return false;
        }
        
        try {
            // Store configuration for future connections
            connectionHandlers[protocolType] = config;
            
            // If this is the currently active protocol, reconfigure it
            if (protocolConfig.type === protocolType && protocolConfig.connected) {
                return setActiveProtocol(protocolType, config);
            }
            
            common.log(common.LOG_LEVEL.INFO, "Configuration stored for protocol: " + protocolType);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "Error configuring protocol: " + error.message);
            return false;
        }
    }
    
    function getProtocolConfig(protocolType) {
        return connectionHandlers[protocolType] || {};
    }
    
    // ================================================================================================
    // TESTING AND DEBUGGING
    // ================================================================================================
    
    function testProtocolConnection(protocolType, config) {
        config = config || {};
        
        common.log(common.LOG_LEVEL.INFO, "Testing protocol connection: " + protocolType);
        
        try {
            var testImpl = protocolImplementations[protocolType];
            if (!testImpl) {
                common.log(common.LOG_LEVEL.ERROR, "Protocol not available: " + protocolType);
                return false;
            }
            
            // Test initialization
            var initResult = testImpl.initialize(config);
            if (!initResult) {
                common.log(common.LOG_LEVEL.ERROR, "Protocol initialization failed");
                return false;
            }
            
            // Test basic command
            var testCommand = {
                type: 'stop',
                id: 999,
                value: true
            };
            
            var sendResult = testImpl.sendCommand(testCommand);
            if (!sendResult) {
                common.log(common.LOG_LEVEL.ERROR, "Test command failed");
                testImpl.disconnect();
                return false;
            }
            
            // Test disconnection
            testImpl.disconnect();
            
            common.log(common.LOG_LEVEL.INFO, "Protocol test successful: " + protocolType);
            return true;
            
        } catch (error) {
            common.log(common.LOG_LEVEL.ERROR, "Protocol test error: " + error.message);
            return false;
        }
    }
    
    function simulateCommand(command) {
        common.log(common.LOG_LEVEL.INFO, "Simulating command: " + JSON.stringify(command));
        
        // Add to queue without sending
        command.timestamp = Date.now();
        command.simulated = true;
        
        protocolConfig.commandQueue.push(command);
        
        common.log(common.LOG_LEVEL.INFO, "Command queued for simulation (not sent)");
    }
    
    // ================================================================================================
    // AUTO-INITIALIZATION
    // ================================================================================================
    
    // Initialize the protocol layer when module is created
    initializeProtocolLayer();
    
    // ================================================================================================
    // PUBLIC API
    // ================================================================================================
    
    return {
        // Protocol management
        registerProtocol: registerProtocol,
        connect: connect,
        disconnect: disconnect,
        reconnect: reconnect,
        isConnected: isConnected,
        setActiveProtocol: setActiveProtocol,
        
        // Command interface
        sendStopCommand: sendStopCommand,
        sendTremulantCommand: sendTremulantCommand,
        sendControllerCommand: sendControllerCommand,
        sendPresetCommand: sendPresetCommand,
        sendBatchCommand: sendBatchCommand,
        queueCommand: queueCommand,
        
        // Emergency functions
        sendAllNotesOff: sendAllNotesOff,
        sendPanicCommand: sendPanicCommand,
        
        // Queue management
        processCommandQueue: processCommandQueue,
        clearCommandQueue: function() {
            protocolConfig.commandQueue = [];
            protocolConfig.retryQueue = [];
            common.log(common.LOG_LEVEL.INFO, "Command queues cleared");
        },
        getQueueLength: function() {
            return protocolConfig.commandQueue.length;
        },
        
        // Configuration
        configureProtocol: configureProtocol,
        getProtocolConfig: getProtocolConfig,
        
        // Monitoring
        getProtocolStatus: getProtocolStatus,
        displayProtocolStatus: displayProtocolStatus,
        clearStatistics: clearStatistics,
        
        // Testing
        testProtocolConnection: testProtocolConnection,
        simulateCommand: simulateCommand,
        
        // Access to protocol implementations (for advanced usage)
        getProtocolImplementation: function(protocolType) {
            return protocolImplementations[protocolType];
        },
        
        // Internal state access (for debugging)
        getInternalState: function() {
            return {
                config: protocolConfig,
                implementations: Object.keys(protocolImplementations),
                handlers: Object.keys(connectionHandlers)
            };
        }
    };
}

// ================================================================================================
// MODULE REGISTRATION
// ================================================================================================

if (typeof global !== 'undefined') {
    global.createProtocolLayerModule = createProtocolLayerModule;
}

post("organTool_ProtocolLayer.js v00.10 - Protocol communication layer loaded\n");