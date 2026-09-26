import { randomUUID } from 'node:crypto'
import { POSITIVE_PATTERNS, type Hint, type Utterance, type WindowAnalysis } from '@spiegel/shared'
import { config } from '../config'

/**
 * Entscheidet, ob und welcher neutrale Hinweis auf der Brille erscheint.
 * Kein Urteil über Personen, keine Sprechernamen, stark ratenbegrenzt.
 */
export class HintPolicy {
  private lastHintAt = -Infinity
  private lastByReason = new Map<string, number>()

  /** @param nowMs Audio-Zeit seit Session-Start */
  evaluate(nowMs: number, utterances: Utterance[], windows: WindowAnalysis[]): Hint | null {
    if (!config.hints.enabled) return null
    if (nowMs < config.hints.warmupSec * 1000) return null
    if (nowMs - this.lastHintAt < config.hints.minIntervalSec * 1000) return null

    const candidate = this.tempo(nowMs, utterances) ?? this.interruptions(nowMs, utterances) ?? this.tension(windows) ?? this.monologue(nowMs, utterances) ?? this.positive(windows)
    if (!candidate) return null
    // Denselben Grund nicht öfter als alle 5 Minuten.
    const last = this.lastByReason.get(candidate.reason) ?? -Infinity
    if (nowMs - last < 5 * 60_000) return null
    this.lastHintAt = nowMs
    this.lastByReason.set(candidate.reason, nowMs)
    return { id: randomUUID().slice(0, 6), text: candidate.text, ttlMs: config.hints.ttlMs, atMs: nowMs, reason: candidate.reason }
  }

  /** Sprechtempo (Zeichen pro Sekunde Sprechzeit) der letzten 45 s vs. Gesamtdurchschnitt. */
  private tempo(nowMs: number, us: Utterance[]) {
    const rate = (list: Utterance[]) => {
      const ms = list.reduce((a, u) => a + (u.endMs - u.startMs), 0)
      const chars = list.reduce((a, u) => a + u.text.length, 0)
      return ms > 0 ? chars / (ms / 1000) : 0
    }
    const recent = us.filter(u => u.endMs >= nowMs - 45_000)
    const baseline = us.filter(u => u.endMs < nowMs - 45_000)
    if (recent.length < 3 || baseline.length < 5) return null
    const r = rate(recent)
    const b = rate(baseline)
    if (b > 0 && r / b >= 1.3) return { text: 'Tempo steigt', reason: 'tempo' }
    return null
  }

  private interruptions(nowMs: number, us: Utterance[]) {
    const n = us.filter(u => u.startMs >= nowMs - 60_000 && u.overlapMs > 300).length
    return n >= 3 ? { text: 'Viele Unterbrechungen', reason: 'interruptions' } : null
  }

  private tension(ws: WindowAnalysis[]) {
    const last = ws[ws.length - 1]
    const prev = ws[ws.length - 2]
    if (!last) return null
    if (last.tension === 3 || (prev && last.tension >= 2 && prev.tension >= 2)) return { text: 'Pause?', reason: 'tension' }
    return null
  }

  /** Eine Person spricht seit über 60 s ohne Beitrag der anderen. */
  private monologue(nowMs: number, us: Utterance[]) {
    const last = us[us.length - 1]
    if (!last || nowMs - last.endMs > 5000) return null
    let i = us.length - 1
    while (i > 0 && us[i - 1]!.speaker === last.speaker) i--
    const runMs = last.endMs - us[i]!.startMs
    return runMs > 60_000 ? { text: 'Raum für eine Nachfrage?', reason: 'monologue' } : null
  }

  private positive(ws: WindowAnalysis[]) {
    const last = ws[ws.length - 1]
    if (!last) return null
    const pos = last.findings.filter(f => POSITIVE_PATTERNS.has(f.pattern) && f.intensity >= 2).length
    const neg = last.findings.filter(f => !POSITIVE_PATTERNS.has(f.pattern) && f.intensity >= 2).length
    return pos >= 2 && neg === 0 && last.tension <= 1 ? { text: 'Das läuft gerade gut', reason: 'positive' } : null
  }
}
