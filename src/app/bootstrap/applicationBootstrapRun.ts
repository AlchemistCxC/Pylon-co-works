import { bootstrapApplication, type BootstrapDeps, type BootstrapResult } from './bootstrapApplication'

export interface ApplicationBootstrapRun {
  result: Promise<BootstrapResult>
  dispose: () => void
}

/**
 * 把一次 App 挂载对应的 bootstrap 与全局 listener 生命周期绑定。
 *
 * Kernel/Application 边界后，Application 子树允许卸载和重新挂载；这里保证：
 * - 卸载前 listener 尚未注册完成时，迟到的 handle 由 bootstrap 立即回收；
 * - 卸载后 listener 已注册完成时，由 dispose 回收；
 * - dispose 与 listener handle 都是幂等的，避免 StrictMode/重挂载重复释放。
 */
export function startApplicationBootstrap(
  deps: Omit<BootstrapDeps, 'cancelled'>,
): ApplicationBootstrapRun {
  let cancelled = false
  let disposeListeners: (() => void) | null = null

  const disposeListenerOnce = () => {
    const dispose = disposeListeners
    disposeListeners = null
    dispose?.()
  }

  const result = bootstrapApplication({
    ...deps,
    cancelled: () => cancelled,
    registerListeners: async () => {
      const dispose = await deps.registerListeners()
      let disposed = false
      disposeListeners = () => {
        if (disposed) return
        disposed = true
        dispose()
      }
      return disposeListenerOnce
    },
  })

  return {
    result,
    dispose: () => {
      if (cancelled) return
      cancelled = true
      disposeListenerOnce()
    },
  }
}
