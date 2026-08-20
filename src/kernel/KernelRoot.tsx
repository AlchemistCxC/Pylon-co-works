import { useEffect } from 'react'
import ErrorBoundary from '../components/ErrorBoundary'
import SkinPreviewBar from '../components/kernel/SkinPreviewBar'
import ApplicationMount from './ApplicationMount'
import KernelRecoveryLayer from './KernelRecoveryLayer'
import { applicationRuntime } from './applicationRuntimeServices'
import { shouldExposeKernelAcceptanceControls } from './kernelAcceptanceControls'
import '../plugin-runtime/pluginCompositionRoot.ts'
import { BUILTIN_PYLON_SHELL_ID } from '../plugins/product/productPluginIds.ts'

export const BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID
export { applicationRuntime } from './applicationRuntimeServices'

applicationRuntime.mount(BUILTIN_PYLON_APPLICATION_ID)

export default function KernelRoot() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!shouldExposeKernelAcceptanceControls(import.meta.env.DEV, window.localStorage)) return
    const controls = {
      unmountApplication: () => applicationRuntime.unmount(),
      remountApplication: () => applicationRuntime.mount(BUILTIN_PYLON_APPLICATION_ID),
      getSnapshot: () => applicationRuntime.getSnapshot(),
    }
    window.__PYLON_KERNEL_DEV__ = controls
    return () => {
      if (window.__PYLON_KERNEL_DEV__ === controls) delete window.__PYLON_KERNEL_DEV__
    }
  }, [])

  return (
    <ErrorBoundary>
      <ApplicationMount
        runtime={applicationRuntime}
        recovery={(
          <KernelRecoveryLayer
            onRemount={() => applicationRuntime.mount(BUILTIN_PYLON_APPLICATION_ID)}
          />
        )}
      />
      {/* S5-D：Skin 预览作业面位于 Kernel 边界内，App 卸载/重挂不丢 preview 状态 */}
      <SkinPreviewBar />
    </ErrorBoundary>
  )
}

declare global {
  interface Window {
    __PYLON_KERNEL_DEV__?: {
      unmountApplication: () => void
      remountApplication: () => void
      getSnapshot: () => ReturnType<typeof applicationRuntime.getSnapshot>
    }
  }
}
