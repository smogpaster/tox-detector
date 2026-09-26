import fs from 'node:fs/promises'
import path from 'node:path'
import type { Hint, Report, SessionSummary, SpeakerInfo, Utterance, WindowAnalysis } from '@spiegel/shared'

export interface SessionRecord {
  id: string
  language: string
  startedAt: string
  endedAt: string | null
  durationMs: number
  utterances: Utterance[]
  speakers: SpeakerInfo[]
  windows: WindowAnalysis[]
  hints: Hint[]
  report: Report | null
  reportError: string | null
}

/**
 * Speichert Transkripte als eine JSON-Datei pro Session unter DATA_DIR/sessions.
 * Kein Rohaudio. Löschen entfernt die Datei vollständig.
 */
export class FileStore {
  constructor(private dir: string) {}

  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('ungültige Session-ID')
    return path.join(this.dir, `${id}.json`)
  }

  async save(rec: SessionRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = this.file(rec.id) + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(rec, null, 2))
    await fs.rename(tmp, this.file(rec.id))
  }

  async load(id: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as SessionRecord
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.file(id))
      return true
    } catch {
      return false
    }
  }

  async list(): Promise<SessionSummary[]> {
    let names: string[] = []
    try {
      names = (await fs.readdir(this.dir)).filter(n => n.endsWith('.json'))
    } catch {
      return []
    }
    const out: SessionSummary[] = []
    for (const n of names) {
      const rec = await this.load(n.replace(/\.json$/, ''))
      if (rec) out.push(toSummary(rec, true))
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }
}

export function toSummary(rec: SessionRecord, persisted: boolean): SessionSummary {
  return {
    id: rec.id,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.durationMs,
    utteranceCount: rec.utterances.length,
    language: rec.language,
    persisted,
    hasReport: rec.report !== null,
  }
}
