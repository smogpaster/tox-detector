# Kommunikations-Spiegel

App für die Even Realities G2 (mit R1-Ring), die ein bewusst gestartetes Gespräch zwischen zwei
Personen transkribiert und später auf Kommunikationsmuster hin auswertet. Beide Gesprächspartner
werden immer gleichwertig betrachtet. Die App sucht keinen Schuldigen, sie macht Muster und
Wechselwirkungen sichtbar. Sie stellt keine Diagnosen und ersetzt keine Paartherapie.

Architektur, Dienstevergleich und offene Punkte: [`docs/PLAN.md`](docs/PLAN.md).

## Stand

Meilenstein 1 (Prototyp) und Meilenstein 2 (Analyse) sind umgesetzt, aber noch nicht auf echter
Hardware und noch nicht mit echten API-Keys getestet:

- Session starten und beenden per Ring-Geste, dauerhafter Aufnahme-Indikator auf der Brille
- Audio von der Brille per WebSocket zum eigenen Server, von dort an Soniox (EU) mit Sprechertrennung
- Transkript mit Sprecherlabels live auf Brille (per Tipp ausblendbar) und Handy
- Fusion der Anbieter-Diarization mit der Sprecherrolle, die die Brille pro Audio-Frame meldet
- Fensterweise Analyse mit der Claude API (`claude-opus-5`, JSON-Schema): Gottman-Muster,
  Eskalation, Unterbrechen, Pauschalisierung, Vorwurf vs. Ich-Botschaft sowie positive Signale,
  jeweils mit Zitat, Intensität und Wechselwirkung („reagiert auf …“), für beide Sprecher gleich
- Neutrale Live-Hinweise auf der Brille („Tempo steigt“, „Pause?“, „Viele Unterbrechungen“),
  höchstens einer pro 90 s, nie vor Minute 1, nie mit Sprechernamen
- Nachbetrachtung als Bericht (Handy-Ansicht und eigene HTML-Seite unter `/report/<id>`)
- Transkripte, Funde und Bericht lokal als JSON gespeichert (abschaltbar), Löschen per UI und API
- Fake-STT-Adapter und Mock-Analyse zum Entwickeln ohne Keys, Bench-Tool für den Diarization-Test

## Voraussetzungen

