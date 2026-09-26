import path from 'node:path'

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

export type SttProviderName = 'soniox' | 'fake'

export const config = {
  port: Number(process.env.PORT ?? 8787),
  sttProvider: ((process.env.STT_PROVIDER ?? 'soniox').toLowerCase() as SttProviderName),
  soniox: {
    apiKey: process.env.SONIOX_API_KEY ?? '',
    wsUrl: process.env.SONIOX_WS_URL ?? 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
    model: process.env.SONIOX_MODEL ?? 'stt-rt-v5',
  },
  persistTranscripts: bool(process.env.PERSIST_TRANSCRIPTS, true),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  devAudioDump: bool(process.env.DEV_AUDIO_DUMP, false),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  analysisModel: process.env.ANALYSIS_MODEL ?? 'claude-opus-5',
  analysis: {
    /** Analyse nur, wenn ein Key da ist und sie nicht explizit abgeschaltet wurde. */
    enabled: bool(process.env.ANALYSIS_ENABLED, true) && Boolean(process.env.ANTHROPIC_API_KEY),
    windowUtterances: Number(process.env.ANALYSIS_WINDOW_UTTERANCES ?? 8),
    windowSeconds: Number(process.env.ANALYSIS_WINDOW_SECONDS ?? 60),
    minUtterances: 3,
    contextUtterances: 6,
  },
  hints: {
    enabled: bool(process.env.HINTS_ENABLED, true),
    minIntervalSec: Number(process.env.HINT_MIN_INTERVAL_SEC ?? 90),
    warmupSec: Number(process.env.HINT_WARMUP_SEC ?? 60),
    ttlMs: 8000,
  },
}

export function validateConfig(): string[] {
  const problems: string[] = []
  if (!['soniox', 'fake'].includes(config.sttProvider)) problems.push(`STT_PROVIDER unbekannt: ${config.sttProvider}`)
  if (config.sttProvider === 'soniox' && !config.soniox.apiKey) {
    problems.push('SONIOX_API_KEY fehlt. Setze den Key in apps/server/.env oder nutze STT_PROVIDER=fake.')
  }
  return problems
}
