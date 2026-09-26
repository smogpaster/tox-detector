import { config } from '../config'
import { FakeAdapter } from './fake'
import { SonioxAdapter } from './soniox'
import type { SttAdapter } from './types'

export function createSttAdapter(): SttAdapter {
  switch (config.sttProvider) {
    case 'fake':
      return new FakeAdapter()
    case 'soniox':
    default:
      return new SonioxAdapter(config.soniox)
  }
}
export type { SttAdapter, SttStream, SttToken, SttBatch } from './types'
