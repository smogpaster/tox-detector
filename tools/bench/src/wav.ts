import fs from 'node:fs'

export interface Wav {
  sampleRate: number
  channels: number
  /** Interleaved s16le Samples. */
  samples: Int16Array
}

/** Liest PCM-WAV (16 Bit). Andere Formate werden abgelehnt. */
export function readWav(file: string): Wav {
  const buf = fs.readFileSync(file)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: kein WAV`)
  let off = 12
  let fmt: { channels: number; sampleRate: number; bits: number; format: number } | null = null
  let data: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = buf.subarray(off + 8, off + 8 + size)
    if (id === 'fmt ') fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) }
    if (id === 'data') data = body
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error(`${file}: fmt/data-Chunk fehlt`)
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${file}: nur PCM 16 Bit unterstützt (format=${fmt.format}, bits=${fmt.bits})`)
  const samples = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength - (data.byteLength % 2)))
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples }
}

export function writeWav(file: string, samples: Int16Array, sampleRate = 16_000) {
  const h = Buffer.alloc(44)
  const dataBytes = samples.length * 2
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40)
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]))
}

/** Auf mono 16 kHz bringen (Kanalmittelung + lineare Interpolation). */
export function toMono16k(w: Wav): Int16Array {
  const frames = Math.floor(w.samples.length / w.channels)
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let c = 0; c < w.channels; c++) s += w.samples[i * w.channels + c]!
    mono[i] = s / w.channels
  }
  if (w.sampleRate === 16_000) return Int16Array.from(mono, v => clamp16(v))
  const ratio = w.sampleRate / 16_000
  const outLen = Math.floor(frames / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(frames - 1, i0 + 1)
    const t = pos - i0
    out[i] = clamp16(mono[i0]! * (1 - t) + mono[i1]! * t)
  }
  return out
}

export function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)))
}
