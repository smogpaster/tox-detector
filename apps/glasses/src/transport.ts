import { PROTOCOL_VERSION, parseServerMessage, type ClientMessage, type ServerMessage } from '@spiegel/shared'

type Listener = (msg: ServerMessage) => void

/** WebSocket zum eigenen Server mit automatischem Reconnect. */
export class Transport {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private stateListeners = new Set<(connected: boolean) => void>()
  private retryMs = 1000
  private closedByUser = false
  connected = false

  constructor(readonly url: string) {}

  get httpBase(): string {
    return this.url.replace(/^ws/, 'http').replace(/\/ws\/?$/, '')
  }

  connect() {
    this.closedByUser = false
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.connected = true
      this.retryMs = 1000
      this.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: 'glasses' })
      this.stateListeners.forEach(l => l(true))
    }
    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') return
      const msg = parseServerMessage(ev.data)
      if (msg) this.listeners.forEach(l => l(msg))
    }
    ws.onclose = () => {
      const was = this.connected
      this.connected = false
      this.ws = null
      if (was) this.stateListeners.forEach(l => l(false))
      if (!this.closedByUser) {
        window.setTimeout(() => this.connect(), this.retryMs)
        this.retryMs = Math.min(this.retryMs * 2, 10_000)
      }
    }
    ws.onerror = () => {
      /* onclose folgt */
    }
  }

  close() {
    this.closedByUser = true
    this.ws?.close()
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendBinary(data: Uint8Array): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(data)
    return true
  }

  onMessage(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onConnection(l: (connected: boolean) => void) {
    this.stateListeners.add(l)
    return () => this.stateListeners.delete(l)
  }
}
