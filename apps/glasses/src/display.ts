import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

/**
 * Brillen-Layout: zwei Textcontainer.
 *  1 "status": eine Zeile oben, dauerhafter Zustands-/Aufnahmeindikator (fängt die Events).
 *  2 "body":   Rest des Displays für Hinweise und Transkript.
 * Schreibzugriffe werden pro Container gedrosselt, weil die BLE-Queue langsam ist.
 */
const STATUS_ID = 1
const BODY_ID = 2
/** Grobe Obergrenze, damit der Body ohne Scrollen in 576x288 passt (Erfahrungswert aus den Templates). */
export const BODY_MAX_CHARS = 230

export class GlassesDisplay {
  private pending = new Map<number, string>()
  private last = new Map<number, string>()
  private timers = new Map<number, number>()
  private inflight = new Map<number, Promise<void>>()

  constructor(private bridge: EvenAppBridge) {}

  async createPage(status: string, body: string): Promise<number> {
    const statusContainer = new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 44,
      borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: STATUS_ID, containerName: 'status', content: status, isEventCapture: 1,
    })
    const bodyContainer = new TextContainerProperty({
      xPosition: 0, yPosition: 48, width: 576, height: 240,
      borderWidth: 0, borderColor: 0, paddingLength: 4,
      containerID: BODY_ID, containerName: 'body', content: body, isEventCapture: 0,
    })
    this.last.set(STATUS_ID, status)
    this.last.set(BODY_ID, body)
    return this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [statusContainer, bodyContainer] }),
    )
  }

  setStatus(text: string) {
    this.schedule(STATUS_ID, 'status', text, 150)
  }

  setBody(text: string) {
    this.schedule(BODY_ID, 'body', text.slice(-BODY_MAX_CHARS * 2), 300)
  }

  private schedule(id: number, name: string, text: string, delayMs: number) {
    this.pending.set(id, text)
    if (this.timers.has(id)) return
    this.timers.set(
      id,
      window.setTimeout(() => {
        this.timers.delete(id)
        void this.flush(id, name)
      }, delayMs),
    )
  }

  private async flush(id: number, name: string) {
    const text = this.pending.get(id)
    if (text === undefined || text === this.last.get(id)) return
    // Nie zwei Schreibvorgänge desselben Containers parallel.
    const prev = this.inflight.get(id)
    if (prev) await prev
    this.last.set(id, text)
    const p = this.bridge
      .textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content: text }))
      .then(() => undefined)
      .catch(err => console.warn('textContainerUpgrade fehlgeschlagen', err))
    this.inflight.set(id, p)
    await p
    this.inflight.delete(id)
    if (this.pending.get(id) !== text) this.schedule(id, name, this.pending.get(id)!, 100)
  }
}