- Node.js 22 oder neuer, npm 10
- Even Hub App auf dem iPhone (für echte Brille) oder der Simulator (wird als Dev-Abhängigkeit installiert)
- Soniox-API-Key (https://console.soniox.com), alternativ `STT_PROVIDER=fake`

## Schnellstart im Simulator

```bash
npm install

# Server konfigurieren
cp apps/server/.env.example apps/server/.env
#   SONIOX_API_KEY eintragen, oder STT_PROVIDER=fake setzen
#   ANTHROPIC_API_KEY eintragen, oder ANALYSIS_MODEL=mock (Attrappe) bzw. Key leer lassen (keine Analyse)

# Terminal 1: Server
npm run dev:server

# Terminal 2: Brillen-App (Vite auf http://localhost:5173)
npm run dev:glasses

# Terminal 3: Simulator (nutzt das Mac-Mikrofon)
npm run simulate
```

Im Simulator: Long Press = Session starten (Bestätigung mit Click), Long Press während der
Aufnahme = beenden, Click während der Aufnahme = Live-Transkript auf der Brille ein/aus,
Double Click = App beenden. Nach dem Ende erscheint der Bericht in der Companion-Ansicht;
die ausführliche Fassung liegt unter `http://localhost:8787/report/<session-id>`. Die Companion-Ansicht (das, was auf dem Handy
sichtbar wäre) läuft im Simulator-Fenster bzw. unter http://localhost:5173.

Mikrofon im Simulator wählen: `npx evenhub-simulator --list-audio-input-devices`, dann
`npx evenhub-simulator --aid <id> http://localhost:5173`.

## Auf der echten Brille

1. Mac und iPhone im selben WLAN. LAN-IP des Macs ermitteln (`ipconfig getifaddr en0`).
2. `apps/glasses/.env.local` anlegen: `VITE_SERVER_WS_URL=ws://<mac-ip>:8787/ws`
3. In `apps/glasses/app.json` unter `network.whitelist` die Origins `http://<mac-ip>:8787` und
   `ws://<mac-ip>:8787` ergänzen (nur exakte Origins, keine Wildcards).
4. `npm run dev:server` und `npm run dev:glasses` starten, dann
   `cd apps/glasses && npx evenhub qr --url http://<mac-ip>:5173` und den QR-Code mit der Even Hub App scannen.

Außerhalb des WLANs braucht der Server WSS hinter einer echten Domain (kleiner EU-Host oder
Tailscale). Netlify kann den statischen Client hosten, aber keinen WebSocket-Server.

## Diarization-Bench

Der Simulator kann keine Audiodateien einspeisen. Das Bench-Tool streamt deshalb eine WAV-Datei
direkt an den Server, genau wie die Brille es täte:

```bash
# Testmaterial: zwei Einzelaufnahmen abwechselnd mischen, Person B um 12 dB leiser
npm run bench:mix -- --a person_a.wav --b person_b.wav --gain-b -12 --out mix_-12dB.wav

# Durch den Server schicken und gegen die Referenz bewerten (Server muss laufen)
npm run bench:feed -- --file mix_-12dB.wav --ref mix_-12dB.ref.json --speed 4
```

Echte Brillenaufnahmen für die Bench: `DEV_AUDIO_DUMP=true` in `apps/server/.env`, dann in der
Companion-Ansicht (nur im Dev-Build sichtbar) „Debug-Aufnahme“ einschalten. Die WAV landet unter
`data/debug/`. Im Normalbetrieb bleibt der Schalter aus, dann wird nie Rohaudio geschrieben.

## Analyse

Der Server fasst STT-Tokens zu Redebeiträgen zusammen (Sprecher, Zeiten, Pause davor,
Überlappung mit dem Vorredner). Alle 8 Beiträge oder 60 Sekunden geht ein Fenster mit den letzten
Beiträgen als Kontext an Claude. Die Ausgabe ist ein festes JSON-Schema (`apps/server/src/analysis/schemas.ts`),
die Prompts liegen in `apps/server/src/analysis/prompts.ts`. Am Ende entsteht aus Gesamttranskript
und allen Funden der Bericht. Live sieht die Brille nur neutrale Hinweise, keine Funde.
Kosten: pro Fenster grob 2–4k Eingabetokens, Bericht je nach Länge 10–30k, mit Prompt-Caching auf
den Systemprompt.

## Datenschutz

- Kein Dauerbetrieb: Das Mikrofon geht erst nach Long Press plus Bestätigung an und bei Long Press,
  Verbindungsabbruch oder App-Ende sofort aus.
- Während der Aufnahme steht dauerhaft `● AUFNAHME` in der ersten Displayzeile.
- Rohaudio wird nur im Arbeitsspeicher durchgereicht (Brille → Server → STT), nie gespeichert.
  Einzige Ausnahme ist der oben beschriebene, explizit aktivierte Debug-Schalter.
- Transkripte liegen als JSON unter `data/sessions/` auf dem eigenen Rechner. `PERSIST_TRANSCRIPTS=false`
  schaltet das ab. Löschen: Button in der Companion-Ansicht oder `DELETE /api/sessions/<id>`.
- API-Keys liegen ausschließlich in `apps/server/.env`. Der Client kennt nur die Server-URL.
- Bei Soniox und Deepgram die Zero-Retention-Option im jeweiligen Konto aktivieren.

## Struktur

```
packages/shared    Protokoll zwischen App und Server, Audio-Frame-Format
apps/glasses       Even-Hub-App (Vite + TypeScript)
apps/server        Node-Server: STT-Adapter (Soniox, Fake), Sprecherfusion, Speicherung, HTTP-API
tools/bench        WAV-Feeder und Mischwerkzeug für den Diarization-Test
docs/PLAN.md       Architektur, Dienstevergleich, Meilensteine
```

## Was auf echter Hardware noch zu prüfen ist

- Ob und wann das Brillenmikro von selbst abschaltet (nicht dokumentiert)
- Qualität von `speakerRole` und Bedeutung von `direction` (im Simulator nicht vorhanden)
- Ob Long Press vom Ring als System- oder Text-Event ankommt (beides wird behandelt)
- Verhalten nach 5 Minuten Sperrbildschirm
