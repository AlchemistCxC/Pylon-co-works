import { useReducer } from 'react'
import { browserReducer, createBrowserState } from '../../domains/browser/browserState.ts'
import { invoke } from '@tauri-apps/api/core'
import { classifyBrowserStartError } from '../../infrastructure/tauri/browserContracts.ts'
import { reportRuntimeError } from '../../runtimeError'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './BrowserSheet.css'

/**
 * BrowserSheetView — browser 壳（W4-03）。
 *
 * 纯状态机 idle/starting/ready/error + 导航接口占位；CDP 命令契约未定——不虚构
 * 命令名（W4-04 接真实契约）。单实例语义：重复 start 状态机 no-op（守卫断言）。
 */
export default function BrowserSheetView({ sheet: _sheet, ctx: _ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [state, dispatch] = useReducer(browserReducer, undefined, createBrowserState)

  const start = async () => {
    dispatch({ type: 'start' })
    // W4-04 桩化：CDP 命令契约未定——invoke 调用点就位（命令名以后端契约为准），
    // 命令不可用 → classifyBrowserStartError blocked 明确「待后端」
    try {
      await invoke('browser_start', { lazy: true })
      dispatch({ type: 'started' })
    } catch (error) {
      const classified = classifyBrowserStartError(error)
      dispatch({ type: 'failed', error: classified.kind === 'blocked' ? '待后端：CDP 命令契约尚未提供' : classified.message })
      if (classified.kind === 'error') reportRuntimeError('启动浏览器', error)
    }
  }

  return (
    <div className="browser-sheet">
      <div className="file-main-kicker">BROWSER</div>
      <h2 className="file-main-title">Browser</h2>
      <p className="file-section-hint" role="status">待后端：CDP 命令契约尚未提供（W4-03 壳）</p>
      <div className="browser-phase" data-phase={state.phase}>{state.phase}</div>
      <div className="browser-actions">
        <button type="button" className="template-apply" onClick={start}>启动</button>
        <button type="button" className="template-apply" disabled={state.phase !== 'ready'} onClick={() => dispatch({ type: 'stop' })}>关闭</button>
      </div>
      {state.error && <div className="file-tree-error" role="alert">{state.error}</div>}
    </div>
  )
}
