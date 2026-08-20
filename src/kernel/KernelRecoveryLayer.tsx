interface KernelRecoveryLayerProps {
  onRemount: () => void
}

export default function KernelRecoveryLayer({ onRemount }: KernelRecoveryLayerProps) {
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
        <strong style={{ fontSize: 16 }}>Pylon Application 已卸载</strong>
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>Workbench Kernel 仍在运行。</p>
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
      </section>
    </main>
  )
}
