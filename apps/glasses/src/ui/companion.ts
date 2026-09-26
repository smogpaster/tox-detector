import type { InterimText, SessionSummary, SpeakerInfo, Utterance } from '@spiegel/shared'
import type { UiState } from '../session'

type Action = 'start' | 'stop' | 'debugDump'

/** Companion-Ansicht auf dem Handy: Status, Live-Transkript, gespeicherte Sessions, Löschen. */
export class CompanionUi {
  private root: HTMLElement
  private actions = new Set<(a: Action) => void>()
  private el!: Record<'status' | 'error' | 'transcript' | 'summary' | 'sessions' | 'startBtn' | 'stopBtn' | 'dbgWrap' | 'dbgBtn' | 'server', HTMLElement>

  constructor(private httpBase: string) {
    this.root = document.querySelector<HTMLElement>('#app')!
    this.mount()
    void this.refreshSessions()
  }

  onAction(l: (a: Action) => void) {
    this.actions.add(l)
  }

  setState(state: UiState, debugDump: boolean) {
    const label: Record<UiState, string> = {
      connecting: 'Verbinde …', idle: 'Bereit', confirm: 'Bestätigen', active: 'Aufnahme läuft',
      finishing: 'Wird abgeschlossen', report: 'Beendet',
    }
    this.el.status.textContent = label[state]
    this.el.status.className = `chip chip-${state}`
    ;(this.el.startBtn as HTMLButtonElement).disabled = !(state === 'idle' || state === 'report' || state === 'confirm')
    ;(this.el.stopBtn as HTMLButtonElement).disabled = state !== 'active'
    this.el.dbgBtn.textContent = debugDump ? 'Debug-Aufnahme: AN' : 'Debug-Aufnahme: aus'
    this.el.dbgBtn.classList.toggle('danger', debugDump)
    if (state === 'report') void this.refreshSessions()
  }

  setServerInfo(stt: string, debugAvailable: boolean) {
    this.el.server.textContent = `Server: ${this.httpBase} · STT: ${stt}`
    this.el.dbgWrap.style.display = import.meta.env.DEV && debugAvailable ? '' : 'none'
  }

  setError(msg: string) {
    this.el.error.textContent = msg
    this.el.error.style.display = ''
    window.setTimeout(() => (this.el.error.style.display = 'none'), 8000)
  }

  setTranscript(utterances: Utterance[], interim: InterimText, speakers: SpeakerInfo[]) {
    const roleTag = (u: Utterance) => (u.roleHint === 'unknown' ? '' : `<span class="role">${u.roleHint === 'self' ? 'Brille' : 'Gegenüber'}</span>`)
    const rows = utterances.map(
      u => `<div class="utt sp-${u.speaker}"><span class="who">${u.speaker}</span>${roleTag(u)}<span class="txt">${esc(u.text)}</span>${u.overlapMs > 300 ? '<span class="ovl" title="Überlappung">⟂</span>' : ''}</div>`,
    )
    if (interim.text) rows.push(`<div class="utt interim sp-${interim.speaker ?? ''}"><span class="who">${interim.speaker ?? '?'}</span><span class="txt">${esc(interim.text)}</span></div>`)
    this.el.transcript.innerHTML = rows.join('') || '<div class="muted">Noch nichts erkannt.</div>'
    this.el.transcript.scrollTop = this.el.transcript.scrollHeight
    const sp = speakers.map(s => `${s.label}: Brille ${fmtMs(s.roleMs.self)} / Gegenüber ${fmtMs(s.roleMs.other)}`).join(' · ')
    this.el.summary.textContent = sp
  }

  setSummary(s: SessionSummary) {
    this.el.summary.textContent = `Session ${s.id}: ${s.utteranceCount} Beiträge, ${fmtMs(s.durationMs)}${s.persisted ? ', gespeichert' : ', nicht gespeichert'}`
  }

  async refreshSessions() {
    try {
      const res = await fetch(`${this.httpBase}/api/sessions`)
      const list = (await res.json()) as SessionSummary[]
      this.el.sessions.innerHTML =
        list
          .map(
            s => `<div class="sess"><div><b>${s.id}</b> · ${new Date(s.startedAt).toLocaleString('de-DE')} · ${s.utteranceCount} Beiträge · ${fmtMs(s.durationMs)}</div>
                  <button data-del="${s.id}" class="danger small">Löschen</button></div>`,
          )
          .join('') || '<div class="muted">Keine gespeicherten Sessions.</div>'
      this.el.sessions.querySelectorAll<HTMLButtonElement>('button[data-del]').forEach(b => {
        b.onclick = async () => {
          if (!confirm(`Session ${b.dataset.del} unwiderruflich löschen?`)) return
          await fetch(`${this.httpBase}/api/sessions/${b.dataset.del}`, { method: 'DELETE' })
          void this.refreshSessions()
        }
      })
    } catch {
      this.el.sessions.innerHTML = '<div class="muted">Server nicht erreichbar.</div>'
    }
  }

