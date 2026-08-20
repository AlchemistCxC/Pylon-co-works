import type { KernelBootstrapState } from './kernelBootstrap.ts'

interface KernelRecoveryLayerProps {
  onRemount?: () => void
  state?: KernelBootstrapState
  onRetry?: (pluginId: string) => void
  onSafeMode?: () => void
  onStartNormal?: () => void
}

export default function KernelRecoveryLayer({
  onRemount,
  state,
  onRetry,
  onSafeMode,
  onStartNormal,
}: KernelRecoveryLayerProps) {
  const starting = state?.kind === 'idle' || state?.kind === 'starting'
  const degraded = state?.kind === 'degraded' ? state : undefined
  const safeMode = state?.kind === 'safe-mode'
  return (
    <main
      data-testid="kernel-recovery-layer"
      style={{
        display: 'flex',
        minHeight: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        color: 'var(--text)',
        fontFamily: 'var(--font)',
      }}
    >
      <section style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
        <strong style={{ fontSize: 16 }}>
          {starting ? 'Pylon Kernel 正在启动'
            : degraded ? 'Pylon 插件启动不完整'
              : safeMode ? 'Pylon 安全模式'
                : 'Pylon Application 已卸载'}
        </strong>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {starting ? '恢复界面已就绪，正在显式激活 Plugin Host。'
            : safeMode ? 'Product Plugin 与用户插件均未自动启动。'
              : 'Workbench Kernel 仍在运行。'}
        </p>
        {degraded?.failures.map(failure => (
          <div key={`${failure.pluginId}:${failure.stage}`} role="alert">
            <span>{failure.pluginId} · {failure.stage} · {failure.message}</span>
            {failure.retryable && onRetry && (
              <button type="button" onClick={() => onRetry(failure.pluginId)}>重试 {failure.pluginId}</button>
            )}
          </div>
        ))}
        {degraded && onSafeMode && (
          <button type="button" onClick={onSafeMode}>进入安全模式</button>
        )}
        {safeMode && onStartNormal && (
          <button type="button" onClick={onStartNormal}>正常启动</button>
        )}
        {state?.kind === 'safe-mode' && onRetry && state.skippedPluginIds.map(pluginId => (
          <button type="button" key={pluginId} onClick={() => onRetry(pluginId)}>
            启动 {pluginId}
          </button>
        ))}
        {!state && onRemount && (
          <button
            type="button"
            onClick={onRemount}
            style={{
              padding: '8px 20px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--bg-panel)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            重新挂载 Pylon
          </button>
        )}
      </section>
    </main>
  )
}
