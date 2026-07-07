// gamut_storage_organ.js - Organ Preset Manager
// 00.02 - Fix recall: use single module-level Dict so GC never frees preset data.
// 00.03 - Fix store: call updateMenu() BEFORE syncToPattrstorage.
// 00.04 - updateMenu: try parent patcher if direct patcher has no preset_menu.
// 00.05 - Direct presetMenu reference via init() 3rd arg.
// 00.06 - Live project persistence via pattr (did not work — pattr values not captured by pattrstorage).
// 00.07 - Correct persistence: use [dict @name gamut_preset_bank @varname gamut_preset_bank]
//         in the patcher.  JS does new Dict("gamut_preset_bank") → same underlying object.
//         pattrstorage (with Parameter Mode Enable) tracks the dict via @varname and saves its
//         contents in the .als when Live saves.  No external JSON files needed.
//         _bankDict = new Dict("gamut_preset_bank") at module level (GC-safe, shared with patcher dict).
//         syncToBankDict()  — mirrors _indexDict / _dataDict into _bankDict after every write.
//         loadFromBankDict() — on init(), restores _indexDict / _dataDict from _bankDict.
// 29.05.2026
//
// PATCHER SETUP (add once):
//   [dict @name gamut_preset_bank @varname gamut_preset_bank]
//   [dict @name gamut_organ_path  @varname gamut_organ_path]
//   pattrstorage → Inspector → "Parameter Mode Enable" ✓
//
// JS uses new Dict("gamut_preset_bank") → same data as the patcher dict → pattrstorage saves it.
//
// STORAGE (three-tier):
//   RUNTIME:  _indexDict ("organ_preset_index")   — fast index, module-level, GC-safe
//             _dataDict  ("organ_preset_data")    — per-slot JSON blobs, module-level, GC-safe
//   DURABLE:  _bankDict  ("gamut_preset_bank")    — patcher dict; contents saved by pattrstorage
//             Populated from _index/_data on every write; restores them on init().

autowatch = 1;

// ---- Module-level state (never GC'd) ----

var _patcher      = null;
var _organMod     = null;
var _api          = null;
var _presetMenu   = null;   // direct MaxObj ref to live.menu "preset_menu"

// ---- Runtime Dicts (fast in-memory cache) ----

var _indexDict = new Dict("organ_preset_index");   // [{nr, name}, ...]
var _dataDict  = new Dict("organ_preset_data");    // slot_N_json / slot_N_name

// ---- Durable Dict (shared with patcher [dict @name gamut_preset_bank]) ----
// When pattrstorage (Parameter Mode) stores/recalls, it captures this dict's contents.
// JS writes here via the same internal name; pattrstorage sees updates immediately.

var _bankDict = new Dict("gamut_preset_bank");

// ---- Index helpers ----

function readIndex() {
    try {
        var raw = _indexDict.get("data");
        if (raw && String(raw) !== "(undefined)") return JSON.parse(String(raw));
    } catch(e) { post("gamut_storage_organ: readIndex error: " + e.message + "\n"); }
    return [];
}

function writeIndex(slots) {
    _indexDict.replace("data", JSON.stringify(slots));
}

function sortedSlots(slots) {
    return slots.slice().sort(function(a, b) { return a.nr - b.nr; });
}

// ---- Data Dict helpers ----

function saveSlot(nr, preset, name) {
    _dataDict.replace("slot_" + nr + "_json", JSON.stringify(preset));
    _dataDict.replace("slot_" + nr + "_name", name);
}

function loadSlotJson(nr) {
    var raw = _dataDict.get("slot_" + nr + "_json");
    if (!raw || String(raw) === "(undefined)") return null;
    return String(raw);
}

function removeSlot(nr) {
    try {
        _dataDict.remove("slot_" + nr + "_json");
        _dataDict.remove("slot_" + nr + "_name");
    } catch(e) {
        _dataDict.replace("slot_" + nr + "_json", "(deleted)");
        _dataDict.replace("slot_" + nr + "_name", "");
    }
}

// ---- Bank Dict (durable, pattrstorage-tracked) ----
//
// syncToBankDict: mirror runtime dicts → _bankDict so pattrstorage captures current state.
// Call after every write (store / delete / deleteAll).
//
// loadFromBankDict: on init(), restore runtime dicts from _bankDict (which pattrstorage restored).
// Returns true if at least one preset was found.

