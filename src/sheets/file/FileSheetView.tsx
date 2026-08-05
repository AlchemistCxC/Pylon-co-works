import { useReducer } from 'react'
import { createFileSheetState, fileSheetReducer, type FileSheetSection } from './fileSheetState.ts'
import FileSheetSidebar from './FileSheetSidebar'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './FileSheet.css'

/**
 * FileSheetView — FileSheet 主视图（W2-03）。
 *
 * singletonKey = file:{初始 source}（同工作区复用）；内部 targetSource 本地态（改指向
 * 不串 source；metadata 组合 action 由 W2-04 承接）。
 * 当前只建分区壳与 source 指向，文件树/搜索/SCM 分区由 W2-04/05/06 接线。
 */
export default function FileSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const initialSource = sheet.singletonKey?.replace(/^file:/, '') ?? ctx.sessionSource(ctx.activeSession)
  const [state, dispatch] = useReducer(fileSheetReducer, initialSource ?? null, createFileSheetState)

  const selectSection = (section: FileSheetSection) => dispatch({ type: 'set-section', section })

  const selectSource = (source: string) => {
    dispatch({ type: 'set-source', source })
  }

  return (
    <div className="file-sheet">
      <FileSheetSidebar
        activeSection={state.activeSection}
        targetSource={state.targetSource}
        onSelectSection={selectSection}
        onSelectSource={selectSource}
      />
      <main className="file-main">
        <div className="file-main-kicker">FILE SHEET</div>
        <h2 className="file-main-title">{state.targetSource || '未指向会话'}</h2>
        <p className="file-main-hint">当前分区：{state.activeSection}（W2-04 起接线文件树与编辑视图）</p>
      </main>
    </div>
  )
}
