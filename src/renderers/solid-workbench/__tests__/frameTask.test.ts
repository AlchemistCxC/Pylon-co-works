import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFrameTask } from '../frameTask.ts'

afterEach(() => vi.unstubAllGlobals())

describe.each(['frame', 'microtask'])('frame task with %s scheduling', mode => {
  function setup() {
    const callbacks: (() => void)[] = []
    vi.stubGlobal('requestAnimationFrame', mode === 'frame' ? (fn: () => void) => callbacks.push(fn) : undefined)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('queueMicrotask', (fn: () => void) => callbacks.push(fn))
    return () => { const batch = callbacks.splice(0); batch.forEach(fn => fn()) }
  }

  it('coalesces a burst and allows work to schedule the next frame', () => {
    const flush = setup()
    const seen: number[] = []
    const task = createFrameTask((value: number) => {
      seen.push(value)
      if (value === 1) task.schedule(3)
    })
    task.schedule(1)
    task.schedule(2)
    flush()
    expect(seen).toEqual([1])
    flush()
    expect(seen).toEqual([1, 3])
  })

  it('fences canceled callbacks even if the platform still delivers them', () => {
    const flush = setup()
    const run = vi.fn()
    const task = createFrameTask(run)
    task.schedule('old')
    task.cancel()
    task.schedule('new')
    flush()
    expect(run.mock.calls).toEqual([['new']])
    task.schedule('retired')
    task.dispose()
    task.schedule('after dispose')
    flush()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
