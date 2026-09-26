/**
 * Diarization-Bench: spielt eine WAV-Datei so an den Server, als käme sie von der Brille,
 * druckt die erkannten Beiträge mit Sprecherlabels und bewertet sie optional gegen eine
 * Referenz (JSON: [{startMs,endMs,speaker}]).
 *
 *   npm run bench:feed -- --file aufnahme.wav [--ref aufnahme.ref.json] [--speed 4] [--url ws://localhost:8787/ws]
 */
import fs from 'node:fs'
import WebSocket from 'ws'
import { encodeAudioFrame, PROTOCOL_VERSION, parseServerMessage, type Utterance } from '@spiegel/shared'
import { readWav, toMono16k } from './wav'

const args = parseArgs(process.argv.slice(2))
if (!args.file) {
  console.error('Nutzung: --file <wav> [--ref <json>] [--speed <faktor>] [--url <ws>]')
  process.exit(1)
}
const url = args.url ?? 'ws://localhost:8787/ws'
const speed = Number(args.speed ?? 1)
const pcm = toMono16k(readWav(args.file))
const totalMs = (pcm.length / 16_000) * 1000
console.log(`Datei: ${args.file}, ${(totalMs / 1000).toFixed(1)} s, Tempo x${speed}, Server ${url}`)

const ws = new WebSocket(url)
let utterances: Utterance[] = []
let printed = 0

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: 'bench' }))
  ws.send(JSON.stringify({ type: 'session.start', language: 'de' }))
})

ws.on('message', data => {
  const msg = parseServerMessage(data.toString())
  if (!msg) return
  if (msg.type === 'session.state' && msg.state === 'active') void stream()
  if (msg.type === 'transcript.update') {
    utterances = msg.utterances
    for (; printed < utterances.length; printed++) {
      const u = utterances[printed]!
      console.log(`${fmt(u.startMs)}-${fmt(u.endMs)}  ${u.speaker} [${u.roleHint}]${u.overlapMs > 0 ? ` overlap ${u.overlapMs}ms` : ''}: ${u.text}`)
    }
  }
  if (msg.type === 'session.ended') {
    console.log(`\nSession ${msg.summary.id}: ${msg.summary.utteranceCount} Beiträge`)
    if (args.ref) score(JSON.parse(fs.readFileSync(args.ref, 'utf8')))
    ws.close()
  }
  if (msg.type === 'error') console.error('Server:', msg.message)
})
ws.on('error', e => {
  console.error('WS-Fehler:', e.message)
  process.exit(1)
})

async function stream() {
  const frameSamples = 1600 // 100 ms wie der Simulator
  const t0 = Date.now()
  let sentMs = 0
  for (let i = 0; i < pcm.length; i += frameSamples) {
    const chunk = pcm.subarray(i, Math.min(pcm.length, i + frameSamples))
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    ws.send(encodeAudioFrame({ role: 'unknown', direction: null, pcm: bytes }))
    sentMs += (chunk.length / 16_000) * 1000
    const wait = sentMs / speed - (Date.now() - t0)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
  }
  ws.send(JSON.stringify({ type: 'session.stop' }))
}

/** Frame-genaue Sprecherübereinstimmung (10-ms-Raster) mit bestmöglicher Label-Zuordnung. */
function score(ref: Array<{ startMs: number; endMs: number; speaker: string }>) {
  const step = 10
  const n = Math.ceil(totalMs / step)
  const refLab = new Array<string | null>(n).fill(null)
  const hypLab = new Array<string | null>(n).fill(null)
  for (const r of ref) for (let t = r.startMs; t < r.endMs; t += step) refLab[Math.floor(t / step)] = r.speaker
  for (const u of utterances) for (let t = u.startMs; t < u.endMs; t += step) hypLab[Math.floor(t / step)] = u.speaker
  const refSpk = [...new Set(ref.map(r => r.speaker))]
  const hypSpk = [...new Set(utterances.map(u => u.speaker))]
  let best = { acc: 0, map: {} as Record<string, string> }
  for (const perm of permutations(hypSpk)) {
    const map: Record<string, string> = {}
    perm.forEach((h, i) => (map[h] = refSpk[i] ?? '?'))
    let hit = 0
    let tot = 0
    for (let i = 0; i < n; i++) {
      if (refLab[i] === null) continue
      tot++
      if (hypLab[i] !== null && map[hypLab[i]!] === refLab[i]) hit++
    }
    const acc = tot ? hit / tot : 0
    if (acc > best.acc) best = { acc, map }
  }
  console.log(`Sprecher-Genauigkeit (Zeitanteil der Referenz korrekt zugeordnet): ${(best.acc * 100).toFixed(1)} %  Zuordnung: ${JSON.stringify(best.map)}`)
  for (const s of refSpk) {
    let tot = 0
    let hit = 0
    for (let i = 0; i < n; i++) {
      if (refLab[i] !== s) continue
      tot++
      if (hypLab[i] !== null && best.map[hypLab[i]!] === s) hit++
    }
    console.log(`  Referenz ${s}: ${(tot ? (hit / tot) * 100 : 0).toFixed(1)} % erkannt`)
  }
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  return arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [x, ...p]))
}
function fmt(ms: number) {
  const s = ms / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
function parseArgs(argv: string[]): Record<string, string> {
  const r: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!
    if (k.startsWith('--')) r[k.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true'
  }
  return r
}
