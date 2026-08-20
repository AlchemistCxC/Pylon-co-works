import PrismSheet from '../components/PrismSheet'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

export default function PrismManagerSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  return <div className="sheet-tool-view"><PrismSheet sidebarCollapsed={ctx.sidebarCollapsed} /></div>
}
