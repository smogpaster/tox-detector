import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pcmBytesToMs, type AudioFrame, type ServerMessage, type SessionState } from '@spiegel/shared'
import { WavWriter } from '../audio/wavWriter'
import { config } from '../config'
import { log } from '../log'
import { FileStore, toSummary, type SessionRecord } from '../store/fileStore'
import type { SttAdapter, SttStream } from '../stt/types'
import { UtteranceBuilder } from './utterances'

export type Sender = (msg: ServerMessage) => void

/**
 * Eine Gesprächs-Session: nimmt Audio-Frames vom Client, streamt sie an die STT,
 * baut Redebeiträge und schickt Transkript-Snapshots zurück. Hält kein Rohaudio.
 */
export class Session {
  readonly id = randomUUID().slice(0, 8)
  readonly startedAt = new Date()
  state: SessionState = 'active'
  private builder = new UtteranceBuilder()
  private stt: SttStream
  private audioMs = 0
  private dump: WavWriter | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private endedAt: Date | null = null
  private closeResolve: (() => void) | null = null
  private closed: Promise<void>

  constructor(
    private adapter: SttAdapter,
    private send: Sender,
    private store: FileStore | null,
    readonly language: 'de' = 'de',
  ) {
    this.closed = new Promise(res => (this.closeResolve = res))
    this.stt = adapter.start({ language })
    this.stt.on('batch', batch => {
      if (this.builder.ingest(batch)) this.pushTranscript()
    })
    this.stt.on('error', err => {
      log.error(`session ${this.id}: STT-Fehler`, err.message)
      this.send({ type: 'error', message: `Spracherkennung: ${err.message}`, fatal: true })
      void this.stop()
    })
    this.stt.on('close', () => this.onSttClosed())
    log.info(`session ${this.id}: gestartet (stt=${adapter.name}, persist=${Boolean(store)})`)
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

  /** Beendet die Aufnahme, wartet auf die letzten STT-Tokens und speichert. */
  async stop(): Promise<void> {
    if (this.state !== 'active') return this.closed
    this.state = 'finishing'
    this.endedAt = new Date()
    this.pushState()
    this.stt.end()
    // Falls der Dienst nicht sauber schließt, nach 8 s hart beenden.
    const timeout = setTimeout(() => this.stt.abort(), 8000)
    await this.closed
    clearTimeout(timeout)
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
      log.info(`session ${this.id}: beendet, ${this.builder.utterances.length} Beiträge, ${Math.round(this.audioMs / 1000)} s Audio`)
      this.closeResolve?.()
    })
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
