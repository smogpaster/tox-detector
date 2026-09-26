import type { SpeakerRole } from './protocol'

/**
 * Binärframe für Audio: kleiner Header + PCM s16le 16 kHz mono.
 *
 *  byte 0      : Frame-Typ, 0x01 = Audio
 *  byte 1      : Sprecherrolle 0 = unknown, 1 = self, 2 = other
 *  byte 2      : 1 wenn direction vorhanden, sonst 0
 *  byte 3..4   : direction als int16 LE (nur gültig, wenn byte 2 == 1)
 *  byte 5..    : PCM
 */
export const AUDIO_FRAME_HEADER_BYTES = 5
export const AUDIO_FRAME_TYPE = 0x01

/** PCM s16le mono 16 kHz: 32 Byte pro Millisekunde. */
export const PCM_BYTES_PER_MS = 32
export const PCM_SAMPLE_RATE = 16_000

const roleToByte: Record<SpeakerRole, number> = { unknown: 0, self: 1, other: 2 }
const byteToRole: SpeakerRole[] = ['unknown', 'self', 'other']

export interface AudioFrame {
  role: SpeakerRole
  direction: number | null
  pcm: Uint8Array
}

export function encodeAudioFrame(frame: AudioFrame): Uint8Array {
  const out = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + frame.pcm.byteLength)
  out[0] = AUDIO_FRAME_TYPE
  out[1] = roleToByte[frame.role]
  const view = new DataView(out.buffer)
  if (frame.direction === null || !Number.isFinite(frame.direction)) {
    out[2] = 0
    view.setInt16(3, 0, true)
  } else {
    out[2] = 1
    view.setInt16(3, Math.max(-32768, Math.min(32767, Math.round(frame.direction))), true)
  }
  out.set(frame.pcm, AUDIO_FRAME_HEADER_BYTES)
  return out
}

export function decodeAudioFrame(buf: Uint8Array): AudioFrame | null {
  if (buf.byteLength < AUDIO_FRAME_HEADER_BYTES || buf[0] !== AUDIO_FRAME_TYPE) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const role = byteToRole[buf[1] ?? 0] ?? 'unknown'
  const direction = buf[2] === 1 ? view.getInt16(3, true) : null
  return { role, direction, pcm: buf.subarray(AUDIO_FRAME_HEADER_BYTES) }
}

export function pcmBytesToMs(bytes: number): number {
  return bytes / PCM_BYTES_PER_MS
}
