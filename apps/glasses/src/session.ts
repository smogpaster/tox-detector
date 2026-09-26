import { AudioInputSource, AudioSpeakerRole, type AudioEvent, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { encodeAudioFrame, type Hint, type InterimText, type ServerMessage, type SessionSummary, type SpeakerRole, type Utterance } from '@spiegel/shared'
import { BODY_MAX_CHARS, type GlassesDisplay } from './display'
import type { Gesture, Lifecycle } from './input'
import type { Transport } from './transport'
import type { CompanionUi } from './ui/companion'

export type UiState = 'connecting' | 'idle' | 'confirm' | 'active' | 'finishing' | 'report'

interface Deps {
  bridge: EvenAppBridge
  transport: Transport
  display: GlassesDisplay
  ui: CompanionUi
}

const roleMap: Record<string, SpeakerRole> = {
  [AudioSpeakerRole.Self]: 'self',
  [AudioSpeakerRole.Other]: 'other',
  [AudioSpeakerRole.Unknown]: 'unknown',
}

/**
 * Zustandsautomat der Session auf dem Client.
 *
 *  idle ──long press──► confirm ──click──► active ──long press──► finishing ──► report ──click/long──► idle
 *                          └──double click──► idle
 *  Doppeltipp außerhalb von confirm: System-Exit-Dialog der Even App.
 */
export class SessionController {
  state: UiState = 'connecting'
  private micOn = false
  private sessionId: string | null = null
  private startedAt: number | null = null
  private utterances: Utterance[] = []
  private interim: InterimText = { speaker: null, text: '' }
  private lastSummary: SessionSummary | null = null
  private debugDump = false
  private debugDumpAvailable = false
  private tickTimer: number | null = null
  private droppedFrames = 0
  /** Live-Transkript auf der Brille anzeigen (Click schaltet um). Aus = ruhiger Modus. */
  private showTranscript = true
  private activeHint: Hint | null = null
  private hintTimer: number | null = null
  private reportState: 'pending' | 'ready' | 'failed' | 'none' = 'none'

  constructor(private d: Deps) {
    d.transport.onMessage(m => this.onServer(m))
    d.transport.onConnection(connected => {
      if (!connected) {
        // Verbindung weg: Aufnahme sofort stoppen, der Server schließt die Session serverseitig ab.
        if (this.state === 'active') void this.setMic(false)
        this.setState('connecting')
      }
    })
    d.ui.onAction(a => this.onUiAction(a))
    this.render()
  }

  // ---------- Eingaben ----------

  onGesture(g: Gesture, fromRing: boolean) {
    console.log('gesture', g, fromRing ? '(ring)' : '')
    switch (this.state) {
      case 'idle':
        if (g === 'long') this.setState('confirm')
        else if (g === 'double') void this.d.bridge.shutDownPageContainer(1)
        return
      case 'confirm':
        if (g === 'click') this.start()
        else if (g === 'double' || g === 'long') this.setState('idle')
        return
      case 'active':
        if (g === 'long') this.stop()
        else if (g === 'double') void this.d.bridge.shutDownPageContainer(1)
        else if (g === 'click') {
          this.showTranscript = !this.showTranscript
          this.renderBody()
        }
        return
      case 'report':
        if (g === 'click' || g === 'long') this.setState('idle')
        else if (g === 'double') void this.d.bridge.shutDownPageContainer(1)
        return
      default:
        if (g === 'double') void this.d.bridge.shutDownPageContainer(1)
    }
  }

  onLifecycle(l: Lifecycle) {
    console.log('lifecycle', l)
    if (l === 'systemExit' || l === 'abnormalExit') void this.cleanup()
  }

  onAudio(a: AudioEvent) {
    if (this.state !== 'active') return
    const frame = encodeAudioFrame({
      role: roleMap[a.speakerRole] ?? 'unknown',
      direction: a.direction ?? null,
      pcm: a.audioPcm,
    })
    if (!this.d.transport.sendBinary(frame)) this.droppedFrames++
  }

  private onUiAction(a: 'start' | 'stop' | 'debugDump') {
    if (a === 'start') {
      if (this.state === 'idle' || this.state === 'report') this.setState('confirm')
      if (this.state === 'confirm') this.start()
    } else if (a === 'stop' && this.state === 'active') this.stop()
    else if (a === 'debugDump') {
      this.debugDump = !this.debugDump
      this.d.transport.send({ type: 'debug.dump', enabled: this.debugDump })
      this.render()
    }
  }

  // ---------- Übergänge ----------

  private start() {
    if (!this.d.transport.connected) {
      this.d.ui.setError('Server nicht erreichbar. Läuft `npm run dev:server`?')
      this.setState('idle')
      return
    }
    this.utterances = []
    this.interim = { speaker: null, text: '' }
    this.droppedFrames = 0
    this.reportState = 'none'
    this.d.ui.clearReport()
    this.d.transport.send({ type: 'session.start', language: 'de' })
    // Mikrofon erst, wenn der Server 'active' bestätigt (siehe onServer).
    this.setState('finishing') // kurzer Zwischenzustand "wird gestartet"
    this.d.display.setStatus('Starte …')
  }

  private stop() {
    void this.setMic(false)
    this.d.transport.send({ type: 'session.stop' })
    this.setState('finishing')
  }

  async cleanup() {
    await this.setMic(false)
    if (this.state === 'active') this.d.transport.send({ type: 'session.stop' })
    this.d.transport.close()
  }

  private async setMic(on: boolean) {
    if (this.micOn === on) return
    this.micOn = on
    try {
      const ok = await this.d.bridge.audioControl(on, AudioInputSource.Glasses)
      if (!ok) console.warn('audioControl lieferte false', { on })
    } catch (e) {
      console.error('audioControl fehlgeschlagen', e)
      this.micOn = false
    }
  }

  private onServer(m: ServerMessage) {
    switch (m.type) {
      case 'hello':
        this.debugDumpAvailable = m.debugDumpAvailable
        this.d.ui.setServerInfo(m.sttProvider, m.debugDumpAvailable)
        break
      case 'session.state':
        if (m.state === 'active') {
          this.sessionId = m.sessionId
          this.startedAt = m.startedAt ? Date.parse(m.startedAt) : Date.now()
          this.debugDump = m.debugDump
          this.setState('active')
          void this.setMic(true)
        } else if (m.state === 'idle' && this.state === 'connecting') {
          this.setState('idle')
        } else if (m.state === 'finishing') {
          void this.setMic(false)
          this.setState('finishing')
        } else if (m.state === 'report') {
          void this.setMic(false)
          this.setState('report')
        }
        break
      case 'transcript.update':
        this.utterances = m.utterances
        this.interim = m.interim
        this.d.ui.setTranscript(m.utterances, m.interim, m.speakers)
        if (this.state === 'active') this.renderBody()
        break
      case 'hint':
        this.showHint(m.hint)
        break
      case 'analysis.progress':
        this.d.ui.setAnalysis(m.enabled, m.windows, m.findings)
        if (!m.enabled) this.reportState = 'none'
        else if (this.reportState === 'none') this.reportState = 'pending'
        break
      case 'report.ready':
        this.reportState = 'ready'
        this.d.ui.setReport(m.report, `${this.d.transport.httpBase}/report/${m.sessionId}`)
        this.renderBody()
        break
      case 'report.failed':
        this.reportState = 'failed'
        this.d.ui.setReportFailed(m.message)
        this.renderBody()
        break
      case 'session.ended':
        this.lastSummary = m.summary
        this.d.ui.setSummary(m.summary)
        try {
          localStorage.setItem('spiegel.lastSession', JSON.stringify(m.summary))
        } catch {
          /* localStorage kann in der WebView fehlen */
        }
        this.setState('report')
        break
      case 'error':
        this.d.ui.setError(m.message)
        if (m.fatal) {
          void this.setMic(false)
          this.setState('idle')
        }
        break
    }
  }

  private setState(s: UiState) {
    if (this.state === s) return
    this.state = s
    if (s === 'active' && this.tickTimer === null) {
      this.tickTimer = window.setInterval(() => this.renderStatus(), 15_000)
    } else if (s !== 'active' && this.tickTimer !== null) {
      window.clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.render()
  }

  private showHint(h: Hint) {
    if (this.state !== 'active') return
    this.activeHint = h
    if (this.hintTimer !== null) window.clearTimeout(this.hintTimer)
    this.hintTimer = window.setTimeout(() => {
      this.activeHint = null
      this.hintTimer = null
      this.renderBody()
    }, h.ttlMs)
    this.d.ui.setHint(h)
    this.renderBody()
  }

  // ---------- Darstellung ----------

  private render() {
    this.renderStatus()
    this.renderBody()
    this.d.ui.setState(this.state, this.debugDump && this.debugDumpAvailable)
  }

  private elapsed(): string {
    if (!this.startedAt) return '0:00'
    const s = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }

  private renderStatus() {
    const dbg = this.debugDump && this.debugDumpAvailable ? ' · DEBUG-AUFNAHME' : ''
    const text: Record<UiState, string> = {
      connecting: 'SPIEGEL · verbinde mit Server …',
      idle: 'SPIEGEL · bereit',
      confirm: 'Session starten?',
      active: `● AUFNAHME ${this.elapsed()}${dbg}`,
      finishing: 'SPIEGEL · wird abgeschlossen …',
      report: 'SPIEGEL · Session beendet',
    }
    this.d.display.setStatus(text[this.state])
  }

  private renderBody() {
    switch (this.state) {
      case 'connecting':
        return this.d.display.setBody('Warte auf den Spiegel-Server.\nPrüfe WLAN und Server-URL.')
      case 'idle':
        return this.d.display.setBody('Ring lang drücken: Session starten\nDoppeltipp: App beenden')
      case 'confirm':
        return this.d.display.setBody('Tipp = ja, starten\nDoppeltipp = nein\n\nBeide Personen wissen Bescheid und sind einverstanden.')
      case 'finishing':
        return this.d.display.setBody('Einen Moment …')
      case 'report': {
        const s = this.lastSummary
        const info = s ? `${s.utteranceCount} Beiträge · ${Math.round(s.durationMs / 60000)} min` : ''
        const rep: Record<typeof this.reportState, string> = {
          pending: 'Auswertung wird erstellt …',
          ready: 'Auswertung auf dem Handy bereit.',
          failed: 'Auswertung nicht möglich (siehe Handy).',
          none: 'Transkript auf dem Handy.',
        }
        return this.d.display.setBody(`${info}\n${rep[this.reportState]}\n\nTipp: zurück zum Start`)
      }
      case 'active':
        // Ein Hinweis hat für seine Anzeigedauer das ganze Feld für sich, damit er ruhig wirkt.
        if (this.activeHint) return this.d.display.setBody(`\n   ${this.activeHint.text}`)
        return this.d.display.setBody(this.showTranscript ? this.transcriptForGlasses() : '')
    }
  }

  /** Letzte Beiträge mit Sprecherlabel, auf die Displaygröße gekürzt. */
  private transcriptForGlasses(): string {
    const lines: string[] = []
    for (const u of this.utterances.slice(-4)) lines.push(`${u.speaker}: ${u.text}`)
    if (this.interim.text) lines.push(`${this.interim.speaker ?? '?'}: ${this.interim.text} …`)
    if (!lines.length) return 'Ich höre zu …'
    let text = lines.join('\n')
    if (text.length > BODY_MAX_CHARS) text = '…' + text.slice(-(BODY_MAX_CHARS - 1))
    return text
  }
}
