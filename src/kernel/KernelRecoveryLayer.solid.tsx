/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import type { KernelBootstrapState } from './kernelBootstrap.ts'

interface KernelRecoveryLayerProps {
  onRemount?: () => void
  state?: KernelBootstrapState
  onRetry?: (pluginId: string) => void
  onSafeMode?: () => void
  onStartNormal?: () => void
}

/** #515：React → Solid 实体（KernelRoot.solid 直连）；DOM 结构与内联样式逐字节保持。 */
export default function KernelRecoveryLayer(props: KernelRecoveryLayerProps) {
  const starting = () => props.state?.kind === 'idle' || props.state?.kind === 'starting'
  const degraded = () => props.state?.kind === 'degraded' ? props.state : undefined
  const safeMode = () => props.state?.kind === 'safe-mode'
  return (
    <main
      data-testid="kernel-recovery-layer"
      style={{
        display: 'flex',
        'min-height': '100%',
        'align-items': 'center',
        'justify-content': 'center',
        background: 'transparent',
        color: 'var(--text)',
        'font-family': 'var(--font)',
      }}
    >
      <section style={{ display: 'grid', gap: '12px', 'justify-items': 'center', 'text-align': 'center' }}>
        <strong style={{ 'font-size': '16px' }}>
          {starting() ? 'Pylon Kernel 正在启动'
            : degraded() ? 'Pylon 插件启动不完整'
              : safeMode() ? 'Pylon 安全模式'
                : 'Pylon Application 已卸载'}
        </strong>
        <p style={{ color: 'var(--text-dim)', 'font-size': '13px' }}>
          {starting() ? '恢复界面已就绪，正在显式激活 Plugin Host。'
            : safeMode() ? 'Product Plugin 与用户插件均未自动启动。'
              : 'Workbench Kernel 仍在运行。'}
        </p>
        <For each={degraded()?.failures ?? []}>
          {failure => (
            <div role="alert">
              <span>{failure.pluginId} · {failure.stage} · {failure.message}</span>
              <Show when={failure.retryable && props.onRetry}>
                <button type="button" onClick={() => props.onRetry?.(failure.pluginId)}>重试 {failure.pluginId}</button>
              </Show>
            </div>
          )}
        </For>
        <Show when={degraded() && props.onSafeMode}>
          <button type="button" onClick={() => props.onSafeMode?.()}>进入安全模式</button>
        </Show>
        <Show when={safeMode() && props.onStartNormal}>
          <button type="button" onClick={() => props.onStartNormal?.()}>正常启动</button>
        </Show>
        <Show when={props.state?.kind === 'safe-mode' && props.onRetry}>
          <For each={props.state?.kind === 'safe-mode' ? props.state.skippedPluginIds : []}>
            {pluginId => (
              <button type="button" onClick={() => props.onRetry?.(pluginId)}>
                启动 {pluginId}
              </button>
            )}
          </For>
        </Show>
        <Show when={!props.state && props.onRemount}>
          <button
            type="button"
            onClick={() => props.onRemount?.()}
            style={{
              padding: '8px 20px',
              border: '1px solid var(--border)',
              'border-radius': '6px',
              background: 'var(--bg-panel)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            重新挂载 Pylon
          </button>
        </Show>
      </section>
    </main>
  )
}
