// chaincache.js -- fuer [v8 chaincache.js] (Max 9)
//
// Cached die Chain-Namen des Racks und schreibt sie als fertig geparste
// OSC-Atome in ein [coll]. Der Notenpfad laeuft danach komplett in Max --
// dieses Script wird pro Note NICHT mehr angefasst.
//
// Chain-Name = OSC-Kommando, Tokens durch Leerzeichen getrennt:
//     /organ/stop1 <velo>   ->  mode 1 : /organ/stop1 <wert>
//     /organ/panic          ->  mode 0 : /organ/panic     (Wert ignoriert)
//     /organ/gain 0.5       ->  mode 0 : /organ/gain 0.5
//
// <velo> muss ein eigenes Token und das letzte sein.
// Chains mit Namen "" oder "--" werden aus dem coll entfernt.
//
// Inlet  0 : bang von [live.thisdevice] = init, "refresh" = manuell neu
// Outlet 0 : coll-Kommandos -> [coll chaincmds]
// Outlet 1 : Anzahl Chains (int), -1 bei Fehler

autowatch = 1;
inlets = 1;
outlets = 2;

var RACK_PATH   = "this_device canonical_parent devices 0";
var PARENT_PATH = "this_device canonical_parent";

var MODE_STATIC = 0;   // Atome ausgeben wie sie sind
var MODE_APPEND = 1;   // Wert hinten anhaengen

var chainObservers  = [];
var countObserver   = null;
var devicesObserver = null;
var chainSig        = "";
var deviceSig       = "";
var reinitTask      = null;
var ready           = false;

// ----------------------------------------------------------- Max-Interface

// [live.thisdevice] linker Outlet -- der einzige verlaessliche Zeitpunkt.
// loadbang() ist in M4L zu frueh, da ist der Live-API-Pfadbaum oft noch leer.
function bang() {
    ready = true;
    init();
}

function refresh() {
    init();
}

function dump() {
    post("chaincache: " + chainObservers.length + " Chains beobachtet, ready=" + ready + "\n");
}

function notifydeleted() {
    if (reinitTask) { reinitTask.cancel(); reinitTask = null; }
    clearObservers();
}

// ------------------------------------------------------------------ Aufbau

function init() {
    var rack, parent, count, i;

    clearObservers();
    if (!ready) return;

    rack = new LiveAPI(RACK_PATH);
    if (!rack || parseInt(rack.id) === 0)              return fail("kein Device unter " + RACK_PATH);
    if (parseInt(rack.get("can_have_chains")) !== 1)   return fail("Device 0 ist kein Rack");

    outlet(0, "clear");

    count = rack.getcount("chains");
    for (i = 0; i < count; i++) {
        chainObservers.push(makeNameObserver(i));
    }

    // Signaturen VOR dem Anlegen der Observer setzen: ein Live-API-Observer
    // feuert sofort beim Setzen von .property mit dem aktuellen Wert. Ohne
    // diesen Vergleich ruft sich init() endlos selbst auf.
    chainSig = rack.get("chains").join(",");
    countObserver = new LiveAPI(onChainsChanged);
    countObserver.path     = RACK_PATH;
    countObserver.property = "chains";

    // Faengt ab, wenn das Rack ersetzt oder verschoben wird.
    parent = new LiveAPI(PARENT_PATH);
    deviceSig = parent.get("devices").join(",");
    devicesObserver = new LiveAPI(onDevicesChanged);
    devicesObserver.path     = PARENT_PATH;
    devicesObserver.property = "devices";

    outlet(1, count);
}

function makeNameObserver(index) {
    var obs = new LiveAPI(function (args) {
        // Namen mit Leerzeichen kommen als mehrere Atome zurueck.
        if (args[0] === "name") storeChain(index, args.slice(1).join(" "));
    });
    obs.path     = RACK_PATH + " chains " + index;
    obs.property = "name";
    storeChain(index, obs.get("name").join(" "));   // falls Initial-Callback deferred
    return obs;
}

// ---------------------------------------------------------------- Observer

function onChainsChanged(args) {
    var sig;
    if (args[0] !== "chains") return;
    sig = args.slice(1).join(",");
    if (sig === chainSig) return;          // Initial-Callback / kein echter Change
    chainSig = sig;
    scheduleReinit();
}

function onDevicesChanged(args) {
    var sig;
    if (args[0] !== "devices") return;
    sig = args.slice(1).join(",");
    if (sig === deviceSig) return;
    deviceSig = sig;
    scheduleReinit();
}

// Raus aus dem Observer-Callback, bevor init() genau diesen Observer zerstoert.
function scheduleReinit() {
    if (!reinitTask) reinitTask = new Task(init, this);
    reinitTask.cancel();
    reinitTask.schedule(30);
}

function clearObservers() {
    var i;
    for (i = 0; i < chainObservers.length; i++) detach(chainObservers[i]);
    chainObservers  = [];
    countObserver   = detach(countObserver);
    devicesObserver = detach(devicesObserver);
}

function detach(api) {
    if (api) {
        api.property = "";
        api.id = 0;
    }
    return null;
}

// ------------------------------------------------------------------ Parser

function storeChain(index, rawName) {
    var entry = parseCommand(index, rawName);
    if (!entry) {
        outlet(0, ["remove", index]);
        return;
    }
    outlet(0, ["store", index, entry.mode].concat(entry.atoms));
}

function parseCommand(index, rawName) {
    var name, tokens, atoms, mode, i, t;

    name = (rawName === undefined || rawName === null) ? "" : String(rawName);
    name = name.replace(/^\s+|\s+$/g, "");
    if (name === "" || name === "--") return null;

    // [coll] benutzt ',' und ';' als Trenner -- solche Namen wuerden die
    // Datenbasis zerschiessen.
    if (name.indexOf(",") !== -1 || name.indexOf(";") !== -1) {
        warn(index, "',' und ';' kann [coll] nicht speichern", name);
        return null;
    }

    tokens = name.split(/\s+/);
    atoms  = [];
    mode   = MODE_STATIC;

    for (i = 0; i < tokens.length; i++) {
        t = tokens[i];

        if (t === "<velo>") {
            if (i !== tokens.length - 1) {
                warn(index, "<velo> muss das letzte Token sein", name);
                return null;
            }
            mode = MODE_APPEND;
            continue;
        }
        if (t.indexOf("<velo>") !== -1) {
            warn(index, "<velo> muss ein eigenes Token sein (nicht /a/<velo>/b)", name);
            return null;
        }
        // Zahlen als Zahlen ablegen, damit OSC sie als i/f typisiert.
        atoms.push(isNumericToken(t) ? parseFloat(t) : t);
    }

    if (atoms.length === 0) return null;
    return { mode: mode, atoms: atoms };
}

function isNumericToken(t) {
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t);
}

// ------------------------------------------------------------------- Fehler

function fail(msg) {
    post("chaincache: " + msg + "\n");
    outlet(0, "clear");
    outlet(1, -1);
}

function warn(index, msg, name) {
    post("chaincache: Chain " + index + " ignoriert -- " + msg + ": \"" + name + "\"\n");
}
