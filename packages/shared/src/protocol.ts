/**
 * WebSocket-Protokoll zwischen Brillen-App (Client) und Server.
 * JSON-Nachrichten in beide Richtungen, Audio als Binärframes (siehe audioFrame.ts).
 */

export const PROTOCOL_VERSION = 1

export type SessionState = 'idle' | 'confirm' | 'active' | 'finishing' | 'report'

/** Sprecherrolle, wie die Brille sie pro PCM-Frame meldet (SDK >= 0.0.14). */
export type SpeakerRole = 'self' | 'other' | 'unknown'

export interface Utterance {
  id: string
  /** Vom STT-Dienst vergebenes Sprecherlabel, auf A/B/C… normalisiert. */
  speaker: string
  /** Mehrheitsentscheid der Brillen-Sprecherrolle über die Dauer des Beitrags. */
  roleHint: SpeakerRole
  text: string
  startMs: number
  endMs: number
  /** Überlappung mit dem vorherigen Beitrag eines anderen Sprechers in ms (0 = keine). */
  overlapMs: number
  /** Pause seit Ende des vorherigen Beitrags in ms. */
  gapMs: number
}

export interface InterimText {
  speaker: string | null
  text: string
}

export interface SpeakerInfo {
  label: string
  /** Wie oft die Brille Frames dieses Sprechers als self/other/unknown markiert hat (ms). */
  roleMs: Record<SpeakerRole, number>
}

export interface SessionSummary {
  id: string
  startedAt: string
  endedAt: string | null
  durationMs: number
  utteranceCount: number
  language: string
  persisted: boolean
}

// ---------- Client -> Server ----------

export type ClientMessage =
  | { type: 'hello'; protocolVersion: number; client: 'glasses' | 'bench' }
  | { type: 'session.start'; language: 'de' }
  | { type: 'session.stop' }
  | { type: 'debug.dump'; enabled: boolean }

// ---------- Server -> Client ----------

export type ServerMessage =
  | { type: 'hello'; protocolVersion: number; sttProvider: string; debugDumpAvailable: boolean }
  | { type: 'session.state'; state: SessionState; sessionId: string | null; startedAt: string | null; debugDump: boolean }
  | { type: 'transcript.update'; sessionId: string; utterances: Utterance[]; interim: InterimText; speakers: SpeakerInfo[] }
  | { type: 'session.ended'; summary: SessionSummary }
  | { type: 'error'; message: string; fatal: boolean }

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as { type?: unknown }
    if (typeof msg?.type !== 'string') return null
    return msg as ClientMessage
  } catch {
    return null
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as { type?: unknown }
    if (typeof msg?.type !== 'string') return null
    return msg as ServerMessage
  } catch {
    return null
  }
}
