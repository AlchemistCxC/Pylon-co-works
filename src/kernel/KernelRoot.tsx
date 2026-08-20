import { useEffect, useSyncExternalStore } from 'react'
import ErrorBoundary from '../components/ErrorBoundary'
import SkinPreviewBar from '../components/kernel/SkinPreviewBar'
import ApplicationMount from './ApplicationMount'
import KernelRecoveryLayer from './KernelRecoveryLayer'
import { applicationRuntime } from './applicationRuntimeServices'
import { shouldExposeKernelAcceptanceControls } from './kernelAcceptanceControls'
import { BUILTIN_PYLON_SHELL_ID } from '../plugins/product/productPluginIds.ts'
import { kernelBootstrap } from './kernelBootstrapServices.ts'
import type { KernelBootstrap } from './kernelBootstrap.ts'
import type { ApplicationRuntime } from './applicationRuntime.ts'

export const BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID
export { applicationRuntime } from './applicationRuntimeServices'

export interface KernelRootProps {
  bootstrap?: KernelBootstrap
  runtime?: ApplicationRuntime
}

export function KernelRoot({
  bootstrap = kernelBootstrap,
  runtime = applicationRuntime,
}: KernelRootProps = {}) {
  const bootstrapState = useSyncExternalStore(
    bootstrap.subscribe,
    bootstrap.getSnapshot,
    bootstrap.getSnapshot,
  )
  useEffect(() => { void bootstrap.startNormal() }, [bootstrap])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!shouldExposeKernelAcceptanceControls(import.meta.env.DEV, window.localStorage)) return
    const controls = {
      unmountApplication: () => runtime.unmount(),
      remountApplication: () => runtime.mount(BUILTIN_PYLON_APPLICATION_ID),
      getSnapshot: () => runtime.getSnapshot(),
    }
    window.__PYLON_KERNEL_DEV__ = controls
    return () => {
      if (window.__PYLON_KERNEL_DEV__ === controls) delete window.__PYLON_KERNEL_DEV__
    }
  }, [runtime])

  return (
    <ErrorBoundary>
      <ApplicationMount
        runtime={runtime}
        recovery={(
          <KernelRecoveryLayer
            state={bootstrapState}
            onRetry={pluginId => { void bootstrap.retryPlugin(pluginId) }}
            onSafeMode={() => { void bootstrap.startSafeMode() }}
            onStartNormal={() => { void bootstrap.startNormal() }}
          />
        )}
      />
      {/* S5-D：Skin 预览作业面位于 Kernel 边界内，App 卸载/重挂不丢 preview 状态 */}
      <SkinPreviewBar />
    </ErrorBoundary>
  )
}

export default KernelRoot

declare global {
  interface Window {
    __PYLON_KERNEL_DEV__?: {
      unmountApplication: () => void
      remountApplication: () => void
      getSnapshot: () => ReturnType<typeof applicationRuntime.getSnapshot>
    }
  }
}
