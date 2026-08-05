import { useStore } from '../../store'
import { useRuntimeStore } from '../../runtimeStore'
import { invoke } from '@tauri-apps/api/core'
import { applyApprovalModeChange, nextApprovalMode } from '../../domains/permission/approvalMode.ts'

/**
 * Approval mode widget（P0-04）：
 *   - 循环值限定 bypass/auto/edit/default，invoke set_approval_mode（全局，无 source）
 *   - approval mode 存 runtimeStore 不持久化；失败回滚显示值并走现有 pylon:mode-error 错误中心
 *   - session mode（plan/code）由 slash command/sessionMode 链消费 set_mode，不混用
 *
 * modeVariant 取值：
 *   - 'pill'    : 圆角胶囊背景，点击循环切模式（默认）
 *   - 'badge'   : 方括号包裹 [mode]
 *   - 'minimal' : 纯文本，仅颜色区分
 */
export default function ModeWidget() {
  const variant = useStore(s => s.modeVariant) || 'pill'
  const ccScale = useStore(s => (s.ccScale || {})['mode'] ?? 100)
  const mode = useRuntimeStore(s => s.approvalMode)
  const setApprovalMode = useRuntimeStore(s => s.setApprovalMode)

  const cycle = () => {
    const next = nextApprovalMode(mode)
    const previousMode = mode
    applyApprovalModeChange({
      nextMode: next,
      previousMode,
      writeMode: setApprovalMode,
      invokeSet: targetMode => invoke('set_approval_mode', { mode: targetMode }),
    }).catch(error => {
      window.dispatchEvent(new CustomEvent('pylon:mode-error', { detail: String(error) }))
    })
  }

  if (variant === 'badge') {
    return (
      <button className="cc-mode-badge" type="button" data-mode={mode} onClick={e => { e.stopPropagation(); cycle() }} title="点击切换"
        style={{ fontSize: `${ccScale}%` }}>
        [{mode}]
      </button>
    )
  }

  if (variant === 'minimal') {
    return (
      <button className="cc-mode-minimal" type="button" data-mode={mode} onClick={e => { e.stopPropagation(); cycle() }} style={{ fontSize: `${ccScale}%` }}>
        {mode}
      </button>
    )
  }

  // default: 'pill'
  return (
    <button className="cc-mode-widget" type="button" onClick={e => { e.stopPropagation(); cycle() }} title="点击切换" style={{ fontSize: `${ccScale}%` }}>
      <span className="mode-pill" data-mode={mode}>{mode}</span>
    </button>
  )
}
