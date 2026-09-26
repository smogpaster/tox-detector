# Kommunikations-Spiegel – Plan (Stand 2026-09-26)

App für Even Realities G2 + R1-Ring. Dieses Dokument ist der Vorschlag für Architektur,
Dienste und Dateistruktur. Implementierung beginnt erst nach Freigabe.

## 1. Was ich über die Plattform verifiziert habe

Quellen: hub.evenrealities.com/docs (Device APIs, Display, Networking, Background &
Lifecycle, Simulator, FAQ, Changelog), npm-Pakete `@evenrealities/even_hub_sdk@0.0.16`
(inkl. `index.d.ts`), `@evenrealities/evenhub-simulator@0.9.5`, `@evenrealities/evenhub-cli`,
GitHub `even-realities/evenhub-templates` (ASR-Template, vollständig gelesen).

Bestätigt:
- Apps sind Web-Apps (Vite + TS), laufen in der WebView der Even App, Brille = Display + Eingabe per BLE.
- `bridge.audioControl(true|false, source?)`, PCM kommt über `onEvenHubEvent` → `event.audioEvent.audioPcm`
  als `Uint8Array`, 16 kHz, s16le, mono. Simulator liefert 100 ms pro Event (3200 Byte).
- Display 576×288 px pro Auge, 16 Graustufen grün. Text: max. 1000 Zeichen beim Erstellen,
  2000 bei `textContainerUpgrade`, keine Schriftgrößen-API, Updates müssen gedrosselt werden (BLE-Queue).
- Gesten (Bügel und Ring): Click, Double Click, Scroll up/down, Long Press, Long Press Release.
  Ring ist über `EventSourceType.TOUCH_EVENT_FROM_RING` (2) unterscheidbar.
- Netzwerk: fetch/XHR/WebSockets erlaubt, `app.json` braucht `network`-Whitelist mit exakten Origins,
  Produktion nur HTTPS/WSS, HTTP nur für LAN-Dev-Server.
- Hintergrund: Auf iOS läuft die WebView weiter, Audio stoppt nur bei Suspendierung.

Abweichungen von deiner Beschreibung:
- Ein npm-Paket `everything-evenhub` gibt es nicht. Die Templates liegen unter
  github.com/even-realities/evenhub-templates (Ordner `asr/`), Simulator und CLI sind eigene Pakete.
- `audioControl` hat einen zweiten Parameter `AudioInputSource.Glasses | Phone`.
- Seit SDK 0.0.14 hat `AudioEvent` zusätzlich `direction` (roher int16-Richtungstag der Brille)
  und `speakerRole` (`self | other | unknown`, „App-Algorithmus, keine Firmware-Garantie“).
  Das ist für unser Sprechertrennungsproblem der wichtigste Hebel (siehe Abschnitt 5).
- Der Simulator kann keine Audiodateien einspeisen, nur ein Live-Mikrofon des Macs.
  Für den Diarization-Test brauchen wir daher eine eigene Bench-Pipeline am Simulator vorbei.
- Das ASR-Template legt den API-Key als `VITE_STT_API_KEY` in den Client. Das übernehmen wir nicht.

Nicht dokumentiert, muss auf echter Hardware getestet werden (Unsicherheit markiert):
- Maximale Aufnahmedauer / automatisches Abschalten des Mikrofons.
- Ob Brillen- und Handymikro gleichzeitig offen sein können.
- Genaue Semantik von `direction` und Qualität von `speakerRole`. Im Simulator kommen beide
  vermutlich als `null` / `unknown`.
- Ob Long Press vom Ring als `sysEvent` oder `textEvent` ankommt (wir behandeln beides).

## 2. Architektur

```
 G2 + R1 ── BLE ── Even App (iPhone, WebView)              Mac / Server (Node 22)
                    apps/glasses (Vite+TS)                 apps/server (TS)
                    ├ Session-Statemachine   ── WS ──►     ├ Session-Manager
                    ├ Gesten (Ring/Bügel)     PCM-Frames    ├ STT-Adapter (Soniox EU, alt. Deepgram EU)
                    ├ audioControl / PCM      + Meta        ├ Sprecher-Fusion (Diarization × speakerRole)
                    ├ Brillen-Display         ◄── WS ──     ├ Utterance-Builder (Turns, Pausen, Overlaps)
                    └ Companion-UI (Handy)    Transkript,   ├ Analyse-Worker (Claude API, JSON-Schema)
                                              Hinweise      ├ Hint-Policy (Ratenlimit, neutral)
                                                            ├ Report-Generator (Claude API) → HTML
                                                            └ Optionaler lokaler Transkript-Store + Löschen
```