  private mount() {
    this.root.innerHTML = `
      <main class="panel">
        <header><h1>Kommunikations-Spiegel</h1><div id="status" class="chip chip-connecting">Verbinde …</div></header>
        <div id="error" class="error" style="display:none"></div>
        <div class="row">
          <button id="startBtn" disabled>Session starten</button>
          <button id="stopBtn" class="danger" disabled>Beenden</button>
        </div>
        <p class="hint">Auf der Brille: Ring lang drücken = starten/beenden, Tipp = bestätigen, Doppeltipp = abbrechen/App beenden.</p>
        <section id="transcript" class="transcript" aria-live="polite"><div class="muted">Noch keine Session.</div></section>
        <div id="summary" class="muted small"></div>
        <div id="dbgWrap" style="display:none"><button id="dbgBtn" class="small">Debug-Aufnahme: aus</button>
          <span class="muted small">Nur Entwicklung: schreibt Rohaudio als WAV für die Diarization-Bench.</span></div>
        <h2>Gespeicherte Sessions</h2>
        <section id="sessions"></section>
        <footer id="server" class="muted small"></footer>
        <p class="muted small">Dieses Werkzeug macht Gesprächsmuster sichtbar. Es stellt keine Diagnosen und ersetzt keine Paartherapie.</p>
      </main>`
    const q = (id: string) => this.root.querySelector<HTMLElement>(`#${id}`)!
    this.el = {
      status: q('status'), error: q('error'), transcript: q('transcript'), summary: q('summary'), sessions: q('sessions'),
      startBtn: q('startBtn'), stopBtn: q('stopBtn'), dbgWrap: q('dbgWrap'), dbgBtn: q('dbgBtn'), server: q('server'),
    }
    this.el.startBtn.onclick = () => this.actions.forEach(l => l('start'))
    this.el.stopBtn.onclick = () => this.actions.forEach(l => l('stop'))
    this.el.dbgBtn.onclick = () => this.actions.forEach(l => l('debugDump'))
    injectStyles()
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
function fmtMs(ms: number) {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`
}

function injectStyles() {
  const css = `
    :root { color-scheme: dark; }
    html, body { background: #232323; color: #E5E5E5; font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    .panel { display: flex; flex-direction: column; gap: 14px; max-width: 640px; margin: 0 auto; padding: 20px 16px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    h1 { font-size: 18px; margin: 0; } h2 { font-size: 15px; margin: 8px 0 0; color: #A7A7A7; }
    .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #3E3E3E; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
    .chip-active { color: #3CFA44; border-color: #3CFA44; background: rgba(60,250,68,.08); }
    .chip-confirm, .chip-finishing { color: #FFD60A; border-color: #FFD60A; }
    .chip-connecting { color: #A7A7A7; }
    .row { display: flex; gap: 10px; }
    button { flex: 1; padding: 12px; border-radius: 10px; border: 1px solid #3CFA44; background: transparent; color: #3CFA44; font-size: 15px; }
    button:disabled { opacity: .35; }
    button.danger { border-color: #FF453A; color: #FF453A; }
    button.small { flex: 0; padding: 6px 10px; font-size: 13px; }
    .hint, .small { font-size: 12px; } .muted { color: #8A8A8A; }
    .error { color: #FF453A; border: 1px solid #FF453A; border-radius: 10px; padding: 8px 12px; font-size: 13px; }
    .transcript { background: #2E2E2E; border: 1px solid #3E3E3E; border-radius: 12px; padding: 12px; min-height: 200px; max-height: 45vh; overflow: auto; }
    .utt { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #383838; align-items: baseline; }
    .utt .who { font-weight: 700; min-width: 1.4em; }
    .sp-A .who { color: #7CD4FF; } .sp-B .who { color: #FFB86C; } .sp-C .who { color: #C3A6FF; }
    .utt .role { font-size: 10px; color: #8A8A8A; border: 1px solid #4A4A4A; border-radius: 6px; padding: 0 4px; }
    .utt .ovl { color: #FFD60A; }
    .utt.interim .txt { color: #9A9A9A; font-style: italic; }
    .sess { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid #383838; font-size: 13px; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
