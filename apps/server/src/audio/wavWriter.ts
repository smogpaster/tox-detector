import fs from 'node:fs'
import path from 'node:path'
import { PCM_SAMPLE_RATE } from '@spiegel/shared'

/**
 * NUR ENTWICKLUNG. Schreibt PCM s16le mono 16 kHz als WAV auf die Platte,
 * damit Brillenaufnahmen durch die Diarization-Bench laufen können.
 * Wird nur aktiv, wenn DEV_AUDIO_DUMP=true UND der Client es pro Session einschaltet.
 */
export class WavWriter {
  private fd: number
  private dataBytes = 0

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    this.fd = fs.openSync(filePath, 'w')
    fs.writeSync(this.fd, wavHeader(0))
  }

  write(pcm: Uint8Array) {
    fs.writeSync(this.fd, pcm)
    this.dataBytes += pcm.byteLength
  }

  close() {
    fs.writeSync(this.fd, wavHeader(this.dataBytes), 0, 44, 0)
    fs.closeSync(this.fd)
  }
}

export function wavHeader(dataBytes: number, sampleRate = PCM_SAMPLE_RATE, channels = 1): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}
