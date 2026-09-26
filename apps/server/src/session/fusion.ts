import type { SpeakerRole } from '@spiegel/shared'

interface RoleSpan {
  startMs: number
  endMs: number
  role: SpeakerRole
}

/**
 * Sammelt die Sprecherrolle, die die Brille pro PCM-Frame meldet, auf einer Zeitachse
 * (ms seit Audio-Start) und beantwortet für beliebige Zeitfenster: welche Rolle überwiegt?
 * So wird die Diarization des STT-Dienstes mit dem Brillen-Signal fusioniert.
 */
export class SpeakerRoleTimeline {
  private spans: RoleSpan[] = []

  add(startMs: number, endMs: number, role: SpeakerRole) {
    const last = this.spans[this.spans.length - 1]
    if (last && last.role === role && Math.abs(last.endMs - startMs) < 1) {
      last.endMs = endMs
      return
    }
    this.spans.push({ startMs, endMs, role })
  }

  /** Millisekunden pro Rolle innerhalb [startMs, endMs]. */
  roleMs(startMs: number, endMs: number): Record<SpeakerRole, number> {
    const acc: Record<SpeakerRole, number> = { self: 0, other: 0, unknown: 0 }
    if (endMs <= startMs) return acc
    // Spans sind zeitlich sortiert; binäre Suche nach dem ersten relevanten.
    let lo = 0
    let hi = this.spans.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.spans[mid]!.endMs <= startMs) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < this.spans.length; i++) {
      const s = this.spans[i]!
      if (s.startMs >= endMs) break
      const overlap = Math.min(s.endMs, endMs) - Math.max(s.startMs, startMs)
      if (overlap > 0) acc[s.role] += overlap
    }
    return acc
  }

  /** Mehrheitsrolle, wenn sie mindestens `minShare` der bekannten Zeit abdeckt. */
  majority(startMs: number, endMs: number, minShare = 0.6): SpeakerRole {
    const ms = this.roleMs(startMs, endMs)
    const known = ms.self + ms.other
    if (known <= 0) return 'unknown'
    if (ms.self / known >= minShare) return 'self'
    if (ms.other / known >= minShare) return 'other'
    return 'unknown'
  }

  /** Speicher begrenzen: alles vor `beforeMs` verwerfen. */
  trimBefore(beforeMs: number) {
    let n = 0
    while (n < this.spans.length && this.spans[n]!.endMs < beforeMs) n++
    if (n > 0) this.spans.splice(0, n)
  }
}
