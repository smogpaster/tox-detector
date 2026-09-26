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
}

export function validateConfig(): string[] {
  const problems: string[] = []
  if (!['soniox', 'fake'].includes(config.sttProvider)) problems.push(`STT_PROVIDER unbekannt: ${config.sttProvider}`)
  if (config.sttProvider === 'soniox' && !config.soniox.apiKey) {
    problems.push('SONIOX_API_KEY fehlt. Setze den Key in apps/server/.env oder nutze STT_PROVIDER=fake.')
  }
  return problems
}
