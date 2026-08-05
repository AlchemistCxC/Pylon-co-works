import { resolveSheetRender } from './sheetRegistry.tsx'
import type { SheetContext, SheetRecord } from './sheetTypes'

/**
 * SheetHost — registry 驱动主区渲染（W1-02/03）。
 *
 * W1-03：activeSheet 解析与 ctx 构建上移 SheetLayout，本组件只做查表调用——
 * 按 sheet.kind 查 SHEET_RENDER_REGISTRY 调用 entry.render(sheet, ctx)。
 */

export default function SheetHost({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const entry = resolveSheetRender(sheet.kind)
  if (!entry) return <UnavailableSheet kind={sheet.kind} />
  return entry.render(sheet, ctx)
}

function UnavailableSheet({ kind }: { kind: string }) {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">SHEET</div>
      <h2>{kind} 尚未接入</h2>
      <p>当前只建立了 Sheet 状态与导航壳，运行内容尚未接入。</p>
    </div>
  )
}
