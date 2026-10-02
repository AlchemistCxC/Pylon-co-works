/** @jsxImportSource solid-js */
import { createSignal, ErrorBoundary, onCleanup, onMount } from 'solid-js'
import SkinPreviewBar from '../components/kernel/SkinPreviewBar.solid.tsx'
import ApplicationMount from './ApplicationMount.solid.tsx'
import KernelRecoveryLayer from './KernelRecoveryLayer.solid.tsx'
import { applicationRuntime } from '../application/applicationRuntimeServices.ts'
import { shouldExposeKernelAcceptanceControls } from './kernelAcceptanceControls'
import { listRendererDiagnosticsKeys, readRendererDiagnostics } from '../plugin-runtime/renderers/rendererDiagnosticsRegistry.ts'
import { BUILTIN_PYLON_SHELL_ID } from '../plugins/product/productPluginIds.ts'
import { kernelBootstrap } from './kernelBootstrapServices.ts'
import { startupMark } from '../app/startupTiming.ts'
import type { KernelBootstrap } from './kernelBootstrap.ts'
import type { ApplicationRuntime } from '../application/applicationRuntime.ts'

export const BUILTIN_PYLON_APPLICATION_ID = BUILTIN_PYLON_SHELL_ID
export { applicationRuntime } from '../application/applicationRuntimeServices.ts'

export interface KernelRootProps {
  bootstrap?: KernelBootstrap
  runtime?: ApplicationRuntime
}

/**
 * Kernel 根（#515：React → Solid 实体，main.tsx 以 solid `render` 挂载）。
 *
 * 应用级错误边界原为 React class ErrorBoundary（components/ErrorBoundary.tsx）——
 * React 边界接不住 Solid 子树的错误，随根翻转改为 solid ErrorBoundary，
 * fallback DOM（内联样式/文案/重试按钮）逐字节保持。
 */
export function KernelRoot(props: KernelRootProps = {}) {
  let reportedCrash: unknown
  const bootstrap = () => props.bootstrap ?? kernelBootstrap
  const runtime = () => props.runtime ?? applicationRuntime
  const [bootstrapState, setBootstrapState] = createSignal(bootstrap().getSnapshot())
  onCleanup(bootstrap().subscribe(() => setBootstrapState(bootstrap().getSnapshot())))

  onMount(() => {
    startupMark('kernel_root_effect')
    void bootstrap().startNormal()
  })

  onMount(() => {
    if (typeof window === 'undefined') return
    if (!shouldExposeKernelAcceptanceControls(import.meta.env.DEV, window.localStorage)) return
    const rt = runtime()
    const controls = {
      unmountApplication: () => rt.unmount(),
      remountApplication: () => rt.mount(BUILTIN_PYLON_APPLICATION_ID),
      getSnapshot: () => rt.getSnapshot(),
      /**
       * P89/S0 只读诊断读数：子系统登记、调用时懒取。
       * 例：`__PYLON_KERNEL_DEV__.diagnostics.read('streamingDisplay')`
       */
      diagnostics: {
        keys: () => listRendererDiagnosticsKeys(),
        read: (key: string) => readRendererDiagnostics(key),
      },
    }
    window.__PYLON_KERNEL_DEV__ = controls
    onCleanup(() => {
      if (window.__PYLON_KERNEL_DEV__ === controls) delete window.__PYLON_KERNEL_DEV__
    })
  })

  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        // 原 React componentDidCatch：每个错误实例只记一次（fallback 可能随响应式更新重跑）
        if (reportedCrash !== error) {
          reportedCrash = error
          console.error('Prism Desktop crashed:', error)
        }
        return (
        <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'center',
          height: '100%', 'flex-direction': 'column', gap: '16px', color: 'var(--text-dim)', 'font-family': 'var(--font)' }}>
          <div style={{ 'font-size': '48px', 'font-weight': '200' }}>!</div>
          <div style={{ 'font-size': '16px', 'font-weight': '600', color: 'var(--text)' }}>Prism Desktop 遇到了一个错误</div>
          <div style={{ 'font-size': '13px', 'max-width': '400px', 'text-align': 'center', 'font-family': 'var(--mono)' }}>
            {error.message}
          </div>
          <button onClick={() => reset()}
            style={{ padding: '8px 20px', border: '1px solid var(--border)', 'border-radius': '6px',
              background: 'var(--bg-panel)', color: 'var(--text)', cursor: 'pointer' }}>
            重试
          </button>
        </div>
        )
      }}
    >
      <ApplicationMount
        runtime={runtime()}
        recovery={(
          <KernelRecoveryLayer
            state={bootstrapState()}
            onRetry={pluginId => { void bootstrap().retryPlugin(pluginId) }}
            onSafeMode={() => { void bootstrap().startSafeMode() }}
            onStartNormal={() => { void bootstrap().startNormal() }}
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
      diagnostics: {
        keys: () => readonly string[]
        read: (key: string) => ReturnType<typeof readRendererDiagnostics>
      }
    }
  }
}
