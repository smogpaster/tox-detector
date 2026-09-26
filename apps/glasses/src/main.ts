import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { GlassesDisplay } from './display'
import { normalizeInput } from './input'
import { SessionController } from './session'
import { Transport } from './transport'
import { CompanionUi } from './ui/companion'

const WS_URL = import.meta.env.VITE_SERVER_WS_URL ?? 'ws://localhost:8787/ws'

const transport = new Transport(WS_URL)
const ui = new CompanionUi(transport.httpBase)

const bridge = await waitForEvenAppBridge()
const display = new GlassesDisplay(bridge)

// Startseite muss vor dem Mikrofon existieren (SDK-Hinweis: "For glasses MIC, create the startup page first").
const created = await display.createPage('SPIEGEL · verbinde mit Server …', 'Warte auf den Spiegel-Server.')
if (created !== 0) {
  console.error('createStartUpPageContainer fehlgeschlagen:', created)
  ui.setError(`Startseite konnte nicht erstellt werden (Code ${created})`)
}

const controller = new SessionController({ bridge, transport, display, ui })

const unsubscribe = bridge.onEvenHubEvent(event => {
  if (event.audioEvent?.audioPcm) {
    controller.onAudio(event.audioEvent)
    return
  }
  const input = normalizeInput(event)
  if (!input) return
  if (input.lifecycle) controller.onLifecycle(input.lifecycle)
  else if (input.gesture) controller.onGesture(input.gesture, input.fromRing)
})

transport.connect()

window.addEventListener('beforeunload', () => {
  unsubscribe()
  void controller.cleanup()
})
