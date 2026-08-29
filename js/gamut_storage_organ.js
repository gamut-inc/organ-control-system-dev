// gamut_storage_organ.js - Organ Preset Manager
// 00.02 - Fix recall: use single module-level Dict so GC never frees preset data.
// 00.03 - Fix store: call updateMenu() BEFORE syncToPattrstorage.
// 00.04 - updateMenu: try parent patcher if direct patcher has no preset_menu.
// 00.05 - Direct presetMenu reference via init() 3rd arg.
// 00.06 - pattr persistence attempt — did NOT work: a pattr value is not what
//         pattrstorage captures, and Live parameters cannot hold long symbols.
// 00.07 - [dict @name] persistence attempt — dict was written correctly, but on
//         project reload it was still EMPTY: pattrstorage only refills a tracked
//         dict when a slot is explicitly RECALLED, which nobody did.
// 00.08 - Working persistence, three layers (first hit wins on load):
//         1. Dict "gamut_preset_bank" — refilled by an explicit pattrstorage
//            "recall PERSIST_SLOT" at startup (Live project persistence).
//         2. JSON file next to the js files — always written, always readable,
//            survives even when pattrstorage is absent or misconfigured.
//         3. Whatever is already in the runtime dicts (same Max session).
//         The organ FILEPATH now lives in the same bank, so one store covers
//         "which organ" and "which presets" together.
//         initStorage(patcher, scriptDir) — call at system init, before any organ
//         is loaded; init(patcher, organMod, menuRef) — call after each organ load.
// 29.08.2026
//
// PATCHER SETUP (add once):
//   [dict @name gamut_preset_bank @varname gamut_preset_bank]
//   pattrstorage named "storage" → Inspector → "Parameter Mode Enable" checked
//
// Slot 128 (PERSIST_SLOT) is reserved for this bank — user presets keep 1..127,
// which is also what the MIDI Effect Rack chain renaming uses.
//
// STORAGE LAYERS
//   RUNTIME:  _indexDict / _dataDict  — fast in-memory, module-level (GC-safe)
//   DURABLE:  _bankDict "gamut_preset_bank" → pattrstorage slot 128 → Live project
//   BACKUP:   <scriptDir>gamut_organ_presets.json — plain file, written on every change

autowatch = 1;

// ---- Constants ----

var PERSIST_SLOT   = 128;                          // pattrstorage slot holding the whole bank
var BACKUP_FILE    = "gamut_organ_presets.json";   // written next to the js files

// ---- Module-level state ----

var _patcher    = null;
var _organMod   = null;
var _api        = null;
var _presetMenu = null;   // direct MaxObj ref to live.menu "preset_menu"
var _scriptDir  = "";     // set by initStorage — where the backup file lives
var _loaded     = false;  // true once a load attempt has restored (or confirmed empty)

// ---- Runtime Dicts (fast in-memory cache, never GC'd) ----

var _indexDict = new Dict("organ_preset_index");   // [{nr, name}, ...]
var _dataDict  = new Dict("organ_preset_data");    // slot_N_json / slot_N_name

// ---- Durable Dict (shared with patcher [dict @name gamut_preset_bank]) ----

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

function dictStr(d, key) {
    var raw = d.get(key);
    if (!raw) return "";
    var s = String(raw);
    return (s === "(undefined)") ? "" : s;
}

// ================================================================================================
// PERSISTENCE
// ================================================================================================
//
// One serialisable object holds everything worth keeping:
//   { v: 1, organPath: "...", index: [{nr,name}], slots: { "1": {name, json} } }

function buildBankObject() {
    var slots = readIndex();
    var slotsObj = {};
    slots.forEach(function(s) {
        var json = loadSlotJson(s.nr);
        if (json) slotsObj[s.nr] = { name: s.name, json: json };
    });
    return {
        v:         1,
        organPath: dictStr(_bankDict, "organPath"),
        index:     slots,
        slots:     slotsObj
    };
}

// Returns true when anything usable was restored — an organ path counts on its own,
// so loading an organ without ever storing a preset still survives a project reload.
function applyBankObject(bank) {
    if (!bank) return false;
    var restored = false;

    if (bank.organPath) {
        _bankDict.replace("organPath", bank.organPath);
        restored = true;
    }

    if (bank.index && bank.index.length) {
        writeIndex(bank.index);
        var slotsObj = bank.slots || {};
        Object.keys(slotsObj).forEach(function(nr) {
            var s = slotsObj[nr];
            if (!s) return;
            _dataDict.replace("slot_" + nr + "_json", s.json);
            _dataDict.replace("slot_" + nr + "_name", s.name);
        });
        restored = true;
    }

    return restored;
}

