# Manual Test Sequences

## 1. Load SINUA Organ
1. Call `loadOrgan("path/to/sinua.json")`
2. Expected: divisions rendered, stops visible
3. Check: `displaySystemStatus()` shows type=SINUA, loaded=true

## 2. Load MIDI Organ
1. Call `loadOrgan("path/to/midi.json")`
2. Expected: manuals rendered, MIDI channels assigned
3. Check: `displaySystemStatus()` shows type=MIDI, loaded=true

## 3. Stop Toggle
1. Click a stop button in GUI
2. Expected: OSC /stop/<id> 1 sent (SINUA) or NoteOn (MIDI)
3. State: `g_organState.stops[id].state === true`

## 4. Preset Load
1. Save current state as preset "test"
2. Toggle stops to different state
3. Load preset "test"
4. Expected: stops return to saved state

## 5. Panic
1. Call `panic()`
2. Expected: all stops off, command queue empty

## 6. Protocol Reconnect
1. Disconnect SINUA/MIDI
2. Trigger a stop command
3. Expected: command queued, sent on reconnect
