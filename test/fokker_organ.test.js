// Fokker organ as an instrument of the organ tool.
// Runs the real sendStopMIDI / sendPanicMIDI from js/organTool_MIDI.js against
// mapping/config/organ Fokker.json and checks them against the table in Fokker.sc:
//   stops: program change on MIDI channel 1, on = 2*i, off = 2*i + 1
//   keys:  Manual I = channels 1-3, Pedal = 4-6, Manual II = 7-9 (Methode 3)
// Run: node test/fokker_organ.test.js
var fs = require("fs"), path = require("path");
var root = path.join(__dirname, "..");
var src = fs.readFileSync(path.join(root, "js/organTool_MIDI.js"), "utf8");
var organ = JSON.parse(fs.readFileSync(path.join(root, "mapping/config/organ Fokker.json"), "utf8"));

function grab(name) {
    var i = src.indexOf("function " + name + "("), d = 0, started = false;
    if (i < 0) throw new Error("not found: " + name);
    for (var j = i; j < src.length; j++) {
        if (src[j] === "{") { d++; started = true; }
        else if (src[j] === "}") { d--; if (started && d === 0) return src.slice(i, j + 1); }
    }
}
var sent = [];
var organState = {
    stopSystem: organ.midi.stopSystem, panicMethod: organ.midi.panicMethod,
    outputFormat: "named", panicsByManual: {}
};
var ctx = {
    organState: organState,
    stopChannelFor: function (stop) { return stop.stopChannel || 1; },
    emitProgram: function (ch, p) { sent.push(["pc", ch, p]); },
    emitNote: function (ch, n, v) { sent.push(["note", ch, n, v]); },
    emitCC: function (ch, c, v) { sent.push(["cc", ch, c, v]); },
    emitControl: function () { sent.push(["control"]); },
    describePanics: function () { return ""; },
    common: { LOG_LEVEL: { INFO: 0, VERBOSE: 1 }, log: function () {} }
};
var api = new Function(Object.keys(ctx).join(","),
    grab("sendStopMIDI") + "\n" + grab("sendPanicMIDI") +
    ";return {sendStopMIDI: sendStopMIDI, sendPanicMIDI: sendPanicMIDI};")
    .apply(null, Object.keys(ctx).map(function (k) { return ctx[k]; }));

var passed = 0, failed = 0;
function ok(desc, cond) { if (cond) passed++; else failed++; console.log((cond ? "ok   " : "FAIL ") + desc); }

// --- stops: the table from Fokker.sc -----------------------------------------
var SC = ["subbas", "gedekt", "pI", "pII", "quintaden", "prestant", "iII", "salicionaal", "roerfluit"];
ok("nine stops, as in Fokker.registerNames", organ.stops.length === SC.length);
var allRight = true;
organ.stops.forEach(function (s, i) {
    var stop = { stopID: s.stopID, programOn: s.programOn, programOff: s.programOff, stopChannel: 1 };
    sent = []; api.sendStopMIDI(stop, true); api.sendStopMIDI(stop, false);
    var good = sent.length === 2 &&
        sent[0].join() === ["pc", 1, 2 * i].join() && sent[1].join() === ["pc", 1, 2 * i + 1].join();
    if (!good) { allRight = false; console.log("     " + s.name + ": " + JSON.stringify(sent)); }
});
ok("every stop: program 2*i on, 2*i+1 off, on channel 1", allRight);
sent = []; api.sendStopMIDI({ programOn: 0, programOff: 1, stopChannel: 1 }, true);
ok("program 0 (Subbas on) is sent, not swallowed as falsy", sent.length === 1 && sent[0][2] === 0);
ok("couplers marked: P+I, P+II, I+II",
    organ.stops.filter(function (s) { return s.type === "coupler"; })
         .map(function (s) { return s.name; }).join() === "P+I,P+II,I+II");

// --- manuals: three key channels each -----------------------------------------
var want = { 1: [1, 2, 3], 2: [7, 8, 9], 8: [4, 5, 6] };
ok("key channels match Methode 3", organ.manuals.every(function (m) {
    return m.midiChannels.join() === want[m.manualID].join();
}));
ok("the module reads midiChannels and noteRange",
    src.indexOf("m.midiChannels.map(Number)") > 0 && src.indexOf("m.noteRange[0]") > 0);

// --- panic: note-offs on all three channels, inside the compass ------------------
organ.manuals.forEach(function (m) {
    sent = []; api.sendPanicMIDI(m);
    var chans = {}, lo = 999, hi = -1;
    sent.forEach(function (x) { chans[x[1]] = 1; lo = Math.min(lo, x[2]); hi = Math.max(hi, x[2]); });
    var n = (m.noteRange[1] - m.noteRange[0] + 1) * 3;
    ok("panic " + m.name + ": " + n + " note-offs on channels " + m.midiChannels.join("+"),
        sent.length === n && Object.keys(chans).join() === m.midiChannels.join() &&
        lo === m.noteRange[0] && hi === m.noteRange[1] &&
        sent.every(function (x) { return x[0] === "note" && x[3] === 0; }));
});

// --- an ordinary organ is untouched -------------------------------------------------
sent = []; api.sendPanicMIDI({ name: "plain", midiChannel: 5 });
ok("a manual without midiChannels still sweeps its one channel, 128 notes",
    sent.length === 128 && sent.every(function (x) { return x[1] === 5; }));
organState.panicMethod = "cc123"; sent = [];
api.sendPanicMIDI({ name: "plain", midiChannel: 5 });
ok("cc123 method unchanged for an ordinary manual: CC123 then CC120 on its channel",
    sent.join() === [["cc", 5, 123, 0], ["cc", 5, 120, 0]].join());
sent = []; api.sendPanicMIDI({ name: "three", midiChannels: [1, 2, 3] });
ok("cc123 method on three channels: both controllers on each, no channel NaN",
    sent.length === 6 && sent.every(function (x) { return x[1] >= 1 && x[1] <= 3; }));

console.log("\n" + passed + " passed" + (failed ? ", " + failed + " FAILED" : ""));
process.exit(failed ? 1 : 0);
