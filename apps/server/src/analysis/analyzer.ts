import { EventEmitter } from 'node:events'
import type { Finding, Pattern, Report, SessionStats, SpeakerInfo, Utterance, WindowAnalysis } from '@spiegel/shared'
import { config } from '../config'
import { log } from '../log'
import { analyzeWindow, describeError, generateReport } from './claude'

export const DISCLAIMER =
  'Dieser Bericht beschreibt Gesprächsmuster auf Basis einer automatischen Transkription. Er ist keine Diagnose, kein Urteil über eine Person und ersetzt keine Paartherapie oder Beratung. Spracherkennung und Sprecherzuordnung können Fehler enthalten.'

interface AnalyzerEvents {
  window: [WindowAnalysis]
  progress: [{ windows: number; findings: number }]
  error: [string]
}

/**
 * Schickt Transkriptfenster nacheinander an Claude. Auslöser: genug neue Beiträge oder genug
 * verstrichene Zeit. Läuft strikt sequenziell, damit Funde aus früheren Fenstern als Kontext dienen.
 */
export class SessionAnalyzer extends EventEmitter<AnalyzerEvents> {
  readonly windows: WindowAnalysis[] = []
  private analyzedUpTo = 0
  private running = false
  private lastWindowAt = Date.now()
  private stopped = false

  constructor(private getUtterances: () => Utterance[]) {
    super()
  }

  get findings(): Finding[] {
    return this.windows.flatMap(w => w.findings)
  }

  /** Nach jeder Transkriptänderung aufrufen. */
  poke() {
    if (this.stopped || this.running) return
    const pending = this.getUtterances().length - this.analyzedUpTo
    const ageMs = Date.now() - this.lastWindowAt
    if (pending >= config.analysis.windowUtterances || (pending >= config.analysis.minUtterances && ageMs >= config.analysis.windowSeconds * 1000)) {
      void this.runWindow()
    }
  }

  /** Session-Ende: Rest analysieren, danach Bericht. */
  async finish(speakers: SpeakerInfo[], durationMs: number): Promise<Report | null> {
    this.stopped = true
    while (this.running) await new Promise(r => setTimeout(r, 100))
    const all = this.getUtterances()
    if (all.length - this.analyzedUpTo >= 1) await this.runWindow(true)
    if (all.length < 2) return null
    const speakerRoles = Object.fromEntries(speakers.map(s => [s.label, roleName(s)]))
    try {
      const out = await generateReport(all, this.windows, speakerRoles)
      return {
        ...out,
        stats: computeStats(all, this.findings, durationMs),
        disclaimer: DISCLAIMER,
        model: config.analysisModel,
        generatedAt: new Date().toISOString(),
      }
    } catch (e) {
      const msg = describeError(e)
      log.error('Bericht fehlgeschlagen:', msg)
      this.emit('error', `Bericht: ${msg}`)
      return null
    }
  }

  private async runWindow(force = false) {
    if (this.running) return
    this.running = true
    try {
      const all = this.getUtterances()
      const current = all.slice(this.analyzedUpTo)
      if (!current.length || (!force && current.length < config.analysis.minUtterances)) return
      const context = all.slice(Math.max(0, this.analyzedUpTo - config.analysis.contextUtterances), this.analyzedUpTo)
      const previous = this.windows.slice(-2)
      const out = await analyzeWindow(context, current, previous)
      const ids = new Set(current.map(u => u.id))
      const win: WindowAnalysis = {
        windowIndex: this.windows.length,
        fromUtteranceId: current[0]!.id,
        toUtteranceId: current[current.length - 1]!.id,
        // Nur Funde zu Äußerungen dieses Fensters übernehmen, wie im Prompt verlangt.
        findings: out.findings.filter(f => ids.has(f.utteranceId)),
        climate: out.climate,
        tension: out.tension,
      }
      this.windows.push(win)
      this.analyzedUpTo += current.length
      this.lastWindowAt = Date.now()
      this.emit('window', win)
      this.emit('progress', { windows: this.windows.length, findings: this.findings.length })
    } catch (e) {
      const msg = describeError(e)
      log.error('Fensteranalyse fehlgeschlagen:', msg)
      this.emit('error', `Analyse: ${msg}`)
      this.lastWindowAt = Date.now() // nicht sofort erneut versuchen
    } finally {
      this.running = false
    }
  }
}

function roleName(s: SpeakerInfo): string {
  const { self, other } = s.roleMs
  if (self + other < 2000) return 'unbekannt'
  if (self / (self + other) >= 0.6) return 'Brille'
  if (other / (self + other) >= 0.6) return 'Gegenüber'
  return 'unbekannt'
}

export function computeStats(utterances: Utterance[], findings: Finding[], durationMs: number): SessionStats {
  const talk: Record<string, number> = {}
  const count: Record<string, number> = {}
  const interruptions: Record<string, number> = {}
  const bySpeaker: Record<string, Partial<Record<Pattern, number>>> = {}
  let gapSum = 0
  let gapN = 0
  for (const u of utterances) {
    talk[u.speaker] = (talk[u.speaker] ?? 0) + (u.endMs - u.startMs)
    count[u.speaker] = (count[u.speaker] ?? 0) + 1
    if (u.overlapMs > 300) interruptions[u.speaker] = (interruptions[u.speaker] ?? 0) + 1
    if (u.gapMs > 0) {
      gapSum += u.gapMs
      gapN++
    }
  }
  for (const f of findings) {
    const m = (bySpeaker[f.speaker] ??= {})
    m[f.pattern] = (m[f.pattern] ?? 0) + 1
  }
  return { durationMs, talkMsBySpeaker: talk, utterancesBySpeaker: count, interruptionsBySpeaker: interruptions, avgGapMs: gapN ? Math.round(gapSum / gapN) : 0, findingsBySpeaker: bySpeaker }
}
