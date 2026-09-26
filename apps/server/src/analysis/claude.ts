import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { Utterance, WindowAnalysis } from '@spiegel/shared'
import { config } from '../config'
import { log } from '../log'
import { REPORT_SYSTEM_PROMPT, WINDOW_SYSTEM_PROMPT, reportUserPrompt, windowUserPrompt } from './prompts'
import { ReportSchema, WindowAnalysisSchema, type ReportOutput, type WindowAnalysisOutput } from './schemas'

let client: Anthropic | null = null
function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey || undefined })
  return client
}

export class AnalysisRefused extends Error {
  constructor(public category: string | null) {
    super(`Analyse vom Modell abgelehnt${category ? ` (${category})` : ''}`)
  }
}

/** Ein Transkriptfenster analysieren. Strukturierte Ausgabe per JSON-Schema. */
export async function analyzeWindow(context: Utterance[], current: Utterance[], previous: WindowAnalysis[]): Promise<WindowAnalysisOutput> {
  if (config.analysisModel === 'mock') return mockWindow(current)
  const res = await getClient().messages.parse({
    model: config.analysisModel,
    max_tokens: 8000,
    system: [{ type: 'text', text: WINDOW_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: windowUserPrompt(context, current, previous) }],
    output_config: { format: zodOutputFormat(WindowAnalysisSchema), effort: 'medium' },
  })
  if (res.stop_reason === 'refusal') throw new AnalysisRefused(res.stop_details?.category ?? null)
  if (!res.parsed_output) throw new Error(`Fensteranalyse: keine gültige JSON-Ausgabe (stop_reason=${res.stop_reason})`)
  logUsage('window', res.usage)
  return res.parsed_output
}

/** Abschlussbericht aus Gesamttranskript und allen Fensterfunden. */
export async function generateReport(utterances: Utterance[], windows: WindowAnalysis[], speakerRoles: Record<string, string>): Promise<ReportOutput> {
  if (config.analysisModel === 'mock') return mockReport(utterances, windows)
  const res = await getClient().messages.parse({
    model: config.analysisModel,
    max_tokens: 16000,
    system: [{ type: 'text', text: REPORT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: reportUserPrompt(utterances, windows, speakerRoles) }],
    output_config: { format: zodOutputFormat(ReportSchema), effort: 'high' },
  })
  if (res.stop_reason === 'refusal') throw new AnalysisRefused(res.stop_details?.category ?? null)
  if (!res.parsed_output) throw new Error(`Bericht: keine gültige JSON-Ausgabe (stop_reason=${res.stop_reason})`)
  logUsage('report', res.usage)
  return res.parsed_output
}

function logUsage(kind: string, u: Anthropic.Usage) {
  log.info(`claude ${kind}: in=${u.input_tokens} cached=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens}`)
}

export function describeError(e: unknown): string {
  if (e instanceof AnalysisRefused) return e.message
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic: API-Key ungültig'
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic: Rate-Limit erreicht'
  if (e instanceof Anthropic.APIConnectionError) return 'Anthropic: keine Verbindung'
  if (e instanceof Anthropic.APIError) return `Anthropic: ${e.status ?? ''} ${e.message}`.trim()
  return e instanceof Error ? e.message : String(e)
}

// ---------- Mock (ANALYSIS_MODEL=mock): einfache Stichwortregeln, nur für Tests und Demos ----------

function mockWindow(current: Utterance[]): WindowAnalysisOutput {
  const findings: WindowAnalysisOutput['findings'] = []
  for (let i = 0; i < current.length; i++) {
    const u = current[i]!
    const prev = current[i - 1]
    const t = u.text.toLowerCase()
    const add = (pattern: WindowAnalysisOutput['findings'][number]['pattern'], intensity: 1 | 2 | 3, evidence: string) =>
      findings.push({ speaker: u.speaker, pattern, utteranceId: u.id, quote: u.text.split(/(?<=[.!?])\s/)[0]!, intensity, evidence,
        reactsTo: prev && prev.speaker !== u.speaker ? { utteranceId: prev.id, description: 'folgt direkt auf den vorherigen Beitrag' } : null })
    if (/\b(immer|nie|ständig|jedes mal)\b/.test(t)) add('pauschalisierung', 2, 'Verallgemeinerndes Wort')
    if (/\bdu hast\b|\bdu bist\b/.test(t)) add('vorwurf', 1, 'Du-Botschaft')
    if (/tut mir leid|entschuldig/.test(t)) add('reparaturversuch', 2, 'Entschuldigung')
    if (/ich versteh|verstehe ich/.test(t)) add('validierung', 2, 'Anerkennung der Sicht')
    if (/\?$/.test(u.text) && /kannst du|was dich|wie geht/.test(t)) add('nachfrage', 2, 'Offene Frage')
    if (/^ich (habe|hatte|fühle|wünsche)/.test(t)) add('ich_botschaft', 1, 'Eigenes Erleben benannt')
    if (u.overlapMs > 300) add('unterbrechen', 1, `Überlappung ${u.overlapMs} ms`)
  }
  const neg = findings.filter(f => !['reparaturversuch', 'validierung', 'nachfrage', 'ich_botschaft', 'humor', 'pause_annehmen'].includes(f.pattern)).length
  const tension = (Math.min(3, Math.floor(neg / 2)) as 0 | 1 | 2 | 3)
  return { findings, climate: `Mock: ${findings.length} Stichworttreffer, davon ${neg} problematisch.`, tension }
}

function mockReport(utterances: Utterance[], windows: WindowAnalysis[]): ReportOutput {
  const speakers = [...new Set(utterances.map(u => u.speaker))]
  const findings = windows.flatMap(w => w.findings)
  const first = utterances[0]!
  const last = utterances[utterances.length - 1]!
  return {
    summary: `MOCK-BERICHT (ANALYSIS_MODEL=mock): ${utterances.length} Beiträge von ${speakers.join(' und ')}, ${findings.length} Stichworttreffer in ${windows.length} Abschnitten. Dieser Text stammt nicht von einem Sprachmodell.`,
    perSpeaker: speakers.map(s => ({
      speaker: s,
      strengths: findings.filter(f => f.speaker === s && ['reparaturversuch', 'validierung', 'nachfrage', 'ich_botschaft'].includes(f.pattern)).map(f => `${f.pattern}: „${f.quote}“`).slice(0, 3),
      patternsToWatch: findings.filter(f => f.speaker === s && ['pauschalisierung', 'vorwurf', 'unterbrechen'].includes(f.pattern)).map(f => `${f.pattern}: „${f.quote}“`).slice(0, 3),
    })),
    dynamics: findings.filter(f => f.reactsTo).slice(0, 2).map(f => ({ name: `… → ${f.pattern}`, description: `${f.speaker} reagiert mit ${f.pattern}.`, example: { triggerUtteranceId: f.reactsTo!.utteranceId, responseUtteranceId: f.utteranceId } })),
    turningPoints: [{ utteranceId: last.id, description: 'Letzter Beitrag der Session (Mock).' }],
    positiveMoments: findings.filter(f => f.pattern === 'reparaturversuch' || f.pattern === 'validierung').slice(0, 2).map(f => ({ utteranceId: f.utteranceId, description: `${f.speaker}: ${f.pattern}` })),
    suggestions: [
      { forWhom: 'beide', suggestion: 'Vor einer Antwort einmal in eigenen Worten wiederholen, was gehört wurde.', why: `Bezug: ${first.id}` },
    ],
  }
}
