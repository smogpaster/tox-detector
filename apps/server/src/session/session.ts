import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pcmBytesToMs, type AudioFrame, type Hint, type Report, type ServerMessage, type SessionState } from '@spiegel/shared'
import { SessionAnalyzer } from '../analysis/analyzer'
import { WavWriter } from '../audio/wavWriter'
import { config } from '../config'
import { HintPolicy } from '../hints/policy'
import { log } from '../log'
import { FileStore, toSummary, type SessionRecord } from '../store/fileStore'
import type { SttAdapter, SttStream } from '../stt/types'
import { UtteranceBuilder } from './utterances'

export type Sender = (msg: ServerMessage) => void

/**
 * Eine Gesprächs-Session: nimmt Audio-Frames vom Client, streamt sie an die STT,
 * baut Redebeiträge, lässt sie fensterweise analysieren, schickt Transkript-Snapshots und
 * seltene neutrale Hinweise zurück und erstellt am Ende den Bericht. Hält kein Rohaudio.
 */
export class Session {
  readonly id = randomUUID().slice(0, 8)
  readonly startedAt = new Date()
  state: SessionState = 'active'
  private builder = new UtteranceBuilder()
  private stt: SttStream
  private analyzer: SessionAnalyzer | null
  private hintPolicy = new HintPolicy()
  private hints: Hint[] = []
  private report: Report | null = null
  private reportError: string | null = null
  private audioMs = 0
  private dump: WavWriter | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private endedAt: Date | null = null
  private closeResolve: (() => void) | null = null
  private closed: Promise<void>

  constructor(
    adapter: SttAdapter,
    private send: Sender,
    private store: FileStore | null,
    readonly language: 'de' = 'de',
  ) {
    this.closed = new Promise(res => (this.closeResolve = res))
    this.stt = adapter.start({ language })
    this.stt.on('batch', batch => {
      if (this.builder.ingest(batch)) this.onTranscriptChanged()
    })
    this.stt.on('error', err => {
      log.error(`session ${this.id}: STT-Fehler`, err.message)
      this.send({ type: 'error', message: `Spracherkennung: ${err.message}`, fatal: true })
      void this.stop()
    })
    this.stt.on('close', () => this.onSttClosed())

    this.analyzer = config.analysis.enabled ? new SessionAnalyzer(() => this.builder.utterances) : null
    this.analyzer?.on('window', () => this.maybeHint())
    this.analyzer?.on('progress', p =>
      this.send({ type: 'analysis.progress', sessionId: this.id, windows: p.windows, findings: p.findings, lastWindow: this.analyzer!.windows.at(-1) ?? null, enabled: true }),
    )
    this.analyzer?.on('error', msg => this.send({ type: 'error', message: msg, fatal: false }))
    log.info(`session ${this.id}: gestartet (stt=${adapter.name}, persist=${Boolean(store)}, analyse=${Boolean(this.analyzer)})`)
    if (!this.analyzer) this.send({ type: 'analysis.progress', sessionId: this.id, windows: 0, findings: 0, lastWindow: null, enabled: false })
  }

  setDebugDump(enabled: boolean) {
    if (!config.devAudioDump) return
    if (enabled && !this.dump) {
      const file = path.join(config.dataDir, 'debug', `${this.id}.wav`)
      this.dump = new WavWriter(file)
      log.warn(`session ${this.id}: DEBUG-AUFNAHME aktiv -> ${file}`)
    } else if (!enabled && this.dump) {
      this.dump.close()
      this.dump = null
    }
    this.pushState()
  }

  get debugDump() {
    return this.dump !== null
  }

  onAudio(frame: AudioFrame) {
    if (this.state !== 'active') return
    const startMs = this.audioMs
    this.audioMs += pcmBytesToMs(frame.pcm.byteLength)
    this.builder.addRoleSpan(startMs, this.audioMs, frame.role)
    this.stt.sendPcm(frame.pcm)
    this.dump?.write(frame.pcm)
  }

  /** Beendet die Aufnahme, wartet auf die letzten STT-Tokens und speichert. Bericht folgt asynchron. */
  async stop(): Promise<void> {
    if (this.state !== 'active') return this.closed
    this.state = 'finishing'
    this.endedAt = new Date()
    this.pushState()
    this.stt.end()
    const timeout = setTimeout(() => this.stt.abort(), 8000)
    await this.closed
    clearTimeout(timeout)
  }

  private onTranscriptChanged() {
    this.pushTranscript()
    this.analyzer?.poke()
    this.maybeHint()
  }

  private maybeHint() {
    if (this.state !== 'active') return
    const hint = this.hintPolicy.evaluate(this.audioMs, this.builder.utterances, this.analyzer?.windows ?? [])
    if (!hint) return
    this.hints.push(hint)
    log.info(`session ${this.id}: Hinweis "${hint.text}" (${hint.reason})`)
    this.send({ type: 'hint', hint })
  }

  private onSttClosed() {
    this.builder.flush()
    this.pushTranscript()
    if (this.dump) {
      this.dump.close()
      this.dump = null
    }
    this.endedAt ??= new Date()
    this.state = 'report'
    void this.persist(true).then(() => {
      this.send({ type: 'session.ended', summary: toSummary(this.record(), Boolean(this.store)) })
      this.pushState()
      log.info(`session ${this.id}: Aufnahme beendet, ${this.builder.utterances.length} Beiträge, ${Math.round(this.audioMs / 1000)} s Audio`)
      this.closeResolve?.()
      void this.finishReport()
    })
  }

  private async finishReport() {
    if (!this.analyzer) return
    try {
      this.report = await this.analyzer.finish(this.builder.speakers(), Math.round(this.audioMs))
      if (this.report) {
        this.send({ type: 'report.ready', sessionId: this.id, report: this.report })
        log.info(`session ${this.id}: Bericht erstellt (${this.analyzer.windows.length} Fenster, ${this.analyzer.findings.length} Funde)`)
      } else {
        this.reportError ??= 'Zu wenig Gesprächsmaterial für eine Auswertung'
        this.send({ type: 'report.failed', sessionId: this.id, message: this.reportError })
      }
    } catch (e) {
      this.reportError = e instanceof Error ? e.message : String(e)
      this.send({ type: 'report.failed', sessionId: this.id, message: this.reportError })
    }
    await this.persist(true)
  }

  record(): SessionRecord {
    return {
      id: this.id,
      language: this.language,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.endedAt?.toISOString() ?? null,
      durationMs: Math.round(this.audioMs),
      utterances: this.builder.utterances,
      speakers: this.builder.speakers(),
      windows: this.analyzer?.windows ?? [],
      hints: this.hints,
      report: this.report,
      reportError: this.reportError,
    }
  }

  private pushState() {
    this.send({ type: 'session.state', state: this.state, sessionId: this.id, startedAt: this.startedAt.toISOString(), debugDump: this.debugDump })
  }

  private pushTranscript() {
    this.send({
      type: 'transcript.update',
      sessionId: this.id,
      utterances: this.builder.utterances,
      interim: this.builder.interim(),
      speakers: this.builder.speakers(),
    })
    this.schedulePersist()
  }

  private schedulePersist() {
    if (!this.store || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persist(false)
    }, 2000)
  }

  private async persist(final: boolean) {
    if (!this.store) return
    if (this.saveTimer && final) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    try {
      await this.store.save(this.record())
    } catch (e) {
      log.error(`session ${this.id}: Speichern fehlgeschlagen`, e)
    }
  }
}
