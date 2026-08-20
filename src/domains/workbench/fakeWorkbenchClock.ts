import type { WorkbenchClock } from './generationFooterContracts.ts'

interface ScheduledTask {
  id: number
  callback: () => void
  dueAt: number
  intervalMs: number | null
}

export interface FakeWorkbenchClock extends WorkbenchClock {
  advance(ms: number): void
  activeTaskCount(): number
}

export function createFakeWorkbenchClock(initialNow = 0): FakeWorkbenchClock {
  let now = initialNow
  let nextId = 1
  const tasks = new Map<number, ScheduledTask>()

  const schedule = (callback: () => void, delayMs: number, intervalMs: number | null) => {
    const id = nextId++
    tasks.set(id, {
      id,
      callback,
      dueAt: now + Math.max(0, delayMs),
      intervalMs,
    })
    return id
  }

  return {
    now: () => now,
    setInterval(callback, intervalMs) {
      const safeInterval = Math.max(1, intervalMs)
      return schedule(callback, safeInterval, safeInterval)
    },
    clearInterval(handle) { tasks.delete(handle as number) },
    setTimeout(callback, delayMs) { return schedule(callback, delayMs, null) },
    clearTimeout(handle) { tasks.delete(handle as number) },
    activeTaskCount: () => tasks.size,
    advance(ms) {
      const target = now + Math.max(0, ms)
      while (true) {
        const next = [...tasks.values()]
          .filter(task => task.dueAt <= target)
          .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
        if (!next) break
        now = next.dueAt
        if (!tasks.has(next.id)) continue
        if (next.intervalMs === null) tasks.delete(next.id)
        else next.dueAt += next.intervalMs
        next.callback()
      }
      now = target
    },
  }
}
