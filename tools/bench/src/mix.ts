/**
 * Erzeugt Testmaterial für die Diarization-Bench: zwei Mono-Aufnahmen (je eine Person)
 * werden abwechselnd aneinandergehängt, wobei Person B um --gain-b dB abgesenkt wird.
 * Schreibt die Referenz-Sprechersegmente als JSON daneben.
 *
 *   npm run bench:mix -- --a person_a.wav --b person_b.wav --gain-b -12 --out mix_-12dB.wav
 */
import fs from 'node:fs'
import { clamp16, readWav, toMono16k, writeWav } from './wav'

const args = parseArgs(process.argv.slice(2))
const fileA = args.a
const fileB = args.b
if (!fileA || !fileB) {
  console.error('Nutzung: --a <wav> --b <wav> [--gain-b <dB>] [--turn-sec <s>] [--out <wav>]')
  process.exit(1)
}
const gainDb = Number(args['gain-b'] ?? 0)
const turnSec = Number(args['turn-sec'] ?? 6)
const out = args.out ?? `mix_${gainDb}dB.wav`

const a = toMono16k(readWav(fileA))
const b = toMono16k(readWav(fileB))
const gain = Math.pow(10, gainDb / 20)
const turn = Math.round(turnSec * 16_000)
const pause = Math.round(0.4 * 16_000)

const chunks: Int16Array[] = []
const ref: Array<{ startMs: number; endMs: number; speaker: string }> = []
let pa = 0
let pb = 0
let pos = 0
while (pa < a.length || pb < b.length) {
  for (const [src, ptr, spk, g] of [[a, pa, 'A', 1], [b, pb, 'B', gain]] as const) {
    const end = Math.min(src.length, ptr + turn)
    if (ptr >= src.length) continue
    const seg = Int16Array.from(src.subarray(ptr, end), v => clamp16(v * g))
    chunks.push(seg, new Int16Array(pause))
    ref.push({ startMs: Math.round((pos / 16_000) * 1000), endMs: Math.round(((pos + seg.length) / 16_000) * 1000), speaker: spk })
    pos += seg.length + pause
    if (spk === 'A') pa = end
    else pb = end
  }
}
const total = chunks.reduce((n, c) => n + c.length, 0)
const mixed = new Int16Array(total)
let o = 0
for (const c of chunks) {
  mixed.set(c, o)
  o += c.length
}
writeWav(out, mixed)
fs.writeFileSync(out.replace(/\.wav$/, '.ref.json'), JSON.stringify(ref, null, 2))
console.log(`geschrieben: ${out} (${(total / 16_000).toFixed(1)} s, B um ${gainDb} dB), Referenz: ${out.replace(/\.wav$/, '.ref.json')}`)

function parseArgs(argv: string[]): Record<string, string> {
  const r: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!
    if (k.startsWith('--')) r[k.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true'
  }
  return r
}