Grundsätze:
- Alle API-Keys (STT, Anthropic) nur im Server. Der Client kennt nur die WS-URL des eigenen Servers.
- Rohaudio wird nirgends geschrieben: Client → WS → STT-WebSocket, nur im Arbeitsspeicher durchgereicht.
- Der Server ist ein Prozess ohne Datenbankpflicht. Transkripte sind standardmäßig nur im RAM und
  weg, wenn die Session endet. Optional (`PERSIST_TRANSCRIPTS=true`) als JSON unter `data/sessions/`,
  mit Lösch-Endpunkt und Lösch-Button in der Nachbetrachtung.
- Ein Session-Protokoll (`packages/shared`) als typisierte Nachrichten in beide Richtungen.

Entwicklung: Server läuft auf dem MacBook, Client per Vite. Simulator: `localhost`.
Echte Brille: iPhone im selben WLAN, Client `http://<mac-ip>:5173`, WS `ws://<mac-ip>:8787`
(HTTP ist im Dev erlaubt). Für späteren Betrieb außerhalb des WLANs braucht der Server WSS
(kleiner EU-Host oder Tailscale). Netlify (in dieser Umgebung verbunden) eignet sich für die
statische Client-App, aber nicht für den WebSocket-Server.

## 3. Session-Ablauf und Einwilligung

Zustände: `idle → consent_pending → active → finishing → report`.

1. **idle**: Brille zeigt „Spiegel bereit · Ring lang drücken zum Start“. Mikrofon aus.
2. **Long Press (Ring)** → Bestätigungsscreen: „Session starten? Click = ja · Double Click = nein“.
3. **consent_pending**: Mikrofon an, aber nur ein Zustimmungs-Detektor läuft. Display:
   „Warte auf Zustimmung: ‚Wir starten den Spiegel‘“. Audio geht zwar zur STT (anders ist die
   Phrase nicht erkennbar), aber es wird nichts analysiert oder gespeichert. Erkannt wird die
   Phrase (fuzzy) plus eine Bestätigung eines zweiten Sprechers („ja“, „einverstanden“, oder die
   Phrase erneut). Timeout 45 s → zurück zu idle, Mikrofon aus.
   Ehrliche Einschränkung: Die Zuordnung „zweiter Sprecher“ hängt an der Diarization und kann in
   den ersten Sekunden falsch liegen. Deshalb zusätzlich: Click auf dem Ring bestätigt manuell.
4. **active**: Erste Zeile des Displays dauerhaft `● SPIEGEL AKTIV  12:34`. Darunter maximal ein
   neutraler Hinweis. Long Press → Ende (ohne Rückfrage, Beenden muss immer sofort gehen).
   Double Click → System-Exit-Dialog der Even App, dabei Mikrofon aus.
5. **finishing**: Mikrofon aus, STT-Stream geschlossen, Abschlussanalyse läuft (5–20 s).
6. **report**: Brille zeigt „Auswertung auf dem Handy bereit“. Companion-UI zeigt Bericht,
   mit Buttons „Transkript löschen“ / „Session löschen“.

## 4. Speech-to-Text: Vergleich und Empfehlung

Anforderung: Streaming, Deutsch, Sprechertrennung live, EU-Verarbeitung, PCM 16 kHz direkt.

| | Soniox (stt-rt) | Deepgram Nova-3 | AssemblyAI Universal-Streaming | Lokal: Whisper + pyannote |
|---|---|---|---|---|
| Deutsch | gut, wird explizit beworben | gut (nova-3 multilingual, `de`) | gut (Universal-3, 99+ Sprachen im Streaming) | sehr gut (large-v3), aber |
| Diarization im Streaming | ja, eingebaut, für alle Sprachen | ja, aber nur `diarize_model=v1` (v2 nur Batch) | ja, neu aufgewertet, Details je Sprache unklar | pyannote ist Offline-Batch, Echtzeit nur mit Bastelei |
| EU-Hosting | `wss://stt-rt.eu.soniox.com` | `wss://api.eu.deepgram.com/v1/listen` | `wss://streaming.eu.assemblyai.com/v3/ws` | vollständig lokal |
| Preis (Streaming) | ca. 0,12 $/h alles inklusive | ca. 0,46–0,58 $/h inkl. Diarization-Aufpreis | ca. 0,15 $/h (bitte selbst prüfen) | 0 $, aber M5 muss STT + Diarization + Claude-Vorverarbeitung stemmen |
| Latenz | niedrig (Token-Stream mit Zeitstempeln) | niedrig | niedrig | hoch (Fenster von mehreren Sekunden) |
| Erfahrung mit G2 | ja: nickustinov/stt-even-g2 nutzt genau diese Pipeline | keine bekannt | keine bekannt | — |

