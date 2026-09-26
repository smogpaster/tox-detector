import { PATTERN_LABELS, POSITIVE_PATTERNS, type Pattern, type Report, type Utterance } from '@spiegel/shared'
import type { SessionRecord } from '../store/fileStore'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Nachbetrachtung als eigenständige HTML-Seite (für Handy oder Mac). */
export function renderReportHtml(rec: SessionRecord): string {
  const r = rec.report
  const byId = new Map(rec.utterances.map(u => [u.id, u]))
  const quote = (id: string) => {
    const u = byId.get(id)
    return u ? `<blockquote><span class="who">${esc(u.speaker)}</span> <span class="t">${fmt(u.startMs)}</span> ${esc(u.text)}</blockquote>` : ''
  }
  const body = r ? renderReport(r, quote) : `<p class="muted">Für diese Session liegt keine Auswertung vor${rec.reportError ? `: ${esc(rec.reportError)}` : '.'}</p>`
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spiegel · Session ${esc(rec.id)}</title>
<style>
:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:0 auto;padding:20px 16px;color:#222;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#e5e5e5;background:#1c1c1c}blockquote{background:#2a2a2a}.card{background:#262626;border-color:#3a3a3a}}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}.muted{color:#888}.small{font-size:13px}
.card{border:1px solid #ddd;border-radius:12px;padding:12px 16px;margin:10px 0;background:#fff}
blockquote{margin:6px 0;padding:8px 12px;border-left:3px solid #7cd4ff;background:#f0f0f0;border-radius:6px;font-size:14px}
.who{font-weight:700}.t{color:#888;font-size:12px}ul{padding-left:20px}
table{border-collapse:collapse;font-size:14px}td,th{padding:4px 10px;text-align:left;border-bottom:1px solid #ddd}
.pos{color:#2e9e3e}.neg{color:#b0552d}.disclaimer{border:1px solid #c9a227;border-radius:10px;padding:10px 14px;font-size:13px;margin-top:28px}
details{margin-top:24px}
</style></head><body>
<h1>Kommunikations-Spiegel · Nachbetrachtung</h1>
<p class="muted small">Session ${esc(rec.id)} · ${new Date(rec.startedAt).toLocaleString('de-DE')} · ${fmt(rec.durationMs)} min · ${rec.utterances.length} Beiträge</p>
${body}
<details><summary>Transkript</summary>${rec.utterances.map(u => quote(u.id)).join('')}</details>
</body></html>`
}

function renderReport(r: Report, quote: (id: string) => string): string {
  const speakers = Object.keys(r.stats.talkMsBySpeaker)
  const totalTalk = Object.values(r.stats.talkMsBySpeaker).reduce((a, b) => a + b, 0) || 1
  const statRows = speakers
    .map(
      s => `<tr><td><b>${esc(s)}</b></td><td>${Math.round(((r.stats.talkMsBySpeaker[s] ?? 0) / totalTalk) * 100)} % Redeanteil</td><td>${r.stats.utterancesBySpeaker[s] ?? 0} Beiträge</td><td>${r.stats.interruptionsBySpeaker[s] ?? 0}× ins Wort gefallen</td></tr>`,
    )
    .join('')
  const patternRows = speakers
    .map(s => {
      const m = r.stats.findingsBySpeaker[s] ?? {}
      const items = (Object.entries(m) as Array<[Pattern, number]>)
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `<li class="${POSITIVE_PATTERNS.has(p) ? 'pos' : 'neg'}">${esc(PATTERN_LABELS[p])}: ${n}×</li>`)
        .join('')
      return `<div class="card"><b>${esc(s)}</b><ul>${items || '<li class="muted">keine Funde</li>'}</ul></div>`
    })
    .join('')
  return `
<h2>Zusammenfassung</h2><p>${esc(r.summary)}</p>
<h2>Zahlen</h2><table>${statRows}</table><p class="small muted">Durchschnittliche Pause zwischen Beiträgen: ${(r.stats.avgGapMs / 1000).toFixed(1)} s</p>
<h2>Beide Personen im Blick</h2>
${r.perSpeaker.map(p => `<div class="card"><b>${esc(p.speaker)}</b><p><span class="pos">Gelungen:</span></p><ul>${p.strengths.map(x => `<li>${esc(x)}</li>`).join('') || '<li class="muted">–</li>'}</ul><p><span class="neg">Zum Hinschauen:</span></p><ul>${p.patternsToWatch.map(x => `<li>${esc(x)}</li>`).join('') || '<li class="muted">–</li>'}</ul></div>`).join('')}
<h2>Wechselwirkungen</h2>
${r.dynamics.map(d => `<div class="card"><b>${esc(d.name)}</b><p>${esc(d.description)}</p>${d.example ? quote(d.example.triggerUtteranceId) + quote(d.example.responseUtteranceId) : ''}</div>`).join('') || '<p class="muted">Keine ausgeprägten Wechselwirkungen.</p>'}
<h2>Wendepunkte</h2>
${r.turningPoints.map(t => `<div class="card"><p>${esc(t.description)}</p>${quote(t.utteranceId)}</div>`).join('') || '<p class="muted">–</p>'}
<h2>Positive Momente</h2>
${r.positiveMoments.map(t => `<div class="card"><p>${esc(t.description)}</p>${quote(t.utteranceId)}</div>`).join('') || '<p class="muted">–</p>'}
<h2>Vorschläge</h2>
<ul>${r.suggestions.map(s => `<li><b>${esc(s.forWhom)}:</b> ${esc(s.suggestion)} <span class="muted small">(${esc(s.why)})</span></li>`).join('')}</ul>
<h2>Gefundene Muster je Person</h2>${patternRows}
<div class="disclaimer">${esc(r.disclaimer)}</div>
<p class="muted small">Modell: ${esc(r.model)} · erstellt ${new Date(r.generatedAt).toLocaleString('de-DE')}</p>`
}

export type { Utterance }
