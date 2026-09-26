/** Ergebnisse der Gesprächsanalyse (Meilenstein 2). Beide Sprecher werden mit denselben Kriterien betrachtet. */

export const PATTERNS = [
  // Gottman: die „vier apokalyptischen Reiter“
  'kritik',
  'verachtung',
  'rechtfertigung',
  'mauern',
  // weitere problematische Muster
  'eskalation',
  'unterbrechen',
  'sarkasmus',
  'pauschalisierung',
  'vorwurf',
  'gedankenlesen',
  'themenwechsel',
  // positive Signale
  'reparaturversuch',
  'validierung',
  'humor',
  'nachfrage',
  'ich_botschaft',
  'pause_annehmen',
] as const
export type Pattern = (typeof PATTERNS)[number]

export const POSITIVE_PATTERNS: ReadonlySet<Pattern> = new Set<Pattern>([
  'reparaturversuch', 'validierung', 'humor', 'nachfrage', 'ich_botschaft', 'pause_annehmen',
])

export const PATTERN_LABELS: Record<Pattern, string> = {
  kritik: 'Kritik an der Person',
  verachtung: 'Verachtung / Abwertung',
  rechtfertigung: 'Rechtfertigung / Abwehr',
  mauern: 'Mauern / Rückzug',
  eskalation: 'Eskalation',
  unterbrechen: 'Unterbrechen',
  sarkasmus: 'Sarkasmus',
  pauschalisierung: 'Pauschalisierung („immer“, „nie“)',
  vorwurf: 'Vorwurf statt Ich-Botschaft',
  gedankenlesen: 'Gedankenlesen / Unterstellung',
  themenwechsel: 'Themenwechsel / Ausweichen',
  reparaturversuch: 'Reparaturversuch',
  validierung: 'Validierung / Anerkennung',
  humor: 'Humor (verbindend)',
  nachfrage: 'Echte Nachfrage',
  ich_botschaft: 'Ich-Botschaft',
  pause_annehmen: 'Pause zulassen',
}

export interface Finding {
  /** Sprecherlabel (A, B, …) der Äußerung, in der das Muster auftritt. */
  speaker: string
  pattern: Pattern
  /** ID der Äußerung (u12). */
  utteranceId: string
  /** Wörtliches Zitat aus der Äußerung. */
  quote: string
  /** 1 = leicht, 2 = deutlich, 3 = stark. */
  intensity: 1 | 2 | 3
  /** Worauf reagiert diese Äußerung? null, wenn kein klarer Auslöser. */
  reactsTo: { utteranceId: string; description: string } | null
  /** Kurze, neutrale Begründung. */
  evidence: string
}

export interface WindowAnalysis {
  windowIndex: number
  fromUtteranceId: string
  toUtteranceId: string
  findings: Finding[]
  /** Neutrale Einschätzung der Dynamik in diesem Fenster (1 Satz). */
  climate: string
  /** 0 ruhig … 3 stark angespannt */
  tension: 0 | 1 | 2 | 3
}

export interface Hint {
  id: string
  text: string
  /** Anzeigedauer auf der Brille in ms. */
  ttlMs: number
  atMs: number
  reason: string
}

export interface SessionStats {
  durationMs: number
  talkMsBySpeaker: Record<string, number>
  utterancesBySpeaker: Record<string, number>
  interruptionsBySpeaker: Record<string, number>
  avgGapMs: number
  findingsBySpeaker: Record<string, Partial<Record<Pattern, number>>>
}

export interface Report {
  summary: string
  perSpeaker: Array<{ speaker: string; strengths: string[]; patternsToWatch: string[] }>
  dynamics: Array<{ name: string; description: string; example: { triggerUtteranceId: string; responseUtteranceId: string } | null }>
  turningPoints: Array<{ utteranceId: string; description: string }>
  positiveMoments: Array<{ utteranceId: string; description: string }>
  suggestions: Array<{ forWhom: 'beide' | string; suggestion: string; why: string }>
  stats: SessionStats
  disclaimer: string
  model: string
  generatedAt: string
}