**Empfehlung: Soniox über den EU-Endpunkt**, mit Deepgram EU als zweitem Adapter hinter derselben
Schnittstelle. Gründe: Diarization ist im Streaming Standard und nicht ein älteres Zweitmodell,
Wort-Zeitstempel erlauben die Fusion mit `speakerRole`, EU-Endpunkt vorhanden, günstig, und es
existiert ein funktionierendes G2-Projekt damit. Was ich nicht selbst prüfen konnte: die reale
Deutsch-Qualität der drei Dienste auf Brillenaudio. Deshalb ist der Adapter austauschbar und die
Bench aus Abschnitt 5 läuft gegen beide Dienste.

Lokales Whisper empfehle ich vorerst nicht: Echtzeit-Diarization lokal ist das schwächste Glied,
und die Datenschutzanforderung ist mit EU-Verarbeitung ohne Speicherung beim Anbieter (Soniox und
Deepgram bieten Zero-Retention-Optionen an, bitte im jeweiligen Konto aktivieren) erfüllbar.

## 5. Das Lautstärkeproblem (Träger vs. Gegenüber)

Erwartung: Das Brillenmikro nimmt den Träger viel lauter auf. Reine Stimm-Diarization kann dann
leise Beiträge der Partnerin falsch dem Träger zuordnen oder als Rauschen verwerfen.

Plan in drei Stufen, gemessen statt geraten:

1. **Bench-Pipeline** (`tools/diarization-bench/`): streamt eine 16-kHz-Mono-WAV-Datei so an den
   STT-Adapter, als käme sie von der Brille, und vergleicht Sprecherlabels mit einer Referenz.
   Testmaterial: (a) synthetisch aus zwei getrennten Aufnahmen gemischt, Partnerin um 0 / −6 / −12 /
   −18 dB abgesenkt, (b) eine echte kurze Aufnahme mit der Brille. Für (b) braucht es einen
   Dev-Schalter, der ausnahmsweise PCM in eine Datei schreibt. Der ist ausschließlich in
   Entwicklungs-Builds vorhanden, standardmäßig aus, und im Display als „DEBUG-AUFNAHME“ markiert.
   Das mache ich nur mit deinem ausdrücklichen OK.
2. **Sprecher-Fusion im Server**: Pro PCM-Frame liefert die Brille `speakerRole` (self/other).
   Ich lege diese Frame-Labels auf die Wort-Zeitstempel der STT und lasse per Mehrheitsentscheid
   entscheiden. Damit wird die Diarization des Anbieters zu einem zweiten Signal statt zur einzigen
   Quelle. Zusätzlich: eigene Pegel- und Sprechpausen-Statistik pro Sprecher, um „Träger“ und
   „Gegenüber“ stabil zu benennen. Ob `speakerRole` gut genug ist, zeigt erst die Hardware.
3. **Falls beides nicht reicht**: sanfte Pegelanpassung im Server (Segment-AGC) vor der STT,
   Handymikro als zweite Quelle näher an der Partnerin (unklar, ob parallel möglich), oder
   Kalibrierung zu Session-Beginn („Jede Person sagt einen Satz“), aus der Stimmprofile für die
   Zuordnung abgeleitet werden.

## 6. Analyse mit der Claude API

- Modell: `claude-opus-5` mit adaptivem Denken und Structured Outputs (JSON-Schema), Streaming.
  Für Live-Fenster ist die Latenz zweitrangig, weil Hinweise ohnehin gedrosselt sind.
- **Fenster**: Der Utterance-Builder fasst STT-Tokens zu Redebeiträgen zusammen (Sprecher, Text,
  Start/Ende, Überlappung mit dem vorigen Beitrag, Pause davor, Silben pro Sekunde als Tempo).
  Alle ~8 Beiträge oder 60 s geht ein Fenster mit den zwei vorherigen Fenstern als Kontext an Claude.
- **Schema pro Fund**: `speaker`, `pattern`, `quote`, `utteranceId`, `intensity` (1–3),
  `reactsTo` (utteranceId, Beschreibung der Wechselwirkung), `evidence`.
  Muster: Gottman-Vier (Kritik, Verachtung, Rechtfertigung, Mauern), Eskalation, Unterbrechen,
  Sarkasmus, Pauschalisierung („immer/nie“), Vorwurf statt Ich-Botschaft, Gedankenlesen,
  Themenwechsel; positiv: Reparaturversuch, Validierung, Humor, Nachfragen, Ich-Botschaft, Pause
  annehmen. Der Systemprompt verlangt Symmetrie: beide Sprecher werden mit denselben Kriterien
  betrachtet, Interaktionen werden immer als Paar (Auslöser → Reaktion) beschrieben.
