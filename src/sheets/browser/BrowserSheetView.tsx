import { useReducer } from 'react'
import { browserReducer, createBrowserState } from '../../domains/browser/browserState.ts'
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

  const start = () => {
    dispatch({ type: 'start' })
    // W4-03 壳：不虚构 CDP 命令名；W4-04 接真实契约后在此 invoke
    window.setTimeout(() => dispatch({ type: 'failed', error: '待后端：CDP 命令契约尚未提供' }), 0)
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
