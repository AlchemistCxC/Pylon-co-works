import { useRuntimeStore } from '../runtimeStore'
import { getPermissionController } from '../infrastructure/acp/permissionController'
import { resolvePermissionButtons } from '../domains/permission/permissionButtons.ts'
import './PermissionDialog.css'

/**
 * PermissionDialog — 动态权限弹窗（P0-03）。
 *
 * App 单例挂载，读 runtimeStore.permission.active：无 active 返回 null。
 * options[] 按 wire 顺序动态生成按钮，optionId 原样回传 controller.choose
 * （D15——不硬编码 Peri/Hermes 按钮集）；answering 禁用全部按钮防双击。
 * P1 结构化 diff 未落地前仅展示 prompt，不阻塞审批（后续增强）。
 */
export default function PermissionDialog() {
  const active = useRuntimeStore(s => s.permission.active)
  if (!active) return null

  const { request, status } = active
  const answering = status === 'answering'
  const buttons = resolvePermissionButtons(request)
  const onChoose = (optionId: string) => {
    if (answering) return
    void getPermissionController()?.choose(request.requestId, optionId)
  }

  return (
    <div className="permission-dialog-overlay" role="dialog" aria-modal="true" aria-label="工具权限请求">
      <div className="permission-dialog">
        <div className="permission-dialog-title">{request.title || '工具权限请求'}</div>
        {request.toolCallId && <div className="permission-dialog-meta">toolCallId: {request.toolCallId}</div>}
        {request.prompt && <div className="permission-dialog-prompt">{request.prompt}</div>}
        <div className="permission-dialog-options">
          {buttons.map(button => (
            <button
              key={button.optionId}
              type="button"
              className="permission-dialog-btn"
              disabled={answering}
              onClick={() => onChoose(button.optionId)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