- **Live-Hinweise**: kommen nicht direkt aus der Sprachanalyse, sondern aus einer Hint-Policy:
  Tempo (aus Zeitstempeln), Überlappungen, Eskalationsfenster mit ≥2 Funden Intensität 3.
  Wortlaut nur neutral („Tempo steigt“, „Pause?“, „Viele Unterbrechungen“, „Guter Moment für
  eine Nachfrage“). Maximal ein Hinweis pro 90 s, Anzeige 8 s, nie Sprechernamen, nie Bewertungen.
- **Nachbetrachtung**: Gesamttranskript + alle Fenster-Funde → Report-JSON (Dynamik, Wendepunkte,
  drei konkrete, beidseitige Vorschläge, positive Momente) → HTML in der Companion-UI.
  Fester Hinweis: keine Diagnose, kein Ersatz für Paartherapie, beide Perspektiven gleichwertig.

## 7. Dateistruktur (npm workspaces)

```
tox-detector/
├─ package.json                 workspaces, gemeinsame Scripts (dev, bench, typecheck)
├─ docs/PLAN.md                 dieses Dokument
├─ packages/shared/             Protokolltypen (WS-Nachrichten), Utterance-/Analyse-Schemas (zod)
├─ apps/glasses/                Even-Hub-App (Vite + TS, aus dem ASR-Template abgeleitet)
│  ├─ app.json                  Permissions: g2-microphone, network (Server-Origin)
│  ├─ src/main.ts               Bootstrap, Bridge, Event-Routing
│  ├─ src/session.ts            Statemachine idle/consent/active/finishing/report
│  ├─ src/input.ts              Gesten-Normalisierung (CLICK=0-Falle, Ring vs. Bügel, Long Press)
│  ├─ src/display.ts            Brillen-Layout, Indikator, gedrosselte Updates
│  ├─ src/audio.ts              audioControl + Frame-Weiterleitung mit speakerRole/direction
│  ├─ src/transport.ts          WebSocket zum Server, Reconnect, localStorage-Recovery
│  └─ src/ui/                   Companion-UI: Status, Live-Transkript, Bericht, Löschen
├─ apps/server/
│  ├─ src/index.ts              HTTP + WS, Konfig aus .env (nur hier liegen Keys)
│  ├─ src/session/              SessionManager, UtteranceBuilder, SpeakerFusion
│  ├─ src/stt/                  SttAdapter-Interface, soniox.ts, deepgram.ts
│  ├─ src/analysis/             claude.ts (Fenster + Report), schemas.ts, prompts/*.md
│  ├─ src/hints/                Hint-Policy und Ratenlimit
│  ├─ src/store/                MemoryStore (Default), FileStore (opt-in), delete
│  └─ src/report/               HTML-Rendering der Nachbetrachtung
└─ tools/diarization-bench/     WAV → Adapter → Sprecherlabels vs. Referenz, Pegel-Varianten
```

## 8. Meilensteine

- **M1 Prototyp im Simulator** (umgesetzt 2026-09-26): Session-Statemachine mit Ring-Gesten,
  Bestätigungsscreen, PCM → Server → Soniox EU → Transkript mit Sprecherlabels auf Handy und Brille,
  Indikator, Beenden per Geste.
- **M2 Analyse** (umgesetzt 2026-09-26, ohne echten API-Key getestet): Utterance-Builder,
  Claude-Fenster mit JSON-Schema, Hint-Policy, Report-Seite, Löschfunktion. Mock-Modus für Demos.
- **M3 Hardware und Robustheit**: Test auf G2 (Aufnahmedauer, `speakerRole`, Long Press vom Ring,
  Lock-Screen 5 Minuten), Diarization-Bench mit echter Aufnahme, Sprecher-Fusion tunen,
  Deepgram-Adapter als Vergleich.

## 9. Entscheidungen (2026-09-26)

1. STT: Soniox über den EU-Endpunkt. Zusätzlich ein Fake-Adapter für Entwicklung ohne Key.
2. Dev-Schalter für PCM-Mitschnitt (Diarization-Bench): erlaubt, nur in Dev-Builds, standardmäßig aus.
3. Zustimmung: keine Phrasenerkennung. Start per Long Press plus Click-Bestätigung, der
   Bestätigungsscreen erinnert daran, dass beide Personen einverstanden sein müssen.
   Der Zustand `consent_pending` aus Abschnitt 3 entfällt damit.
4. Transkripte werden standardmäßig gespeichert (JSON, lokal), abschaltbar, mit Löschfunktion.
5. Sprache: Hochdeutsch (`language_hints: ["de"]`, strikt).
6. Betrieb außerhalb des WLANs ist geplant. Der Server ist ein einzelner Node-Prozess ohne
   Datenbank und lässt sich hinter TLS auf einem kleinen EU-Host betreiben; das wird in M3 eingerichtet.
