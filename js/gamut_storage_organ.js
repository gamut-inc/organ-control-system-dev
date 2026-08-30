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
// 00.09 - Silence first-run noise: probe the backup file with File before
//         Dict.import_json (a missing file prints "dictwrap: file not found"
//         straight to the Max console — not a JS exception, so try/catch missed it).
//         recallFromMenuIndex stays quiet on an empty bank (live.menu emits index 0
//         when the device is inserted).  initStorage warns once if no pattrstorage
//         named "storage" exists, and persist() reports what actually got written.
// 00.10 - "debug 0" quiet mode: routine progress lines go through say().
// 00.11 - Guided store — storePrompt(nr) confirms an overwrite, then asks for the
//         name, driven by a [dialog] object created on demand and wired back to the
//         js box.  Max has no blocking dialog in JS, so the flow is a small state
//         machine; fromDialog() receives the answer.
// 00.12 - The dialog answer arrives as "fromDialog" (lower case) — Universal.js now
//         accepts both spellings, since Max dispatches on the exact symbol and a
//         hand-built [prepend fromDialog] must work as well as a generated one.
//         A confirm dialog opens with a bang: "symbol" with an empty argument is
//         not a valid Max message, so the OK/Cancel box never appeared.
//         highlightMenu(): store and recall move the live.menu to the preset in
//         play, so the display always names what is actually sounding.
// 00.13 - [dialog] answers as a "symbol <text>" message, so [prepend fromDialog]
//         delivers the selector as the first argument.  Left in place it landed
//         inside the preset name ("symbol dodo") and hid the CANCEL reply behind
//         it — stripped now before anything else is read.
//         movePreset(from, to): moves a preset to another slot keeping its name,
//         asking first when the target is taken.
//         clearAllPrompt(): wipes the bank after a confirm that names the count.
// 00.14 - The dialog's text field keeps whatever the last dialog left in it, so a
//         confirm prompt showed a stale name underneath it.  The field is always
//         set now: the entry dialog gets its default, a confirm gets a blank.
//         movePrompt(): asks which preset to move, then where to, then confirms
//         an overwrite — no more remembering two numbers for one message.
//         recallCurrent / recallNext / recallPrevious walk the STORED slots, so
//         gaps in the numbering do not matter.  They stop at the ends rather than
//         wrapping: a stage button should run out, not jump back to the opening.
// 00.15 - clearCurrentPrompt(): deletes the preset in play, naming it in the prompt.
//         clearAllPrompt() asks twice — the first prompt can be dismissed by reflex.
//         After a delete, "current" takes the place of what was removed instead of
//         collapsing to nothing, so next/previous carry on from the same spot.
// 00.17 - renameCurrentPrompt(): renames the preset in play, pre-filled with its
//         current name; the name inside the stored blob is updated too, so the
//         index and the preset cannot drift apart.
//         Rack chain naming is OFF by default — presetChainNaming 1 turns it back on.
// 30.08.2026
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
var _jsBox      = null;   // the hosting js/v8 box, so a created dialog can be wired to it
var _loaded     = false;  // true once a load attempt has restored (or confirmed empty)
var _quiet      = false;  // "debug 0" in Universal.js — keep the console clean live
var _current    = null;   // slot last stored or recalled — the anchor for next/prev
var _statusOut  = null;   // set by Universal.js: reports the current preset to the patch

// Routine progress reports; warnings and errors always get through.
function say(text) {
    if (!_quiet) post(text);
}

/** setQuiet — silence the routine progress lines (called by Universal's debug switch). */
exports.setQuiet = function(on) { _quiet = Boolean(on); };

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

        var fileOK = writeBackupFile(bank);

        say("gamut_storage_organ: persisted " + describeBank(bank) +
             (ps ? " → pattrstorage slot " + PERSIST_SLOT : " (NO pattrstorage found)") +
             (fileOK ? " + backup file" : " (backup file FAILED)") + "\n");
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

