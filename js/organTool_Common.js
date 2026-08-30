// organTool_Common.js - CORRECTED GEOMETRY & BEST PRACTICES
// 00.16 - Fixed GEOMETRY integration with dependency injection
// 05.07.2025

autowatch = 1;

function createCommonModule() {
    // *** CHANGED: Import geometry module first ***
    var geometry = createGeometryModule();
    if (!geometry) {
        throw new Error("Failed to load Geometry module");
    }

    var currentLogLevel = 4;
    
    var LOG_LEVEL = {
        ERROR: 0,
        WARN: 1,
        INFO: 2,
        VERBOSE: 3,
        DEBUG: 4
    };
    
    // *** CHANGED: Use geometry's MAX_STOPS_PER_COLUMN instead of local ***
    var MAX_STOPS_PER_COLUMN = geometry.MAX_STOPS_PER_COLUMN;
    
    var MANAGED_OBJECT_TYPES = new Set([
        "live.dial", "live.text", "live.menu", "live.numbox", "live.slider", 
        "live.tab", "live.toggle", "live.comment", "comment", "bpatcher", "jpatcher"
    ]);
    
    // ================================================================================================
    // LOGGING FUNCTIONS
    // ================================================================================================
    
    function log(level, message, context) {
        if (level <= currentLogLevel) {
            var timestamp = new Date().toISOString();
            var contextStr = context && Object.keys(context).length ? 
            " [" + JSON.stringify(context) + "]" : '';
            post("[" + timestamp + "] " + message + contextStr + "\n");
        }
    }
    
    function selectLogLevel(newLogLevel) {
        if (typeof newLogLevel === 'string' && newLogLevel in LOG_LEVEL) {
            currentLogLevel = LOG_LEVEL[newLogLevel];
            log(LOG_LEVEL.INFO, "Log level changed to: " + newLogLevel);
        } else if (typeof newLogLevel === 'number' && newLogLevel >= 0 && newLogLevel <= 4) {
            currentLogLevel = newLogLevel;
            log(LOG_LEVEL.INFO, "Log level changed to: " + newLogLevel);
        } else {
            log(LOG_LEVEL.WARN, "Cannot change log level to " + newLogLevel);
        }
    }
    
    // ================================================================================================
    // UTILITY FUNCTIONS
    // ================================================================================================
    
    function getScriptDirectory(path) {
        path = path || "";
        return this.patcher.filepath.replace(/\/[^\/]*$/, "") + path;
    }
    
    function dictToJson(dict) {
        if (!dict || typeof dict.stringify !== 'function') {
            log(LOG_LEVEL.ERROR, "Invalid dict object provided to dictToJson");
            return null;
        }
        try {
            return JSON.parse(dict.stringify());
        } catch (error) {
            log(LOG_LEVEL.ERROR, "Failed to parse dict: " + error.message);
            return null;
        }
    }
    
    function shortenString(name, maxLength) {
        maxLength = maxLength || 10;
        if (!name || typeof name !== 'string') {
            return "";
        }
        if (name.length > maxLength) {
            return name.slice(0, maxLength - 1) + "…";
        }
        return name;
    }
    
    function isValidNumber(value) {
        if (value === null || value === undefined) {
            return false;
        }
        // Allow 0 as valid number (fixed from original)
        return Number.isFinite(value) ||
        (typeof value === 'string' && !isNaN(parseFloat(value)) && isFinite(value));
    }
    
    // ================================================================================================
    // FILENAME EXTRACTION
    // ================================================================================================
    
    function extractOrganNameFromPath(filepath) {
        if (!filepath || typeof filepath !== 'string') {
            return "Unknown Organ";
        }
        
        try {
            var filename = filepath.split(/[\/\\]/).pop();
            var nameWithoutExt = filename.replace(/\.json$/i, '');
            var organName = parseOrganFilename(nameWithoutExt);
            organName = cleanOrganName(organName);
            
            log(LOG_LEVEL.VERBOSE, "Extracted organ name: \"" + organName + "\" from \"" + filename + "\"");
            return organName;
            
        } catch (error) {
            log(LOG_LEVEL.ERROR, "Failed to extract organ name from \"" + filepath + "\": " + error.message);
            return "Unknown Organ";
        }
    }
    
    function parseOrganFilename(filename) {
        var patterns = [
            { regex: /^organ[_\-\s]+(.+)$/i, group: 1 },
            { regex: /^(.+)[_\-\s]+organ$/i, group: 1 },
            { regex: /^organ([A-Z].*)$/i, group: 1 },
            { regex: /^(.+)organ$/i, group: 1 },
            { regex: /^(.*)organ(.*)$/i, group: 'combined' },
            { regex: /^(.+)$/, group: 1 }
        ];
        
        for (var i = 0; i < patterns.length; i++) {
            var pattern = patterns[i];
            var match = filename.match(pattern.regex);
            if (match) {
                if (pattern.group === 'combined') {
                    var before = match[1].trim();
                    var after = match[2].trim();
                    if (before && after) {
                        return before + " " + after;
                    } else if (before) {
                        return before;
                    } else if (after) {
                        return after;
                    } else {
                        return filename;
                    }
                } else {
                    return match[pattern.group] || filename;
                }
            }
        }
        return filename;
    }
    
    function cleanOrganName(name) {
        if (!name) return "Unknown Organ";
        
        name = name.replace(/[_\-]+/g, ' ');
        name = name.replace(/\s+/g, ' ').trim();
        name = name.replace(/\b\w/g, function(char) { return char.toUpperCase(); });
        name = name.replace(/^(organ|church|cathedral|chapel)\s+/i, '');
        name = name.replace(/\s+(organ|church|cathedral|chapel)$/i, '');
        
        return name || "Unknown Organ";
    }
    
    // ================================================================================================
    // OBJECT CREATION FUNCTIONS
    // ================================================================================================
    
    function createBpatcher(p, x, y, w, h, varname, presentation=1) {
        if (!p || typeof x !== 'number' || typeof y !== 'number' || 
            typeof w !== 'number' || typeof h !== 'number' || !varname) {
            log(LOG_LEVEL.ERROR, "createBpatcher(): Invalid parameters");
        return null;
    }

    try {
        var bpatcher = p.newdefault(x, y, "bpatcher", 
            "@varname", varname,
            "@patching_rect", x, y, w, h, 
            "@presentation_rect", x, y, w, h, 
            "@presentation", presentation, 
            "@embed", 1, 
            "@border", 1
            );

        if (!bpatcher) {
            log(LOG_LEVEL.ERROR, "createBpatcher(): Failed to create bpatcher");
            return null;
        }

        
        //var autopattr = bpatcher.subpatcher().newdefault(0, h + 10, "autopattr", "@autorestore", 0);

        return bpatcher;
    } catch (error) {
        log(LOG_LEVEL.ERROR, "createBpatcher(): " + error.message);
        return null;
    }
}

function createLiveDial(p, x, y, w, h, varname, longname, shortname, min, max) {
    if (!p || typeof x !== 'number' || typeof y !== 'number' ||
        typeof w !== 'number' || typeof h !== 'number' || !varname) {
        log(LOG_LEVEL.ERROR, "createLiveDial(): Invalid parameters");
    return null;
}

try {
    var dial = p.newdefault(x, y, "live.dial",
        "@varname", varname,
        "@patching_rect", x, y, w, h,
        "@presentation_rect", x, y, w, h,
        "@presentation", 1,
        "@appearance", 1
        );

    if (!dial) {
        log(LOG_LEVEL.ERROR, "createLiveDial(): Failed to create dial");
        return null;
    }

    try {
        dial.setattr("_parameter_longname", longname || varname);
        dial.setattr("_parameter_shortname", shortname || varname.slice(0, 5));
        dial.setattr("_parameter_invisible", 0);
        if (typeof min === 'number' && typeof max === 'number') {
            dial.setattr("_parameter_range", min, max);
            dial.setattr("_parameter_unitstyle", 1);  // 1 = Float
        }
    } catch (attrError) {
        log(LOG_LEVEL.WARN, "createLiveDial(): Failed to set parameter attributes: " + attrError.message);
    }

    return dial;
} catch (error) {
    log(LOG_LEVEL.ERROR, "createLiveDial(): " + error.message);
    return null;
}
}

function createLiveComment(p, x, y, w, h, varname, displayName, maxLength, fontsize, fontface) {
        maxLength = maxLength || 15;  // Increased default for better readability
        fontsize = fontsize || 12;
        fontface = fontface || "bold";
        
        var shortenedName = shortenString(displayName, maxLength);
        
        try {
            var comment = p.newdefault(
                x, y, "comment", 
                "@varname", varname, 
                "@patching_rect", x, y, w, h,
                "@presentation_rect", x, y, w, h,   
                "@fontsize", fontsize,
                "@fontface", fontface,
                "@presentation", 1      
                );
            
            if (comment) {
                comment.message("set", shortenedName || varname);
            }
            return comment;
        } catch (error) {
            log(LOG_LEVEL.ERROR, "createLiveComment(): " + error.message);
            return null;
        }
    }
    
    function createLiveText(p, x, y, w, h, varname, longname, shortname, text, fontsize) {
        if (!p || typeof x !== 'number' || typeof y !== 'number' || 
            typeof w !== 'number' || typeof h !== 'number' || !varname) {
            log(LOG_LEVEL.ERROR, "createLiveText(): Invalid parameters");
        return null;
    }

        fontsize = fontsize || 10;  // Smaller default for better fit
        
        try {
            var liveText = p.newdefault(
                x, y, "live.text", 
                "@varname", varname, 
                "@patching_rect", x, y, w, h,
                "@presentation_rect", x, y, w, h,       
                "@fontsize", fontsize,
                "@presentation", 1, 
                "@_parameter_invisible", 0
                );
            
            if (!liveText) {
                log(LOG_LEVEL.ERROR, "createLiveText(): Failed to create live.text");
                return null;
            }
            
            try {
                liveText.setattr("_parameter_longname", longname || varname);
                liveText.setattr("_parameter_shortname", shortname || varname);
                liveText.setattr("texton", text || varname);
                liveText.setattr("text", text || varname);
            } catch (attrError) {
                log(LOG_LEVEL.WARN, "createLiveText(): Failed to set attributes: " + attrError.message);
            }
            
            return { liveText: liveText };
        } catch (error) {
            log(LOG_LEVEL.ERROR, "createLiveText(): " + error.message);
            return null;
        }
    }
    
    function createLiveButton(p, x, y, w, h, varname, longname, shortname, text, fontsize) {
        var button = createLiveText(p, x, y, w, h, varname, longname, shortname, text, fontsize); 
        if (button && button.liveText) {
            try {
                button.liveText.setattr("mode", 0); 
            } catch (error) {
                log(LOG_LEVEL.WARN, "createLiveButton(): Failed to set mode: " + error.message);
            }
        }
        return button;
    }

    function createLiveTab(p, x, y, w, h, varname, longname, shortname, range) {
        if (!p || typeof x !== 'number' || typeof y !== 'number' || 
            typeof w !== 'number' || typeof h !== 'number' || !varname) {
            log(LOG_LEVEL.ERROR, "createLiveTab(): Invalid parameters");
        return null;
    }

    try {
        var tab = p.newdefault(x, y, "live.tab",
            "@varname", varname,
            "@patching_rect", x, y, w, h, 
            "@presentation_rect", x, y, w, h, 
            "@presentation", 1, 
            "@appearance", 0,
            "@multiline", 0
            );

        if (!tab) {
            log(LOG_LEVEL.ERROR, "createLiveTab(): Failed to create tab");
            return null;
        };

        try {
            tab.setattr("_parameter_longname", longname || varname);
            tab.setattr("_parameter_shortname", shortname || varname.slice(0, 5));
            tab.setattr("_parameter_invisible", 0);
            if (range) {
                tab.setattr("_parameter_range", range);
            }
        } catch (attrError) {
            log(LOG_LEVEL.WARN, "createLiveTab(): Failed to set parameter attributes: " + attrError.message);
        }

        return tab;
    } catch (error) {
        log(LOG_LEVEL.ERROR, "createLiveTab(): " + error.message);
        return null;
    }
}   

    // ================================================================================================
    // VALIDATION FUNCTIONS
    // ================================================================================================

function validateOrganData(organDict) {
    if (!organDict) {
        log(LOG_LEVEL.ERROR, "No organ dict available");
        return false;
    }

    try {
        var organData = dictToJson(organDict);
        if (!organData) {
            log(LOG_LEVEL.ERROR, "Failed to read organ data from dict");
            return false;
        }

            // Check for SINUA format
        if (organData.Divisions && Array.isArray(organData.Divisions) &&
            organData.Stops && Array.isArray(organData.Stops)) {
            return true;
    }

            // Check for MIDI format
    if (organData.manuals && Array.isArray(organData.manuals)) {
        return true;
    }

    log(LOG_LEVEL.ERROR, "No valid organ format detected");
    return false;

} catch (error) {
    log(LOG_LEVEL.ERROR, "Error validating organ data: " + error.message);
    return false;
}
}

    // ================================================================================================
    // CLEANUP FUNCTIONS
    // ================================================================================================

// Find an object by scripting name anywhere at or below `patcher`.
//
// patcher.getnamed() only sees the level it is called on, so an object the user
// moved into a bpatcher (a presetControl panel, say) becomes invisible — and code
// that reacts by creating its own copy ends up with two of them.  This descends
// into bpatchers and subpatchers as well.  depth is bounded: a patcher can contain
// itself by reference, and an unbounded walk would never return.
function findNamedDeep(patcher, varname, depth) {
    if (!patcher || !varname) return null;
    depth = depth || 0;
    if (depth > 6) return null;

    try {
        var direct = patcher.getnamed(varname);
        if (direct) return direct;
    } catch (e) { return null; }

    var obj = patcher.firstobject;
    while (obj) {
        var sub = null;
        try { sub = (typeof obj.subpatcher === "function") ? obj.subpatcher() : null; }
        catch (e) { sub = null; }

        if (sub) {
            var found = findNamedDeep(sub, varname, depth + 1);
            if (found) return found;
        }
        obj = obj.nextobject;
    }
    return null;
}

// Same, but starting at `patcher` and then trying each parent in turn — covers a
// name that sits above the calling patcher as well as below it.
function findNamedAround(patcher, varname) {
    var p = patcher;
    while (p) {
        var found = findNamedDeep(p, varname, 0);
        if (found) return found;
        p = p.parentpatcher;
    }
    return null;
}

function clearGUIObjects(patcher, keepObjects) {
    keepObjects = keepObjects || [];

    try {
        var obj = patcher.firstobject;
        var objectsToRemove = [];

        while (obj) {
            var shouldKeep = keepObjects.indexOf(obj.varname) !== -1 || 
            obj.maxclass === "js" || 
            obj.maxclass === "message" ||
            obj.maxclass === "newobj" ||
            obj.maxclass === "inlet" ||
            obj.maxclass === "outlet" ||
            obj.maxclass === "pattrstorage" ||
            obj.maxclass === "autopattr" ||
            obj.varname === "storage" ||
            obj.varname === "server" ||
            obj.varname === "fileControl" ||
            obj.varname === "soloSafe" ||
            obj.varname === "messageDisplay" ||
            (obj.varname && obj.varname.startsWith("ignore")) ||
            // The preset system's own controls (presetControl, preset_menu,
            // presetMenuSelect …) share this patcher but are not part of the organ
            // GUI — rebuilding the organ must not take them with it.
            (obj.varname && obj.varname.startsWith("preset")) ||
            // the MIDI Effect Rack panel lives here too and is not organ GUI
            (obj.varname && obj.varname.startsWith("rack")) ||
            obj.varname === "organ_dialog" ||
            obj.varname === "gamut_preset_bank" ||
            // Everything this tool creates for itself is prefixed, so one rule covers
            // organ_dialog, organ_live_ready, organ_live_ready_fwd and whatever comes
            // next — they are not organ GUI and must survive a rebuild.
            (obj.varname && obj.varname.indexOf("organ_") === 0) ||
            // KEEP BY CLASS.  The rule above is a denylist: anything carrying a varname
            // that is not listed gets removed.  A [dict] holding the preset bank was
            // deleted that way as soon as Max or autopattr gave it a scripting name of
            // its own — taking the presets with it.  These classes are never part of
            // the organ GUI, whatever they happen to be called.
            obj.maxclass === "dict" ||
            obj.maxclass === "live.thisdevice" ||
            obj.maxclass === "prepend" ||
            obj.maxclass === "receive" ||
            obj.maxclass === "send";

            if (!shouldKeep && obj.varname) {
                objectsToRemove.push(obj);
            }
            obj = obj.nextobject;
        }

        for (var i = 0; i < objectsToRemove.length; i++) {
            try {
                patcher.remove(objectsToRemove[i]);
            } catch (error) {
                    // Ignore removal errors - object might already be removed
            }
        }

        var names = [];
        for (var n = 0; n < objectsToRemove.length && n < 12; n++) {
            try { names.push(String(objectsToRemove[n].varname)); } catch(e) {}
        }
        log(LOG_LEVEL.INFO, "clearGUIObjects(): Removed " + objectsToRemove.length +
            " GUI objects" + (names.length ? " [" + names.join(", ") +
            (objectsToRemove.length > names.length ? ", …" : "") + "]" : ""));

    } catch (error) {
        log(LOG_LEVEL.WARN, "clearGUIObjects(): Error during clearing: " + error.message);
    }

        // Clear entire geometry cache so next organ load gets fresh positions
    if (geometry && geometry.GEOMETRY) {
        geometry.GEOMETRY._calculatedWidths = {};
        geometry.GEOMETRY._cache = {};  // FIX: was missing — stale positions persisted across organ loads
    }
}

    // ================================================================================================
    // PUBLIC API - *** CHANGED: Clean exports without duplication ***
    // ================================================================================================

return {
        // *** CHANGED: Import from geometry module ***
    GEOMETRY: geometry.GEOMETRY,
    MAX_STOPS_PER_COLUMN: geometry.MAX_STOPS_PER_COLUMN,

        // Constants
    LOG_LEVEL: LOG_LEVEL,
    MANAGED_OBJECT_TYPES: MANAGED_OBJECT_TYPES,

        // Logging
    log: log,
    selectLogLevel: selectLogLevel,

        // Utilities
    getScriptDirectory: getScriptDirectory,
    dictToJson: dictToJson,
    shortenString: shortenString,
    isValidNumber: isValidNumber,

        // Filename extraction
    extractOrganNameFromPath: extractOrganNameFromPath,
    parseOrganFilename: parseOrganFilename,
    cleanOrganName: cleanOrganName,

        // Object creation
    createBpatcher: createBpatcher,
    createLiveDial: createLiveDial,
    createLiveComment: createLiveComment,
    createLiveText: createLiveText,
    createLiveButton: createLiveButton,
    createLiveTab: createLiveTab,

        // Validation
    validateOrganData: validateOrganData,

        // Cleanup
    clearGUIObjects: clearGUIObjects,
    findNamedDeep: findNamedDeep,
    findNamedAround: findNamedAround
};
}

// ================================================================================================
// EXPORT
// ================================================================================================

if (typeof global !== 'undefined') {
    global.createCommonModule = createCommonModule;
}

post("organTool_Common.js v00.17 - clearGUI keeps dicts and everything named organ_*\n");