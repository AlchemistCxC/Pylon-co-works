import { describe, expect, it, vi } from 'vitest'
import {
  PYLON_CUSTOM_EVENT_NAMES,
  createPylonCustomEvent,
  dispatchPylonEvent,
  isPylonCustomEventName,
  onPylonEvent,
} from '../pylonCustomEvents.ts'

describe('pylon CustomEvent registry', () => {
  it('keeps the DOM event inventory unique and runtime-checkable', () => {
    expect(new Set(PYLON_CUSTOM_EVENT_NAMES).size).toBe(PYLON_CUSTOM_EVENT_NAMES.length)
    for (const name of PYLON_CUSTOM_EVENT_NAMES) expect(isPylonCustomEventName(name)).toBe(true)
    expect(isPylonCustomEventName('pylon:unknown')).toBe(false)
  })

  it('preserves typed detail and supports idempotent listener cleanup', () => {
    const target = new EventTarget()
    const listener = vi.fn()
    const stop = onPylonEvent(target, 'pylon:load-finished', listener)

    dispatchPylonEvent(target, 'pylon:load-finished', { source: 'local:one', generation: 3 })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0]?.[0].detail).toEqual({ source: 'local:one', generation: 3 })

    stop()
    stop()
    dispatchPylonEvent(target, 'pylon:load-finished', { source: 'local:one', generation: 4 })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('creates detail-free events without an accidental undefined detail payload', () => {
    const event = createPylonCustomEvent('pylon:tasks-toggle')
    expect(event.type).toBe('pylon:tasks-toggle')
    expect(event.detail).toBeNull()
  })
})
