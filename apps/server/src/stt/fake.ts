import { EventEmitter } from 'node:events'
import { pcmBytesToMs } from '@spiegel/shared'
import type { SttAdapter, SttStartOptions, SttStream, SttStreamEvents, SttToken } from './types'

/**
 * Fake-STT für Entwicklung ohne API-Key: liefert einen fest verdrahteten deutschen Dialog,
 * getaktet nach der Menge des empfangenen Audios. Ignoriert den Audioinhalt vollständig.
 */
const SCRIPT: Array<{ speaker: string; text: string; durMs: number; pauseMs: number }> = [
  { speaker: '1', text: 'Du hast schon wieder vergessen, den Müll rauszubringen.', durMs: 2600, pauseMs: 600 },
  { speaker: '2', text: 'Ich hatte heute einfach keinen Kopf dafür, tut mir leid.', durMs: 2800, pauseMs: 300 },
  { speaker: '1', text: 'Das sagst du immer. Es ist nie der richtige Moment.', durMs: 2700, pauseMs: 200 },
  { speaker: '2', text: 'Kannst du mir kurz sagen, was dich gerade am meisten stört?', durMs: 3000, pauseMs: 900 },
  { speaker: '1', text: 'Dass ich das Gefühl habe, alles alleine im Blick zu haben.', durMs: 3100, pauseMs: 400 },
  { speaker: '2', text: 'Okay, das verstehe ich. Lass uns das anders aufteilen.', durMs: 2900, pauseMs: 700 },
  { speaker: '1', text: 'Danke. Das hilft mir gerade.', durMs: 1800, pauseMs: 1200 },
]

class FakeStream extends EventEmitter<SttStreamEvents> implements SttStream {
  private audioMs = 0
  private cursorMs = 0
  private lineIdx = 0
  private wordIdx = 0
  private closed = false
  private interim: SttToken[] = []
  private timer: NodeJS.Timeout

  constructor() {
    super()
    // Simuliert Netzwerklatenz: Tokens kommen ~300 ms nach dem Audio.
    this.timer = setInterval(() => this.tick(), 150)
  }

  sendPcm(pcm: Uint8Array): void {
    this.audioMs += pcmBytesToMs(pcm.byteLength)
  }

  end(): void {
    // Was bis zum Audio-Ende gesprochen wurde, final ausspielen und schließen.
    this.audioMs += 400
    this.tick()
    this.finish()
  }

  abort(): void {
    this.finish()
  }

  private tick() {
    if (this.closed) return
    const finalTokens: SttToken[] = []
    const lagMs = 300
    while (true) {
      const line = SCRIPT[this.lineIdx % SCRIPT.length]!
      const words = line.text.split(' ')
      const perWord = line.durMs / words.length
      const lineStart = this.cursorMs
      const wordStart = lineStart + this.wordIdx * perWord
      const wordEnd = wordStart + perWord
      if (wordEnd + lagMs > this.audioMs) break
      finalTokens.push({
        text: (this.wordIdx === 0 ? '' : ' ') + words[this.wordIdx]!,
        startMs: Math.round(wordStart),
        endMs: Math.round(wordEnd),
        isFinal: true,
        speaker: line.speaker,
      })
      this.wordIdx++
      if (this.wordIdx >= words.length) {
        finalTokens.push({ text: '', startMs: Math.round(wordEnd), endMs: Math.round(wordEnd), isFinal: true, speaker: line.speaker, isEndpoint: true })
        this.cursorMs = lineStart + line.durMs + line.pauseMs
        this.lineIdx++
        this.wordIdx = 0
      }
    }
    // Interim: nächstes Wort als Vorschau.
    this.interim = []
    if (Number.isFinite(this.audioMs)) {
      const line = SCRIPT[this.lineIdx % SCRIPT.length]!
      const words = line.text.split(' ')
      const next = words[this.wordIdx]
      if (next && this.wordIdx > 0) {
        this.interim.push({ text: ' ' + next, startMs: 0, endMs: 0, isFinal: false, speaker: line.speaker })
      }
    }
    if (finalTokens.length || this.interim.length) this.emit('batch', { finalTokens, interimTokens: this.interim })
  }

  private finish() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    this.emit('close')
  }
}

export class FakeAdapter implements SttAdapter {
  readonly name = 'fake'
  start(_opts: SttStartOptions): SttStream {
    return new FakeStream()
  }
}
