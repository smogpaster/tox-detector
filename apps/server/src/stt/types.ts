import { EventEmitter } from 'node:events'

/** Normalisiertes Token eines STT-Dienstes, Zeiten relativ zum Audio-Start in ms. */
export interface SttToken {
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
  /** Sprecherlabel des Anbieters (z. B. "1", "2"), undefined ohne Diarization. */
  speaker?: string
  /** true bei Endpunkt-Markern (Sprechpause erkannt), Text ist dann leer. */
  isEndpoint?: boolean
}

export interface SttBatch {
  /** Neue finale Tokens (werden nie erneut gesendet). */
  finalTokens: SttToken[]
  /** Aktueller, vollständiger nicht-finaler Schwanz (ersetzt den vorherigen). */
  interimTokens: SttToken[]
}

export interface SttStreamEvents {
  batch: [SttBatch]
  error: [Error]
  close: []
}

export interface SttStream extends EventEmitter<SttStreamEvents> {
  sendPcm(pcm: Uint8Array): void
  /** Audio-Ende signalisieren. Danach kommt noch ein letzter Batch und 'close'. */
  end(): void
  /** Sofort abbrechen. */
  abort(): void
}

export interface SttStartOptions {
  language: 'de'
}

export interface SttAdapter {
  readonly name: string
  start(opts: SttStartOptions): SttStream
}