function syncToBankDict() {
    try {
        var idx = _indexDict.get("data");
        _bankDict.replace("index", idx && String(idx) !== "(undefined)" ? String(idx) : "[]");
        var slots = readIndex();
        slots.forEach(function(s) {
            var json = _dataDict.get("slot_" + s.nr + "_json");
            var name = _dataDict.get("slot_" + s.nr + "_name");
            _bankDict.replace("slot_" + s.nr + "_json", json && String(json) !== "(undefined)" ? String(json) : "");
            _bankDict.replace("slot_" + s.nr + "_name", name && String(name) !== "(undefined)" ? String(name) : s.name);
        });
        post("gamut_storage_organ: synced " + slots.length + " slot(s) → gamut_preset_bank dict\n");
    } catch(e) {
        post("gamut_storage_organ: syncToBankDict error: " + e.message + "\n");
    }
}

function loadFromBankDict() {
    try {
        var raw = _bankDict.get("index");
        var rawStr = raw ? String(raw) : "";
        if (!rawStr || rawStr === "(undefined)" || rawStr === "[]" || rawStr === "") return false;
        var slots = JSON.parse(rawStr);
        if (!Array.isArray(slots) || slots.length === 0) return false;

        writeIndex(slots);
        slots.forEach(function(s) {
            var json = _bankDict.get("slot_" + s.nr + "_json");
            var name = _bankDict.get("slot_" + s.nr + "_name");
            if (json && String(json) !== "(undefined)") _dataDict.replace("slot_" + s.nr + "_json", String(json));
            if (name && String(name) !== "(undefined)") _dataDict.replace("slot_" + s.nr + "_name", String(name));
        });
        post("gamut_storage_organ: restored " + slots.length + " preset(s) from gamut_preset_bank dict\n");
        return true;
    } catch(e) {
        post("gamut_storage_organ: loadFromBankDict error: " + e.message + "\n");
        return false;
    }
}

// ---- Public API ----

/**
 * init — call after each organ load.
 * patcher      : this.patcher of Universal.js
 * organMod     : system.organModule (capturePreset / recallPreset)
 * presetMenuRef: (optional) direct MaxObj ref to live.menu "preset_menu"
 */
exports.init = function(patcher, organMod, presetMenuRef) {
    _patcher    = patcher;
    _organMod   = organMod;
    _presetMenu = presetMenuRef || null;
    _api        = null;

    // Restore from pattrstorage-backed dict (survives Live project close/open).
    // If _bankDict is empty (first run, or pattr not set up), fall through —
    // runtime dicts may have data from the same Max session.
    var restored = loadFromBankDict();

    updateMenu();
    post("gamut_storage_organ: init OK — " + readIndex().length + " preset(s)" +
         (restored ? " (from bank dict)" : "") +
         (_presetMenu ? "; menu=direct" : "; menu=search") + "\n");
};

/**
 * store — capture current organ state → slot <presetNr>.
 */
exports.store = function(presetNr, presetName) {
    presetNr = Number(presetNr);
    if (isNaN(presetNr) || presetNr < 0) {
        post("gamut_storage_organ.store: invalid presetNr\n"); return;
    }
    if (!_organMod || typeof _organMod.capturePreset !== "function") {
        post("gamut_storage_organ.store: organModule.capturePreset not available\n"); return;
    }

    presetName = (presetName && String(presetName).trim()) || ("Preset " + presetNr);

    var preset = _organMod.capturePreset(presetName);
    if (!preset) { post("gamut_storage_organ.store: capturePreset returned null\n"); return; }

    saveSlot(presetNr, preset, presetName);

    var slots   = readIndex();
    var updated = false;
    for (var i = 0; i < slots.length; i++) {
        if (slots[i].nr === presetNr) { slots[i].name = presetName; updated = true; break; }
    }
    if (!updated) slots.push({ nr: presetNr, name: presetName });
    writeIndex(sortedSlots(slots));

    updateMenu();          // BEFORE syncToPattrstorage so pattrstorage sees correct range
    syncToBankDict();      // mirror runtime dicts → pattrstorage-tracked dict
    syncToPattrstorage("store", presetNr, presetName);
    renameChain(presetNr, presetName);

    post("gamut_storage_organ: stored preset " + presetNr + " \"" + presetName + "\"\n");
};

/**
 * recall — restore organ state from slot <presetNr>.
 */
