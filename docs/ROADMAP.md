# Roadmap — Organ Control System

Stand: 30.08.2026, nach dem Probenstand `probe-2026-08-31`.
Aufwände sind Schätzungen für Umsetzung **plus** eine Testrunde in Live.

---

## Wo wir stehen

Der Probenstand läuft auf beiden Rechnern. Was heute repariert wurde:

| | |
|---|---|
| Skriptpfad brach bei Ordnerpfad ohne Dateiname | `b74bda9` |
| `live.thisdevice` vervielfachte sich bei jedem Laden | `905c24a`, `04c23b7`, `ddc39f9` |
| Orgel lud, bevor der MIDI-Port stand | `ca8fe71`, `92e55ec` |
| Orgelpfad absolut → zweiter Rechner tot | `cb283de` |
| Leere Bank überschrieb gespeicherte Presets | `1eb6637` |
| Clip entstand nicht auf leerer Arrangement-Stelle | `9969793` |
| `clearGUI` löschte den Preset-Dict | `036bca6` |
| Menü lud leer | `b3070f6` |

Gemeinsames Muster: **kein einziger Logikfehler.** Alle lagen an der Grenze zu
Max und Live — Pfade, Ladereihenfolge, Objektlebensdauer, Dateiorte. Das ist
die Stelle, an der die Arbeit ansetzen muss.

---

## 1 — Funktionstests (deine Punkte)

### 1.1 Verschiedene Orgelsysteme durchprobieren
**½–1 Tag.** Note-per-Stop läuft. Ungetestet in echt: Laukhuff-Programmwechsel
(ungerade = an, gerade = aus), Casavant mit zwei getrennten CCs, SysEx-Gesamtzustand.
Jeweils Registrierung setzen, Cancel, Preset-Recall, Panic prüfen.
*Braucht Zugang zu den Konsolen oder einen Monitor auf der Gegenseite.*

### 1.2 Umschalten SINUA ↔ MIDI
**½ Tag.** Der Wechsel läuft über `clearGUI` + Neuladen. Zu prüfen: bleiben
Presets erhalten, wird der Dict nicht mitgerissen, überleben Div-Zustände den
Wechsel, hängen keine Listener aus dem alten Modul nach.
*Risiko: `organTool_SINUA.js` ist seit dem MIDI-Zweig nicht mehr angefasst worden.*

### 1.3 Unite-Version
**1–2 Tage**, je nachdem, was „unite" umfassen soll. Vorher zu klären: eine
gemeinsame Fassung für beide Systeme, oder ein gemeinsamer Kern mit zwei
Aufsätzen? Der zweite Weg ist der, auf den die Faktorisierung (Abschnitt 3)
ohnehin zuläuft.

---

## 2 — Weitergabe an andere

### 2.1 GUI und Storage von der Generierung entkoppeln
**3–5 Tage.** Aktuell erzeugt das Tool seine Oberfläche zur Laufzeit per
Scripting in den Patcher. Das ist der Grund für fast jede Fragilität, die heute
aufgetreten ist: erzeugte Objekte, die gelöscht werden müssen, `clearGUI` mit
Behalte-Listen, Objekte die sich vervielfachen, Positionen als Identität.

Sinnvolle Trennung:

- **Generator** — liest die Orgel-JSON, erzeugt die Oberfläche (bleibt wie heute)
- **Laufzeit** — feste Oberfläche, liest ihren Zustand aus einer Datei

Für die Weitergabe zählt nur die Laufzeit. Wer eine neue Orgel einrichtet,
benutzt einmal den Generator; alle anderen bekommen ein Device, das nichts an
sich selbst verändert. Das macht es auch signierbar und einfrierbar.

### 2.2 Einrichtungs-Dokumentation
**½ Tag.** Heute steckt das Patcher-Setup als Kommentar im Kopf von
`gamut_storage_organ.js` — und genau deshalb fehlte der `[dict gamut_preset_bank]`
monatelang. Was hineingehört: die benötigten Objekte, `parameter_enable` am Dict,
pattrstorage-Konfiguration, Verkabelung von Outlet 0 und 1, ipMIDI-Einrichtung.

### 2.3 VST / Touch-Geräte
**Größenordnung Wochen, nicht Tage.** Max for Live ist die Klammer, die heute
alles zusammenhält: Patcher-Scripting, LOM, pattrstorage, `live.*`-Objekte. Nichts
davon existiert außerhalb. Realistische Zwischenstufe: die Orgel-Logik von der
Max-Schicht trennen (Abschnitt 3), dann steht sie als reines JavaScript da und
kann später hinter einer anderen Oberfläche laufen — Web/Touch wäre dann der
kürzere Weg als VST.
*Erst nach 3.1 sinnvoll anzugehen.*

---

## 3 — Struktur

### 3.1 Live-Handwerk als eigene Module herauslösen
**2–3 Tage.** `organTool_Universal.js` hat **2012 Zeilen, 93 Funktionen und
25 globale Variablen** und macht fünfzehn unzusammenhängende Dinge. Diese fünf
wissen nichts von Orgeln und gehören heraus:

| Modul | heute |
|---|---|
| Track-Routing → multichanmidiout | ~150 Zeilen, 7 Flags in Universal |
| Rack-Chain-Umbenenner | in Universal |
| Boot-Guard („nichts feuern beim Laden") | in Universal **und** MIDI |
| Portabler Projektpfad | in Universal |
| Storage (pattrstorage + Datei) | getrennt, aber orgelspezifisch benannt |

Danach in jedem anderen M4L-Device wiederverwendbar, und ihre Fehler können sich
nicht mehr gegenseitig stören. **Nicht** weiter aufteilen: MIDI/SINUA-Module,
Geometry, DataLayer — da bringt Trennung nichts.

### 3.2 Smoke-Test für die Ladereihenfolge
**1 Tag.** Ich habe die Ladereihenfolge heute **sechsmal** ad hoc gegen Stubs
getestet. Als fester Test im Repo hätte er den Reihenfolgefehler gefunden,
bevor er auf Rechner 2 auftrat. Läuft in Node, ohne Max.

Abzudecken: Bootreihenfolge (Port vor GUI), Preset-Wiederherstellung mit leerer
und gefüllter Bank, Pfadumsetzung zwischen Rechnern, `clearGUI`-Behalteregeln,
Clip-Erzeugung in allen fünf Modi.

### 3.3 `clearGUIObjects` umdrehen
**½ Tag.** Die Funktion löscht **alles mit einem `varname`**, das nicht
ausdrücklich auf der Behalte-Liste steht. Genau so verschwand der Preset-Dict,
sobald Max ihm einen eigenen Scripting-Namen gab. Heute symptomatisch geflickt
(Klassenregeln + `organ_`-Präfix), aber die Logik gehört umgedreht: nur
entfernen, was der Generator selbst angelegt hat — mit einer geführten Liste
statt einer Namensheuristik.

### 3.4 Toten Code im ProtocolLayer entfernen
**1–2 Std.** `organTool_ProtocolLayer.js:335–360` hat den eigentlichen Sendeblock
auskommentiert („In real implementation:") und loggt nur. Daher stammt
`MIDI note: Ch1 Note160 Vel0` — eine Note, die es als MIDI gar nicht gibt und
die nie gesendet wird. Der Pfad verdoppelt das Log-Volumen bei jedem Recall
(100 Stops → ~600 Zeilen) und hat mich heute selbst kurz auf eine falsche Fährte
geführt. Entweder implementieren oder löschen.

---

## 4 — Robustheit

### 4.1 Backup-Datei pro Set
**2–3 Std.** `js/gamut_organ_presets.json` ist **eine Datei für alle Sets** und
über Drive auch für beide Rechner. Seit dem Dict-Fix nur noch Fallback, aber ein
neues Set erbt weiterhin, was zuletzt irgendwo gespeichert wurde. Lösung: eine
versteckte `live.numbox` mit zufälliger Instanz-Nummer, die Live pro Instanz im
Set mitspeichert; Datei heißt dann `gamut_organ_presets_<nr>.json`.
*Bewusst offen lassen, wenn du den Übertragungsweg zwischen Sets behalten willst.*

### 4.2 Hot-Plug bei multichanmidiout
**2–4 Std** (C, Neubau des Externals). `MIDIClientCreate(..., NULL, NULL, ...)` —
kein Notify-Callback, das External merkt neue Interfaces nicht von selbst.
Außerdem irreführend: `port '…' not found — send 'ports' to refresh list`, denn
`find_endpoint_by_name` liest ohnehin frisch aus CoreMIDI; ein `ports` hilft dort
gar nicht.

### 4.3 Preset-Recall bündeln
**½ Tag.** Ein Recall schickt heute **100 Einzelnachrichten in ~50 ms**. Auf
ipMIDI heute unauffällig, auf einer echten Traktur mit langsamerem Eingang aber
ein Kandidat für verschluckte Register. Zu prüfen: Bündelung, SysEx-Gesamtzustand
wo verfügbar, oder eine einstellbare Verzögerung zwischen Registern.

### 4.4 Doppelte Device-Instanziierung dokumentieren
**1 Std.** Live instanziiert das Device beim Laden zweimal; die erste Instanz
wird verworfen, bevor ihr 400ms-Task feuert. Harmlos, aber es verdoppelt jeden
Log und hat heute mehrere Stunden Diagnose gekostet. Entweder unterdrücken oder
im Log als solches kennzeichnen.

### 4.5 Fehlerpfade beim Laden
**½ Tag.** Was passiert bei fehlender Orgel-JSON, kaputtem JSON, fehlendem
`multichanmidiout`, fehlendem pattrstorage? Teilweise abgefangen, nirgends
systematisch geprüft.

---

## 5 — Reihenfolge

| Priorität | Punkte | warum |
|---|---|---|
| **Sofort nach der Probe** | 1.1, 1.2 | ungetestete Systeme sind das größte Risiko |
| **Danach** | 3.4, 3.2, 4.1 | billig, und 3.2 sichert alles Weitere ab |
| **Der eigentliche Umbau** | 3.1, 3.3, 2.1 | in dieser Reihenfolge, jeweils mit Test |
| **Wenn das steht** | 1.3, 2.2, 4.2–4.5 | |
| **Langfristig** | 2.3 | erst sinnvoll, wenn 3.1 und 2.1 stehen |

**Gesamt bis „solide und weitergebbar": rund 10–15 Arbeitstage**, verteilbar.
Bis „andere können es installieren und benutzen" (durch 2.1 + 2.2): etwa 6–8 Tage.

---

## Auf Pro-Level in einem Satz

Trenne das Live-Handwerk von der Orgel-Logik und leg einen automatischen Test
unter die Ladereihenfolge — dann hört das Verifizieren von Änderungen auf, eine
Probe zu sein.
