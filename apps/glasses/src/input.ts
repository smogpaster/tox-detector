import { EventSourceType, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type Gesture = 'click' | 'double' | 'long' | 'longRelease' | 'up' | 'down'
export type Lifecycle = 'systemExit' | 'abnormalExit' | 'foregroundEnter' | 'foregroundExit'

export interface InputEvent {
  gesture?: Gesture
  lifecycle?: Lifecycle
  fromRing: boolean
}

/**
 * CLICK_EVENT ist 0 und Protobuf lässt Nullwerte weg: Ein Tipp kommt als Envelope OHNE
 * eventType an. Der Default muss deshalb INNERHALB der Envelope-Prüfung aufgelöst werden
 * (siehe README der offiziellen Templates).
 */
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function toGesture(t: OsEventTypeList | null): Gesture | null {
  switch (t) {
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'double'
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'long'
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      return 'longRelease'
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'up'
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'down'
    case OsEventTypeList.CLICK_EVENT:
      return 'click'
    default:
      return null
  }
}

/** Normalisiert sys-/text-/list-Events zu einer Geste oder einem Lifecycle-Ereignis. */
export function normalizeInput(event: EvenHubEvent): InputEvent | null {
  const sys = event.sysEvent
  const sysType = eventTypeOf(sys)
  // Nur sysEvent trägt die Quelle (rechter/linker Bügel oder Ring).
  const fromRing = sys?.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING

  switch (sysType) {
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
      return { lifecycle: 'systemExit', fromRing }
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return { lifecycle: 'abnormalExit', fromRing }
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return { lifecycle: 'foregroundEnter', fromRing }
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return { lifecycle: 'foregroundExit', fromRing }
    case OsEventTypeList.IMU_DATA_REPORT:
      return null
  }

  // Tipps kommen auf sysEvent, Scrollen (und je nach Host auch Long Press) auf textEvent.
  const gesture = toGesture(sysType) ?? toGesture(eventTypeOf(event.textEvent)) ?? toGesture(eventTypeOf(event.listEvent))
  if (!gesture) return null
  if (gesture === 'longRelease') return null
  return { gesture, fromRing }
}
