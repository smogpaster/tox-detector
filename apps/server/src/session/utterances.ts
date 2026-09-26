import type { InterimText, SpeakerInfo, SpeakerRole, Utterance } from '@spiegel/shared'
import type { SttBatch, SttToken } from '../stt/types'
import { SpeakerRoleTimeline } from './fusion'

const SPEAKER_NAMES = 'ABCDEFGH'
/** Neue Äußerung, wenn zwischen zwei Tokens desselben Sprechers so viel Stille liegt. */
const GAP_SPLIT_MS = 1500

/**
 * Baut aus STT-Tokens Redebeiträge (Utterances) mit Sprecherlabel, Zeiten, Pausen und
 * Überlappungen. Fusioniert die Anbieter-Diarization mit der Sprecherrolle der Brille.
 */
export class UtteranceBuilder {
  readonly utterances: Utterance[] = []
  readonly roles = new SpeakerRoleTimeline()
  private labelMap = new Map<string, string>()
  private roleMsPerSpeaker = new Map<string, Record<SpeakerRole, number>>()
  private current: { speaker: string; tokens: SttToken[] } | null = null
  private interimTokens: SttToken[] = []
  private nextId = 1

  /** Von der Brille gemeldete Rolle für ein Stück Audio (ms seit Start). */
  addRoleSpan(startMs: number, endMs: number, role: SpeakerRole) {
    this.roles.add(startMs, endMs, role)
  }

  /** Verarbeitet einen STT-Batch. Gibt true zurück, wenn sich sichtbar etwas geändert hat. */
  ingest(batch: SttBatch): boolean {
    let changed = false
    for (const tok of batch.finalTokens) {
      if (tok.isEndpoint) {
        if (this.flush()) changed = true
        continue
      }
      if (!tok.text.trim()) continue
      const speaker = this.labelFor(tok.speaker ?? '1')
      if (this.current) {
        const lastTok = this.current.tokens[this.current.tokens.length - 1]!
        const gap = tok.startMs - lastTok.endMs
        if (this.current.speaker !== speaker || gap > GAP_SPLIT_MS) {
          this.flush()
          changed = true
        }
      }
      if (!this.current) this.current = { speaker, tokens: [] }
      this.current.tokens.push(tok)
      changed = true
    }
    const newInterim = batch.interimTokens.filter(t => !t.isEndpoint && t.text.length > 0)
    if (newInterim.length !== this.interimTokens.length || newInterim.some((t, i) => t.text !== this.interimTokens[i]?.text)) {
      changed = true
    }
    this.interimTokens = newInterim
    return changed
  }

  /** Offene Äußerung abschließen (z. B. bei Session-Ende). */
  flush(): boolean {
    if (!this.current || this.current.tokens.length === 0) {
      this.current = null
      return false
    }
    const toks = this.current.tokens
    const startMs = toks[0]!.startMs
    const endMs = toks[toks.length - 1]!.endMs
    const prev = this.utterances[this.utterances.length - 1]
    const roleHint = this.roles.majority(startMs, endMs)
    const roleMs = this.roles.roleMs(startMs, endMs)
    const speaker = this.current.speaker
    const acc = this.roleMsPerSpeaker.get(speaker) ?? { self: 0, other: 0, unknown: 0 }
    acc.self += roleMs.self
    acc.other += roleMs.other
    acc.unknown += roleMs.unknown
    this.roleMsPerSpeaker.set(speaker, acc)

    this.utterances.push({
      id: `u${this.nextId++}`,
      speaker,
      roleHint,
      text: toks.map(t => t.text).join('').trim(),
      startMs,
      endMs,
      overlapMs: prev && prev.speaker !== speaker ? Math.max(0, prev.endMs - startMs) : 0,
      gapMs: prev ? Math.max(0, startMs - prev.endMs) : 0,
    })
    this.current = null
    return true
  }

  /** Der noch nicht abgeschlossene Beitrag plus Interim-Tokens, für die Live-Anzeige. */
  interim(): InterimText {
    const parts: string[] = []
    let speaker: string | null = null
    if (this.current && this.current.tokens.length) {
      speaker = this.current.speaker
      parts.push(this.current.tokens.map(t => t.text).join(''))
    }
    if (this.interimTokens.length) {
      const s = this.interimTokens[0]!.speaker
      speaker ??= this.labelFor(s ?? '1')
      parts.push(this.interimTokens.map(t => t.text).join(''))
    }
    return { speaker, text: parts.join('').trim() }
  }

  speakers(): SpeakerInfo[] {
    return [...this.labelMap.values()].map(label => ({
      label,
      roleMs: this.roleMsPerSpeaker.get(label) ?? { self: 0, other: 0, unknown: 0 },
    }))
  }

  private labelFor(providerLabel: string): string {
    let label = this.labelMap.get(providerLabel)
    if (!label) {
      label = SPEAKER_NAMES[this.labelMap.size] ?? `S${this.labelMap.size + 1}`
      this.labelMap.set(providerLabel, label)
    }
    return label
  }
}
