/** Coalesce visual work into one frame; cancellation also fences fallback microtasks. */
export function createFrameTask<T extends unknown[]>(callback: (...args: T) => void) {
  let pending: { frame?: number } | undefined
  let disposed = false
  const cancel = () => {
    if (pending?.frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending.frame)
    pending = undefined
  }
  return {
    schedule(...args: T) {
      if (disposed || pending) return
      const task: { frame?: number } = {}
      pending = task
      const run = () => {
        if (pending !== task || disposed) return
        pending = undefined
        callback(...args)
      }
      if (typeof requestAnimationFrame === 'function') task.frame = requestAnimationFrame(run)
      else queueMicrotask(run)
    },
    cancel,
    dispose() { disposed = true; cancel() },
  }
}