// Dict.import_json on a missing file prints "dictwrap: file not found" straight to
// the Max console — that is not a JS exception, so try/catch cannot swallow it.
// Probe with File first; on the very first run the file legitimately does not exist.
function backupFileExists() {
    try {
        var f = new File(backupPath(), "read");
        var ok = f.isopen;
        if (ok) f.close();
        return ok;
    } catch(e) {
        return false;
    }
}

function writeBackupFile(bank) {
    try {
        var d = new Dict();                       // temporary — freed below
        d.replace("bank", JSON.stringify(bank));
        d.export_json(backupPath());
        d.freepeer();
        return true;
    } catch(e) {
        post("gamut_storage_organ: backup write failed: " + e.message + "\n");
        return false;
    }
}

function readBackupFile() {
    if (!backupFileExists()) return null;   // first run — stay silent
    try {
        var d = new Dict();
        d.import_json(backupPath());
        var raw = dictStr(d, "bank");
        d.freepeer();
        if (!raw) return null;
        return JSON.parse(raw);
    } catch(e) {
        return null;   // unreadable / malformed — fall through to "no presets"
    }
}

// --- Load orchestration ---

// Try dict → backup file. Returns true when presets were restored.
function tryRestore(sourceLabel) {
    var bank = readBankDict();
    if (applyBankObject(bank)) {
        say("gamut_storage_organ: restored " + describeBank(bank) +
             " from bank dict (" + sourceLabel + ")\n");
        _loaded = true;
        return true;
    }

    bank = readBackupFile();
    if (applyBankObject(bank)) {
        // Push the file contents back into the dict so the Live project picks them up
        _bankDict.replace("bank", JSON.stringify(bank));
        say("gamut_storage_organ: restored " + describeBank(bank) +
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
exports.initStorage = function(patcher, scriptDir, jsBox) {
    _patcher   = patcher;
    _scriptDir = scriptDir || "";
    _jsBox     = jsBox || null;
    _loaded    = false;

    // One-time setup diagnosis — the two things persistence depends on
    var hasPS   = !!findPattrstorage();
    var hasFile = backupFileExists();
    if (!hasPS) {
        post("gamut_storage_organ: WARNING — no pattrstorage named \"storage\" found; " +
             "Live project persistence is off (backup file still works)\n");
    }

    // Immediate attempt: Live may already have recalled the slot for us
    if (tryRestore("immediate")) return;

    // Otherwise ask pattrstorage to refill the dict, then retry from a Task
    // (pattrstorage recall is asynchronous — reading synchronously returns stale data).
    if (hasPS && requestPattrstorageRecall()) {
        var retry = new Task(function() {
            if (_loaded) return;
            if (tryRestore("after pattrstorage recall")) return;
            say("gamut_storage_organ: nothing stored yet — " +
                 "pattrstorage slot " + PERSIST_SLOT + " empty, backup file " +
                 (hasFile ? "unreadable" : "not created yet") + " (first run)\n");
        });
        retry.schedule(150);
    } else {
        say("gamut_storage_organ: nothing stored yet (first run)\n");
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
    say("gamut_storage_organ: init OK — " + readIndex().length + " preset(s)" +
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

    _current = presetNr;              // what you just stored is what you are on
    updateMenu();     // before persist() so pattrstorage captures the correct menu range
    highlightMenu(presetNr);          // and select what was just stored
    persist();
    renameChain(presetNr, presetName);

    say("gamut_storage_organ: stored preset " + presetNr + " \"" + presetName + "\"\n");
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
    _current = presetNr;              // anchor for recallCurrent / next / previous
    highlightMenu(presetNr);          // the menu shows what is actually sounding
    say("gamut_storage_organ: recalled preset " + presetNr + "\n");
};

exports.recallFromMenuIndex = function(idx) {
    idx = Number(idx);
    var slots = readIndex();
    // An empty bank is the normal state right after the device is inserted — the
    // live.menu emits index 0 on load.  Nothing to recall, nothing worth reporting.
    if (slots.length === 0) return;
    if (isNaN(idx) || idx < 0 || idx >= slots.length) {
        post("gamut_storage_organ.recallFromMenuIndex: idx " + idx + " out of range\n"); return;
    }
    exports.recall(slots[idx].nr);
};

exports.deletePreset = function(presetNr) {
    presetNr = Number(presetNr);
    if (isNaN(presetNr)) return;

    // Where the deleted one sat, so "current" can take its place rather than
    // collapsing to nothing — next/previous keep working from the same spot.
    var before = readIndex();
    var wasAt  = -1;
    for (var i = 0; i < before.length; i++) {
        if (before[i].nr === presetNr) { wasAt = i; break; }
    }

    removeSlot(presetNr);
    var slots = readIndex().filter(function(s) { return s.nr !== presetNr; });
    writeIndex(slots);

    if (_current === presetNr) {
        if (!slots.length)            _current = null;
        else if (wasAt < slots.length) _current = slots[wasAt].nr;   // the one that moved up
        else                           _current = slots[slots.length - 1].nr;
        if (_current !== null) highlightMenu(_current);
    }

    persist();
    clearChain(presetNr);
    updateMenu();
    say("gamut_storage_organ: deleted preset " + presetNr +
        (_current !== null ? " (current is now " + _current + ")" : "") + "\n");
};

exports.deleteAll = function() {
    var slots = readIndex();
    for (var i = 0; i < slots.length; i++) {
        removeSlot(slots[i].nr);
        clearChain(slots[i].nr);
    }
    writeIndex([]);
    _current = null;
    persist();
    updateMenu();
    say("gamut_storage_organ: all presets deleted\n");
};

exports.updateMenu  = updateMenu;
exports.getSlotList = function() { return readIndex(); };

// ---- Stepping through the bank ----
// "Current" is whatever was last stored or recalled.  next/previous walk the STORED
// slots in order, not the raw numbers, so gaps in the numbering do not matter.
// They stop at the ends rather than wrapping: on stage you want a button that runs
// out, not one that silently jumps from the finale back to the opening.

/** getCurrent — the slot in play, or null when nothing has been recalled yet. */
exports.getCurrent = function() { return _current; };

/** recallCurrent — load the current preset again, undoing manual changes since. */
exports.recallCurrent = function() {
    if (_current === null) {
        say("gamut_storage_organ: no current preset\n");
        return;
    }
    exports.recall(_current);
};

exports.recallNext     = function() { stepPreset(+1); };
exports.recallPrevious = function() { stepPreset(-1); };

function stepPreset(direction) {
    var slots = readIndex();
    if (!slots.length) {
        say("gamut_storage_organ: bank is empty\n");
        return;
    }

    var idx = -1;
    for (var i = 0; i < slots.length; i++) {
        if (slots[i].nr === _current) { idx = i; break; }
    }
    // Nothing recalled yet: start just outside the bank so the first step lands on
    // the first slot going forwards, the last one going backwards.
    if (idx < 0) idx = (direction > 0) ? -1 : slots.length;

    var target = idx + direction;
    if (target < 0 || target >= slots.length) {
        say("gamut_storage_organ: already at the " +
            (direction > 0 ? "last" : "first") + " preset\n");
        return;
    }
    exports.recall(slots[target].nr);
}

// ================================================================================================
// GUIDED STORE — confirm an overwrite, then ask for the name
// ================================================================================================
// Max has no blocking dialog in JS, so the flow is a small state machine driven by
// a [dialog] object in the patcher.  Its answer comes back through fromDialog():
//
//   pressing slot N  →  storePrompt(N)
//        slot taken  →  mode 2, "Preset N: <name> überschreiben?"
//                       CANCEL → done      OK → name prompt
//        slot free   →  straight to the name prompt
//   name prompt      →  mode 0, text entry pre-filled with the existing name
//                       CANCEL → done      OK → store(N, text)
//
// PATCHER SETUP (created automatically if absent, like preset_menu):
//   [dialog @varname organ_dialog] → [prepend FromDialog] → the v8/js object
//
// [dialog] modes: 0 = text entry, 1 = message only, 2 = OK / Cancel.
// It answers with the entered text, or the symbol CANCEL when dismissed.

var _dialogObj = null;
var _pending   = null;   // {stage: "confirm"|"name", nr: N, name: "..."}

function findDialogObject() {
    if (_dialogObj) return _dialogObj;
    if (!_patcher) return null;

    var found = findNamed("organ_dialog");
    if (found) { _dialogObj = found; return found; }

    // A [dialog] the user placed by hand usually has no scripting name, so the
    // lookup above misses it and we would keep building another one beside it.
    // Adopt whatever dialog is already in the patcher instead.
    found = findByClass(_patcher, "dialog", 0);
    if (found) {
        try { found.varname = "organ_dialog"; } catch(e) {}   // findable next time
        _dialogObj = found;
        say("gamut_storage_organ: using the [dialog] already in the patcher\n");
        return found;
    }

    // Not there yet — build it and wire its answer back into the js object
    try {
        // varname is a BOX attribute; [dialog] rejects it as an object argument
        // ("dialog: \"varname\" is not a valid attribute argument"), so set it after.
        _dialogObj = _patcher.newdefault(20, 400, "dialog");
        if (!_dialogObj) return null;
        try { _dialogObj.varname = "organ_dialog"; } catch(e) {}
        var fwd = _patcher.newdefault(20, 430, "prepend", "fromDialog");
        if (fwd) {
            _patcher.connect(_dialogObj, 0, fwd, 0);
            if (_jsBox) _patcher.connect(fwd, 0, _jsBox, 0);
            else say("gamut_storage_organ: [dialog] built; connect [prepend FromDialog] " +
                     "to the js object by hand\n");
        }
        say("gamut_storage_organ: created [dialog organ_dialog]\n");
        return _dialogObj;
    } catch(e) {
        post("gamut_storage_organ: could not create the dialog object: " + e.message + "\n");
        return null;
    }
}

function openDialog(mode, label, defaultText) {
    var d = findDialogObject();
    if (!d) {
        post("gamut_storage_organ: no [dialog organ_dialog] in the patcher\n");
        return false;
    }
    try {
        d.setattr("mode", mode);
        d.setattr("label", label);
        // The text field keeps whatever the last dialog left in it, which shows up
        // under a confirm prompt as a stray leftover name.  Always set it: the entry
        // dialog gets its default, a confirm gets a blank.  A lone space rather than
        // "" because "symbol" with an empty argument is not a valid Max message.
        d.message("symbol", defaultText || " ");
        say("gamut_storage_organ: dialog opened (mode " + mode + ")\n");
        return true;
    } catch(e) {
        post("gamut_storage_organ: dialog failed: " + e.message + "\n");
        return false;
    }
}

/**
 * storePrompt — the interactive counterpart to store(): confirm, name, save.
 * Falls back to storing straight away when no dialog object can be made.
 */
exports.storePrompt = function(presetNr) {
    // No usable number given: ask for one, suggesting the lowest free slot.
    // NaN counts as absent — a caller that ran an empty argument through Number()
    // means "none given", not "given badly".
    if (presetNr === undefined || presetNr === null || presetNr === "" ||
        (typeof presetNr === "number" && isNaN(presetNr))) {
        _pending = { stage: "storenr" };
        if (!openDialog(0, "Store preset — which number?", String(lowestFreeSlot()))) {
            _pending = null;
        }
        return;
    }

    presetNr = Number(presetNr);
    if (isNaN(presetNr) || presetNr < 0) {
        post("gamut_storage_organ.storePrompt: invalid presetNr\n"); return;
    }
    if (presetNr === PERSIST_SLOT) {
        post("gamut_storage_organ.storePrompt: slot " + PERSIST_SLOT + " is reserved\n"); return;
    }

    var existing = null;
    readIndex().forEach(function(s) { if (s.nr === presetNr) existing = s.name; });

    if (existing) {
        _pending = { stage: "confirm", nr: presetNr, name: existing };
        if (!openDialog(2, "Overwrite preset " + presetNr + ": \"" + existing + "\"?", "")) {
            _pending = null;
            exports.store(presetNr, existing);   // no dialog available — just overwrite
        }
        return;
    }

    askForName(presetNr, "Preset " + presetNr);
};

// Lowest slot number not in use, so the number prompt suggests something sensible
function lowestFreeSlot() {
    var taken = {};
    readIndex().forEach(function(s) { taken[s.nr] = true; });
    for (var n = 1; n < PERSIST_SLOT; n++) {
        if (!taken[n]) return n;
    }
    return 1;
}

function askForName(presetNr, defaultName) {
    _pending = { stage: "name", nr: presetNr, name: defaultName };
    if (!openDialog(0, "Name for preset " + presetNr, defaultName)) {
        _pending = null;
        exports.store(presetNr, defaultName);    // no dialog available — store unnamed
    }
}

/**
 * fromDialog — the [dialog] object's answer. Anything that is not CANCEL counts as
 * confirmation, which is also how the older gamut_storage.js read it.
 */
exports.fromDialog = function() {
    var args = Array.prototype.slice.call(arguments);

    // [dialog] answers with a "symbol <text>" message, so [prepend fromDialog]
    // hands us the selector as the first argument.  Left in place it ends up inside
    // the preset name ("symbol dodo") and hides the CANCEL reply behind it.
    if (args.length && String(args[0]) === "symbol") args = args.slice(1);

    var first = (args.length ? String(args[0]) : "");

    if (!_pending) return;                       // an answer we did not ask for

    if (first.toUpperCase() === "CANCEL") {
        say("gamut_storage_organ: cancelled\n");
        _pending = null;
        return;
    }

    var stage = _pending.stage;

    if (stage === "confirm") {                   // overwrite confirmed → ask the name
        askForName(_pending.nr, _pending.name);
        return;
    }

    if (stage === "name") {
        var nr   = _pending.nr;
        var text = args.join(" ").trim();
        _pending = null;
        exports.store(nr, text || ("Preset " + nr));
        return;
    }

    if (stage === "movefrom") {                  // which preset to move
        var src = parseInt(args.join(" ").trim(), 10);
        _pending = null;
        if (isNaN(src) || !loadSlotJson(src)) {
            post("gamut_storage_organ: no preset at slot " + args.join(" ") + "\n");
            return;
        }
        _pending = { stage: "moveto", from: src };
        if (!openDialog(0, "Move preset " + src + " to which number?", String(src))) {
            _pending = null;
        }
        return;
    }

    if (stage === "moveto") {                    // and where to
        var srcNr = _pending.from;
        var dst   = parseInt(args.join(" ").trim(), 10);
        _pending  = null;
        if (isNaN(dst)) {
            post("gamut_storage_organ: \"" + args.join(" ") + "\" is not a slot number\n");
            return;
        }
        exports.movePreset(srcNr, dst);          // re-uses the overwrite confirmation
        return;
    }

    if (stage === "move") {                      // target overwrite confirmed
        var from = _pending.from, to = _pending.nr;
        _pending = null;
        doMove(from, to);
        return;
    }

    if (stage === "storenr") {                   // which slot to store into
        var slot = parseInt(args.join(" ").trim(), 10);
        _pending = null;
        if (isNaN(slot) || slot < 0) {
            post("gamut_storage_organ: \"" + args.join(" ") + "\" is not a slot number\n");
            return;
        }
        exports.storePrompt(slot);               // on into confirm / name
        return;
    }

    if (stage === "storecurrent") {
        var curNr = _pending.nr, curName = _pending.name;
        _pending = null;
        exports.store(curNr, curName);
        return;
    }

    if (stage === "rename") {
        var renameNr = _pending.nr;
        var newName  = args.join(" ").trim();
        _pending = null;
        doRename(renameNr, newName);
        return;
    }

    if (stage === "clearone") {
        var victim = _pending.nr;
        _pending = null;
        exports.deletePreset(victim);
        return;
    }

    if (stage === "clearall1") {                 // asked once, ask again
        var count = _pending.count;
        _pending = { stage: "clearall2" };
        if (!openDialog(2, "Really? All " + count + " presets will be gone.\n" +
                           "This cannot be undone.", "")) {
            _pending = null;
        }
        return;
    }

    if (stage === "clearall2") {
        _pending = null;
        exports.deleteAll();
        return;
    }
};

// ================================================================================================
// MOVE AND CLEAR — both ask first, both go through the same dialog machinery
// ================================================================================================

/**
 * movePrompt — ask which preset to move, then where to.
 * Falls back to nothing when no dialog is available; use movePreset(from, to) then.
 */
exports.movePrompt = function() {
    var slots = readIndex();
    if (!slots.length) {
        say("gamut_storage_organ: no presets to move\n");
        return;
    }
    var suggestion = (_current !== null) ? _current : slots[0].nr;
    _pending = { stage: "movefrom" };
    if (!openDialog(0, "Move preset — which number?", String(suggestion))) {
        _pending = null;
    }
};

/**
 * movePreset — move slot <fromNr> to slot <toNr>, asking before overwriting.
 * The preset keeps its name; only its number changes.
 */
exports.movePreset = function(fromNr, toNr) {
    fromNr = Number(fromNr);
    toNr   = Number(toNr);
    if (isNaN(fromNr) || isNaN(toNr)) {
        post("gamut_storage_organ.movePreset: needs two slot numbers\n"); return;
    }
    if (fromNr === toNr) return;
    if (toNr === PERSIST_SLOT || fromNr === PERSIST_SLOT) {
        post("gamut_storage_organ.movePreset: slot " + PERSIST_SLOT + " is reserved\n"); return;
    }
    if (!loadSlotJson(fromNr)) {
        post("gamut_storage_organ.movePreset: no preset at slot " + fromNr + "\n"); return;
    }

    var occupant = null;
    readIndex().forEach(function(s) { if (s.nr === toNr) occupant = s.name; });

    if (occupant) {
        _pending = { stage: "move", from: fromNr, nr: toNr };
        if (!openDialog(2, "Overwrite preset " + toNr + ": \"" + occupant + "\"?", "")) {
            _pending = null;
            doMove(fromNr, toNr);                // no dialog available — just move
        }
        return;
    }
    doMove(fromNr, toNr);
};

function doMove(fromNr, toNr) {
    var json = loadSlotJson(fromNr);
    if (!json) return;

    var name = dictStr(_dataDict, "slot_" + fromNr + "_name") || ("Preset " + fromNr);

    _dataDict.replace("slot_" + toNr + "_json", json);
    _dataDict.replace("slot_" + toNr + "_name", name);
    removeSlot(fromNr);

    var slots = readIndex().filter(function(s) {
        return s.nr !== fromNr && s.nr !== toNr;
    });
    slots.push({ nr: toNr, name: name });
    writeIndex(sortedSlots(slots));

    updateMenu();
    highlightMenu(toNr);
    persist();
    clearChain(fromNr);
    renameChain(toNr, name);

    say("gamut_storage_organ: moved preset " + fromNr + " → " + toNr + " (\"" + name + "\")\n");
}

/**
 * storeCurrentPrompt — write the current registration back into the preset in play,
 * keeping its name.  One confirm, no name prompt: the preset already has a name and
 * this is the "I adjusted it, keep it" gesture.
 */
exports.storeCurrentPrompt = function() {
    if (_current === null) {
        say("gamut_storage_organ: no current preset — use storePrompt to pick a slot\n");
        return;
    }
    var name = dictStr(_dataDict, "slot_" + _current + "_name") || ("Preset " + _current);
    _pending = { stage: "storecurrent", nr: _current, name: name };
    if (!openDialog(2, "Update preset " + _current + ": \"" + name + "\"?", "")) {
        _pending = null;
        exports.store(_current, name);       // no dialog available — just write it
    }
};

/**
 * renameCurrentPrompt — rename the preset in play, pre-filled with its name.
 */
exports.renameCurrentPrompt = function() {
    if (_current === null) {
        say("gamut_storage_organ: no current preset to rename\n");
        return;
    }
    var name = dictStr(_dataDict, "slot_" + _current + "_name") || ("Preset " + _current);
    _pending = { stage: "rename", nr: _current };
    if (!openDialog(0, "Rename preset " + _current + ":", name)) {
        _pending = null;
    }
};

function doRename(presetNr, newName) {
    if (!loadSlotJson(presetNr)) {
        post("gamut_storage_organ: no preset at slot " + presetNr + "\n");
        return;
    }
    newName = String(newName || "").trim() || ("Preset " + presetNr);

    _dataDict.replace("slot_" + presetNr + "_name", newName);

    // The stored preset carries its own name field; keep the two from drifting apart
    try {
        var preset = JSON.parse(loadSlotJson(presetNr));
        preset.name = newName;
        _dataDict.replace("slot_" + presetNr + "_json", JSON.stringify(preset));
    } catch(e) { /* unparseable blob — the index name is what the UI shows anyway */ }

    var slots = readIndex();
    slots.forEach(function(s) { if (s.nr === presetNr) s.name = newName; });
    writeIndex(slots);

    updateMenu();
    highlightMenu(presetNr);
    persist();
    renameChain(presetNr, newName);

    say("gamut_storage_organ: renamed preset " + presetNr + " to \"" + newName + "\"\n");
}

/**
 * clearCurrentPrompt — delete the preset in play, after naming it.
 */
exports.clearCurrentPrompt = function() {
    if (_current === null) {
        say("gamut_storage_organ: no current preset to clear\n");
        return;
    }
    var name = dictStr(_dataDict, "slot_" + _current + "_name") || ("Preset " + _current);
    _pending = { stage: "clearone", nr: _current };
    if (!openDialog(2, "Delete preset " + _current + ": \"" + name + "\"?", "")) {
        _pending = null;
        post("gamut_storage_organ: clear needs the dialog object — nothing deleted\n");
    }
};

/**
 * clearAllPrompt — wipe the whole bank.  Asked twice: the first prompt can be
 * dismissed by reflex, the second one cannot.
 */
exports.clearAllPrompt = function() {
    var n = readIndex().length;
    if (n === 0) {
        say("gamut_storage_organ: nothing to clear\n");
        return;
    }
    _pending = { stage: "clearall1", count: n };
    if (!openDialog(2, "Delete all " + n + " presets?", "")) {
        _pending = null;
        post("gamut_storage_organ: clearAll needs the dialog object — not cleared\n");
    }
};

// ---- Menu update ----

// Find an object by scripting name at, below, or above _patcher.
//
// getnamed() only sees its own level, so once the menu is moved into a bpatcher —
// a presetControl panel, say — a plain lookup stops finding it.  This descends into
// bpatchers and subpatchers too, then tries each parent level in turn.
// (Mirrors common.findNamedDeep; kept local so this module stays self-contained.)
function findNamedDeep(patcher, varname, depth) {
    if (!patcher || !varname) return null;
    depth = depth || 0;
    if (depth > 6) return null;                  // bounded: patchers can nest by reference

    try {
        var direct = patcher.getnamed(varname);
        if (direct) return direct;
    } catch(e) { return null; }

    var obj = patcher.firstobject;
    while (obj) {
        var sub = null;
        try { sub = (typeof obj.subpatcher === "function") ? obj.subpatcher() : null; }
        catch(e) { sub = null; }
        if (sub) {
            var found = findNamedDeep(sub, varname, depth + 1);
            if (found) return found;
        }
        obj = obj.nextobject;
    }
    return null;
}

// First object of a given class at or below `patcher`.  Same walk as findNamedDeep,
// matching the class rather than the scripting name.
function findByClass(patcher, cls, depth) {
    if (!patcher || depth > 6) return null;
    var obj = patcher.firstobject;
    while (obj) {
        try { if (String(obj.maxclass) === cls) return obj; } catch(e) {}
        var sub = null;
        try { sub = (typeof obj.subpatcher === "function") ? obj.subpatcher() : null; }
        catch(e) { sub = null; }
        if (sub) {
            var hit = findByClass(sub, cls, depth + 1);
            if (hit) return hit;
        }
        obj = obj.nextobject;
    }
    return null;
}

function findNamed(varname) {
    var p = _patcher;
    while (p) {
        var found = findNamedDeep(p, varname, 0);
        if (found) return found;
        p = p.parentpatcher;
    }
    return null;
}

function findPresetMenu() {
    if (_presetMenu) return _presetMenu;
    if (!_patcher) return null;
    var m = findNamed("preset_menu");
    if (m) _presetMenu = m;                      // cache it; the search is not free
    return m;
}

function findPattrstorage() {
    if (!_patcher) return null;
    return findNamed("storage");
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
    say("gamut_storage_organ: updateMenu OK — " + slots.length + " slot(s): " + names[0] + "\n");
}

// Show which preset is live, everywhere it is displayed.
//
// "set" moves a widget WITHOUT making it output, which is the whole point here:
// the menu may itself have started this recall, and a number box that fired back
// would recall again.  Any of these that exist are updated; none is required.
//
//   preset_menu       live.menu listing the bank
//   preset_recall_nr  number box holding the recall slot
//   preset_store_nr   number box holding the store slot
function highlightMenu(presetNr) {
    var slots = readIndex();
    var idx   = -1;
    for (var i = 0; i < slots.length; i++) {
        if (slots[i].nr === presetNr) { idx = i; break; }
    }

    var menu = findPresetMenu();
    if (menu && idx >= 0) {
        try { menu.message("set", idx); } catch(e) {}
    }

    ["preset_recall_nr", "preset_store_nr"].forEach(function(vn) {
        var box = findNamed(vn);
        if (box) { try { box.message("set", presetNr); } catch(e) {} }
    });

    // And out of the status outlet, for anything wired by hand
    if (_statusOut) _statusOut(presetNr, slots[idx] ? slots[idx].name : "");
}

/** setStatusHandler — Universal.js passes a function that reports the current preset. */
exports.setStatusHandler = function(fn) { _statusOut = fn; };

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

// Renaming the rack chains after presets is switched OFF for now — turn it back on
// with [message presetChainNaming 1] once the rack layout is settled.
var _chainRenaming = false;

/** setChainRenaming — 1 makes stores/renames relabel the MIDI rack chains. */
exports.setChainRenaming = function(on) {
    _chainRenaming = Boolean(Number(on));
    say("gamut_storage_organ: rack chain naming " + (_chainRenaming ? "on" : "off") + "\n");
};

function renameChain(nr, name) {
    if (!_chainRenaming) return;
    if (!chainExists(nr)) return;
    try {
        _api.set("name", "p " + nr + ": " + name);
        _api.set("color", 100);
    } catch(e) { /* rack disappeared between check and set */ }
}

function clearChain(nr) {
    if (!_chainRenaming) return;
    if (!chainExists(nr)) return;
    try {
        _api.set("name", "--");
        _api.set("color", 1);
    } catch(e) { /* chain may not exist */ }
}

post("gamut_storage_organ.js v00.17 loaded\n");
