import { useState } from 'react'
import { clearErrors, dismissError, useErrors } from '../errorCenter'

/**
 * 全局运行错误中心：reportRuntimeError 聚合的错误列表。
 * 有错误时右上角显示 badge，点击展开面板（逐条关闭 / 全部清除）。
 */
export default function ErrorCenter() {
  const errors = useErrors()
  const [open, setOpen] = useState(false)
  if (errors.length === 0) return null
  return (
    <>
      <button type="button" className="error-center-badge" onClick={() => setOpen(value => !value)}
        title={`${errors.length} 个运行错误`} aria-label="查看运行错误">⚠ {errors.length}</button>
      {open && (
        <div className="error-center" role="dialog" aria-label="运行错误">
          <div className="error-center-head">
            <span>运行错误（{errors.length}）</span>
            <button type="button" className="error-center-action" onClick={clearErrors}>全部清除</button>
            <button type="button" className="error-center-action" onClick={() => setOpen(false)}>✕</button>
          </div>
          <ul className="error-center-list">
            {errors.map(entry => (
              <li key={entry.id} className="error-center-item">
                <strong>{entry.action}失败</strong>
                <span className="error-center-msg">{entry.message}</span>
                <button type="button" className="error-center-action" aria-label="关闭该错误" onClick={() => dismissError(entry.id)}>✕</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