// Human-readable summary for the restore log line
function describeBank(bank) {
    var n = (bank && bank.index) ? bank.index.length : 0;
    return n + " preset(s)" + ((bank && bank.organPath) ? " + organ path" : "");
}

// --- Layer 1: bank dict (pattrstorage / Live project) ---

// Mirror everything into _bankDict, then push it into the reserved pattrstorage slot.
// Without the explicit "store", pattrstorage never captures the dict contents —
// that was the v00.07 bug.
function persist() {
    try {
        var bank = buildBankObject();
        _bankDict.replace("bank", JSON.stringify(bank));

        var ps = findPattrstorage();
        if (ps) {
            try { ps.message("store", PERSIST_SLOT, "GAMUT_BANK"); } catch(e) {}
        }

        writeBackupFile(bank);

        post("gamut_storage_organ: persisted " + bank.index.length + " preset(s)" +
             (ps ? " → pattrstorage slot " + PERSIST_SLOT : " (no pattrstorage)") + " + backup file\n");
    } catch(e) {
        post("gamut_storage_organ: persist error: " + e.message + "\n");
    }
}

function readBankDict() {
    try {
        var raw = dictStr(_bankDict, "bank");
        if (!raw) return null;
        return JSON.parse(raw);
    } catch(e) {
        post("gamut_storage_organ: readBankDict error: " + e.message + "\n");
        return null;
    }
}

// Ask pattrstorage to refill the tracked dict from the reserved slot.
// This is asynchronous — the caller must re-read the dict from a Task.
function requestPattrstorageRecall() {
    var ps = findPattrstorage();
    if (!ps) return false;
    try {
        ps.message("recall", PERSIST_SLOT);
        return true;
    } catch(e) {
        post("gamut_storage_organ: pattrstorage recall failed: " + e.message + "\n");
        return false;
    }
}

// --- Layer 2: plain JSON backup file ---

function backupPath() {
    return _scriptDir ? (_scriptDir + BACKUP_FILE) : BACKUP_FILE;
}

function writeBackupFile(bank) {
    try {
        var d = new Dict();                       // temporary — freed below
        d.replace("bank", JSON.stringify(bank));
        d.export_json(backupPath());
        d.freepeer();
    } catch(e) {
        post("gamut_storage_organ: backup write failed: " + e.message + "\n");
    }
}

function readBackupFile() {
    try {
        var d = new Dict();
        d.import_json(backupPath());
        var raw = dictStr(d, "bank");
        d.freepeer();
        if (!raw) return null;
        return JSON.parse(raw);
    } catch(e) {
        return null;   // file absent on first run — not an error
    }
}

// --- Load orchestration ---

// Try dict → backup file. Returns true when presets were restored.
function tryRestore(sourceLabel) {
    var bank = readBankDict();
    if (applyBankObject(bank)) {
        post("gamut_storage_organ: restored " + describeBank(bank) +
             " from bank dict (" + sourceLabel + ")\n");
        _loaded = true;
        return true;
    }

    bank = readBackupFile();
    if (applyBankObject(bank)) {
        // Push the file contents back into the dict so the Live project picks them up
        _bankDict.replace("bank", JSON.stringify(bank));
        post("gamut_storage_organ: restored " + describeBank(bank) +
             " from backup file (" + sourceLabel + ")\n");
        _loaded = true;
        return true;
    }
    return false;
}

/**
 * initStorage — call ONCE at system init, BEFORE any organ is loaded.
 * Restores the preset bank and the last organ path so the auto-reload can use them.
 * patcher   : this.patcher of Universal.js
 * scriptDir : directory holding the js files (backup file goes there)
 */
exports.initStorage = function(patcher, scriptDir) {
    _patcher   = patcher;
    _scriptDir = scriptDir || "";
    _loaded    = false;

    // Immediate attempt: Live may already have recalled the slot for us
    if (tryRestore("immediate")) return;

    // Otherwise ask pattrstorage to refill the dict, then retry from a Task
    // (pattrstorage recall is asynchronous — reading synchronously returns stale data).
    if (requestPattrstorageRecall()) {
        var retry = new Task(function() {
            if (!_loaded) tryRestore("after pattrstorage recall");
            if (!_loaded) post("gamut_storage_organ: no stored presets found (first run?)\n");
        });
        retry.schedule(150);
    } else {
        post("gamut_storage_organ: no stored presets found (no pattrstorage, no backup)\n");
    }
};

