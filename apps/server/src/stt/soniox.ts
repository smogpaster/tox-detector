import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { log } from '../log'
import type { SttAdapter, SttStartOptions, SttStream, SttStreamEvents, SttToken } from './types'

/**
 * Soniox Real-time API (WebSocket).
 * Doku: https://soniox.com/docs/stt/api-reference/websocket-api
 * - erste Nachricht: Konfiguration als JSON
 * - danach Audio als Binärframes (pcm_s16le, 16 kHz, mono)
 * - Ende: leerer Frame; Server antwortet mit finished:true und schließt
 * - Antwort: { tokens:[{text,start_ms,end_ms,confidence,is_final,speaker?}], finished?, error_code?, error_message? }
 * - Endpunkt-Erkennung liefert Tokens mit text "<end>"
 */
interface SonioxToken {
  text: string
  start_ms?: number
  end_ms?: number
  confidence?: number
  is_final: boolean
  speaker?: string | number
}
interface SonioxResponse {
  tokens?: SonioxToken[]
  final_audio_proc_ms?: number
  total_audio_proc_ms?: number
  finished?: boolean
  error_code?: number
  error_type?: string
  error_message?: string
}

export interface SonioxOptions {
  apiKey: string
  wsUrl: string
  model: string
}

class SonioxStream extends EventEmitter<SttStreamEvents> implements SttStream {
  private ws: WebSocket
  private open = false
  private queue: Uint8Array[] = []
  private ended = false
  private closed = false

  constructor(opts: SonioxOptions, start: SttStartOptions) {
    super()
    this.ws = new WebSocket(opts.wsUrl)
    this.ws.binaryType = 'nodebuffer'
    this.ws.on('open', () => {
      this.ws.send(
        JSON.stringify({
          api_key: opts.apiKey,
          model: opts.model,
          audio_format: 'pcm_s16le',
          sample_rate: 16_000,
          num_channels: 1,
          language_hints: [start.language],
          language_hints_strict: true,
          enable_speaker_diarization: true,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: 1500,
        }),
      )
      this.open = true
      for (const chunk of this.queue) this.ws.send(chunk, { binary: true })
      this.queue = []
      if (this.ended) this.ws.send(Buffer.alloc(0), { binary: true })
    })
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return
      let res: SonioxResponse
      try {
        res = JSON.parse(data.toString()) as SonioxResponse
      } catch (e) {
        log.warn('soniox: unlesbare Nachricht', e)
        return
      }
      if (res.error_code !== undefined) {
        this.ended = true // Server schließt nach einem Fehler von sich aus
        this.emit('error', new Error(`Soniox ${res.error_code} ${res.error_type ?? ''}: ${res.error_message ?? ''}`.trim()))
        return
      }
      const finalTokens: SttToken[] = []
      const interimTokens: SttToken[] = []
      for (const t of res.tokens ?? []) {
        const tok = toToken(t)
        if (tok.isFinal) finalTokens.push(tok)
        else interimTokens.push(tok)
      }
      this.emit('batch', { finalTokens, interimTokens })
      if (res.finished) this.finish()
    })
    this.ws.on('error', err => this.emit('error', err instanceof Error ? err : new Error(String(err))))
    this.ws.on('close', (code, reason) => {
      if (!this.closed) {
        if (!this.ended) log.warn(`soniox: Verbindung geschlossen (${code}) ${reason.toString()}`)
        this.finish()
      }
    })
  }

  sendPcm(pcm: Uint8Array): void {
    if (this.ended || this.closed) return
    if (!this.open) {
      this.queue.push(pcm)
      return
    }
    this.ws.send(pcm, { binary: true })
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.open && this.ws.readyState === WebSocket.OPEN) this.ws.send(Buffer.alloc(0), { binary: true })
  }

  abort(): void {
    this.ended = true
    try {
      this.ws.terminate()
    } catch {
      /* ignore */
    }
    this.finish()
  }

  private finish() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

function toToken(t: SonioxToken): SttToken {
  const isEndpoint = t.text === '<end>'
  return {
    text: isEndpoint ? '' : t.text,
    startMs: t.start_ms ?? 0,
    endMs: t.end_ms ?? t.start_ms ?? 0,
    isFinal: t.is_final,
    speaker: t.speaker === undefined ? undefined : String(t.speaker),
    isEndpoint,
  }
}

export class SonioxAdapter implements SttAdapter {
  readonly name = 'soniox'
  constructor(private opts: SonioxOptions) {}
  start(start: SttStartOptions): SttStream {
    return new SonioxStream(this.opts, start)
  }
}