exports.recall = function(presetNr) {
    presetNr = Number(presetNr);
    if (isNaN(presetNr)) { post("gamut_storage_organ.recall: invalid presetNr\n"); return; }
    if (!_organMod || typeof _organMod.recallPreset !== "function") {
        post("gamut_storage_organ.recall: organModule.recallPreset not available\n"); return;
    }

    var jsonStr = loadSlotJson(presetNr);
    if (!jsonStr || jsonStr === "(deleted)") {
        post("gamut_storage_organ.recall: no preset at slot " + presetNr + "\n"); return;
    }
    _organMod.recallPreset(jsonStr);
    post("gamut_storage_organ: recalled preset " + presetNr + "\n");
};

/**
 * recallFromMenuIndex — recall by 0-based menu position.
 */
exports.recallFromMenuIndex = function(idx) {
    idx = Number(idx);
    var slots = readIndex();
    if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        post("gamut_storage_organ.recallFromMenuIndex: idx " + idx + " out of range\n"); return;
    }
    exports.recall(slots[idx].nr);
};

/**
 * deletePreset — remove slot <presetNr>.
 */
exports.deletePreset = function(presetNr) {
    presetNr = Number(presetNr);
    if (isNaN(presetNr)) return;

    removeSlot(presetNr);
    var slots = readIndex().filter(function(s) { return s.nr !== presetNr; });
    writeIndex(slots);

    syncToBankDict();
    syncToPattrstorage("delete", presetNr);
    clearChain(presetNr);
    updateMenu();
    post("gamut_storage_organ: deleted preset " + presetNr + "\n");
};

/**
 * deleteAll — wipe all presets.
 */
exports.deleteAll = function() {
    var slots = readIndex();
    for (var i = 0; i < slots.length; i++) {
        removeSlot(slots[i].nr);
        clearChain(slots[i].nr);
    }
    writeIndex([]);
    syncToBankDict();
    syncToPattrstorage("clear");
    updateMenu();
    post("gamut_storage_organ: all presets deleted\n");
};

exports.updateMenu  = updateMenu;
exports.getSlotList = function() { return readIndex(); };

// ---- Menu update ----

function findPresetMenu() {
    if (_presetMenu) return _presetMenu;
    if (!_patcher) return null;
    var p = _patcher;
    while (p) {
        var m = p.getnamed("preset_menu");
        if (m) return m;
        p = p.parentpatcher;
    }
    return null;
}

function updateMenu() {
    if (!_patcher) { post("gamut_storage_organ: updateMenu: _patcher is null\n"); return; }

    var menu = findPresetMenu();
    if (!menu) {
        post("gamut_storage_organ: updateMenu: preset_menu not found\n");
        return;
    }

    var slots = readIndex();
    var names = [];
    for (var i = 0; i < slots.length; i++) names.push("p " + slots[i].nr + ": " + slots[i].name);
    if (names.length === 0)      names = ["--", "--"];
    else if (names.length === 1) names.push("--");

    menu.setattr("_parameter_range", names);
    post("gamut_storage_organ: updateMenu OK — " + slots.length + " slot(s): " + names[0] + "\n");
}

// ---- pattrstorage sync (XML export, optional) ----

function syncToPattrstorage(action, presetNr, presetName) {
    if (!_patcher) return;
    try {
        var ps = _patcher.getnamed("storage");
        if (!ps) return;
        if      (action === "store")  ps.message("store",  presetNr, presetName);
        else if (action === "delete") ps.message("delete", presetNr);
        else if (action === "clear")  ps.message("clear");
    } catch(e) { /* pattrstorage not present */ }
}

// ---- MIDI Effect Rack chain renaming ----

function getLiveAPI() {
    if (_api) return _api;
    if (!_patcher) return null;
    try { _api = new LiveAPI(_patcher); } catch(e) { _api = null; }
    return _api;
}

function renameChain(nr, name) {
    var api = getLiveAPI();
    if (!api) return;
    try {
        api.path = "this_device canonical_parent devices 0 chains " + nr;
        api.set("name", "p " + nr + ": " + name);
        api.set("color", 100);
    } catch(e) { post("gamut_storage_organ: renameChain " + nr + " failed: " + e.message + "\n"); }
}

function clearChain(nr) {
    var api = getLiveAPI();
    if (!api) return;
    try {
        api.path = "this_device canonical_parent devices 0 chains " + nr;
        api.set("name", "--");
        api.set("color", 1);
    } catch(e) { /* chain may not exist */ }
}

post("gamut_storage_organ.js v00.07 loaded\n");
