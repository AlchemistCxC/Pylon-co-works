import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { SessionUiKey, SessionUiStore } from '../../../domains/workbench/sessionUiStore.ts'

export type SessionUiSignalSetter<T> = (valueOrUpdater: T | ((previous: T) => T)) => T

export function createSessionUiSignal<T>(
  store: SessionUiStore,
  sessionId: Accessor<string | null>,
  key: SessionUiKey,
  fallback: T,
): [Accessor<T>, SessionUiSignalSetter<T>] {
  const [value, setValue] = createSignal<T>(fallback)

  createEffect(() => {
    const id = sessionId()
    if (!id) {
      setValue(() => fallback)
      return
    }
    const sync = () => setValue(() => store.get(id, key, fallback))
    sync()
    const unsubscribe = store.subscribe(id, key, sync)
    onCleanup(unsubscribe)
  })

  const set: SessionUiSignalSetter<T> = valueOrUpdater => {
    const id = sessionId()
    const previous = id ? store.get(id, key, fallback) : value()
    const next = typeof valueOrUpdater === 'function'
      ? (valueOrUpdater as (current: T) => T)(previous)
      : valueOrUpdater
    if (id) store.set(id, key, next)
    else setValue(() => next)
    return next
  }

  return [value, set]
}