/**
 * init — call after each organ load, once the organ module exists.
 * organMod     : system.organModule (capturePreset / recallPreset)
 * presetMenuRef: (optional) direct MaxObj ref to live.menu "preset_menu"
 */
exports.init = function(patcher, organMod, presetMenuRef) {
    _patcher    = patcher || _patcher;
    _organMod   = organMod;
    _presetMenu = presetMenuRef || null;
    _api        = null;

    // Storage was restored by initStorage(); only reload here if that never ran
    if (!_loaded) tryRestore("late init");

    updateMenu();
    post("gamut_storage_organ: init OK — " + readIndex().length + " preset(s)" +
         (_presetMenu ? "; menu=direct" : "; menu=search") + "\n");
};

// ---- Organ path (stored in the same bank) ----

/** setOrganPath — remember which organ was loaded, so the next session can reload it. */
exports.setOrganPath = function(filepath) {
    if (!filepath) return;
    _bankDict.replace("organPath", String(filepath));
    persist();
};

/** getOrganPath — the organ file loaded when the project was last saved (or null). */
exports.getOrganPath = function() {
    var p = dictStr(_bankDict, "organPath");
    return (p && p !== "0") ? p : null;
};

// ---- Public preset API ----

exports.store = function(presetNr, presetName) {
    presetNr = Number(presetNr);
    if (isNaN(presetNr) || presetNr < 0) {
        post("gamut_storage_organ.store: invalid presetNr\n"); return;
    }
    if (presetNr === PERSIST_SLOT) {
        post("gamut_storage_organ.store: slot " + PERSIST_SLOT + " is reserved\n"); return;
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

    updateMenu();     // before persist() so pattrstorage captures the correct menu range
    persist();
    renameChain(presetNr, presetName);

    post("gamut_storage_organ: stored preset " + presetNr + " \"" + presetName + "\"\n");
};

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

exports.recallFromMenuIndex = function(idx) {
    idx = Number(idx);
    var slots = readIndex();
    if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        post("gamut_storage_organ.recallFromMenuIndex: idx " + idx + " out of range\n"); return;
    }
    exports.recall(slots[idx].nr);
};

exports.deletePreset = function(presetNr) {
    presetNr = Number(presetNr);
    if (isNaN(presetNr)) return;

    removeSlot(presetNr);
    var slots = readIndex().filter(function(s) { return s.nr !== presetNr; });
    writeIndex(slots);

    persist();
    clearChain(presetNr);
    updateMenu();
    post("gamut_storage_organ: deleted preset " + presetNr + "\n");
};

exports.deleteAll = function() {
    var slots = readIndex();
    for (var i = 0; i < slots.length; i++) {
        removeSlot(slots[i].nr);
        clearChain(slots[i].nr);
    }
    writeIndex([]);
    persist();
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

function findPattrstorage() {
    if (!_patcher) return null;
    var p = _patcher;
    while (p) {
        var ps = p.getnamed("storage");
        if (ps) return ps;
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

// ---- MIDI Effect Rack chain renaming (optional — silent when no rack is present) ----

function getLiveAPI() {
    if (_api) return _api;
    if (!_patcher) return null;
    try { _api = new LiveAPI(_patcher); } catch(e) { _api = null; }
    return _api;
}

// True only when the device really sits in a rack with enough chains.
// Without this check every store printed two "v8liveapi: set: no valid object set" errors.
function chainExists(nr) {
    var api = getLiveAPI();
    if (!api) return false;
    try {
        api.path = "this_device canonical_parent devices 0 chains " + nr;
        return (api.id && String(api.id) !== "0");
    } catch(e) { return false; }
}

function renameChain(nr, name) {
    if (!chainExists(nr)) return;
    try {
        _api.set("name", "p " + nr + ": " + name);
        _api.set("color", 100);
    } catch(e) { /* rack disappeared between check and set */ }
}

function clearChain(nr) {
    if (!chainExists(nr)) return;
    try {
        _api.set("name", "--");
        _api.set("color", 1);
    } catch(e) { /* chain may not exist */ }
}

post("gamut_storage_organ.js v00.08 loaded\n");
