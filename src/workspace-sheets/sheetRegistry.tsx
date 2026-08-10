import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import type { SheetKind, SheetRecord, SheetContext, SheetRenderEntry } from './sheetTypes.ts'
import AgentSheetView from '../sheets/AgentSheetView'
import OverviewSheetView from '../sheets/OverviewSheetView'
import Sidebar from '../components/Sidebar'
import AgentContextPanel from '../components/right-panel/AgentContextPanel'
import FileContextPanel from '../components/right-panel/FileContextPanel'

/**
 * sheetRegistry — 渲染注册表（W1-02，F1-B/F2-A）。
 *
 * 纯数据表 SHEET_REGISTRY（sheetRegistry.ts）仍为 kind/label/singleton 单一真值；
 * 本表持主区渲染器（agent 直挂，其余 lazy+Suspense）+ 侧栏/右栏声明（W1-03/04 消费）。
 * 方案 B 双表（纯数据表可被 node 测试实际 import 全表——验收要求），用
 * `satisfies Record<SheetKind, ...>` 类型守卫 + 完整性 test 防漂移。
 * renderKey 保留（调试用 + 持久化不存组件引用）。
 */

// FE-AUD-016：除 agent/overview 外，全部 Sheet renderer lazy（首屏只载 Agent 工作台）
const PrismManagerSheetView = lazy(() => import('../sheets/PrismManagerSheetView'))
const RuntimeSheetView = lazy(() => import('../sheets/RuntimeSheetView'))
const GatewaySheetView = lazy(() => import('../sheets/gateway/GatewaySheetView'))
const SearchSheetView = lazy(() => import('../sheets/search/SearchSheetView'))
const HistorySheetView = lazy(() => import('../sheets/history/HistorySheetView'))
const BrowserSheetView = lazy(() => import('../sheets/browser/BrowserSheetView'))
const FileSheetView = lazy(() => import('../sheets/file/FileSheetView'))

const LOADING_FALLBACK = (
  <div className="sheet-empty-host">
    <div className="sheet-empty-kicker">LOADING</div>
    <p>加载模块…</p>
  </div>
)

// agent 直挂（主工作台首屏）；W1-03：AgentSheetView 收窄为 { sheet, ctx }，只渲染主区
const agentRender = (sheet: SheetRecord, ctx: SheetContext) => <AgentSheetView sheet={sheet} ctx={ctx} />

/** lazy sheet 渲染包装：Suspense + 加载态 */
function lazyRender(Component: LazyExoticComponent<ComponentType<{ sheet: SheetRecord; ctx: SheetContext }>>) {
  return (sheet: SheetRecord, ctx: SheetContext) => (
    <Suspense fallback={LOADING_FALLBACK}>
      <Component sheet={sheet} ctx={ctx} />
    </Suspense>
  )
}

export const SHEET_RENDER_REGISTRY: Record<SheetKind, SheetRenderEntry> = {
  // W1-03：侧栏上移——agent 的 Sidebar 由布局层经 slot 渲染（entry.sidebar 声明）
  // W2-12：agent/file 右栏（F2-F）——搜索/关联；旧 RightPanel 退役
  // I09-A-FE-01：sidebarMode 显式声明（agent=workspace 公共左栏；file/browser=sheet 内栏；其余 none）
  agent: { render: agentRender, sidebarMode: 'workspace', sidebar: Sidebar, rightPanel: AgentContextPanel },
  prism: { render: lazyRender(PrismManagerSheetView), sidebarMode: 'none' },
  // W1-08：runtime 日志观察面（list 回放 + runtime-log 增量，无右栏）
  runtime: { render: lazyRender(RuntimeSheetView), sidebarMode: 'none' },
  // W2-03：FileSheet 分区壳（singletonKey file:{source}，内部指向可改）
  file: { render: lazyRender(FileSheetView), sidebarMode: 'sheet', rightPanel: FileContextPanel },
  // W1-05：overview 启动选择器（虚拟空态，不写入持久 sheet 数组）
  overview: { render: (sheet, ctx) => <OverviewSheetView sheet={sheet} ctx={ctx} />, sidebarMode: 'none' },
  // W3-03：跨会话快照搜索（仅本地会话；平台范围产品未决）
  search: { render: lazyRender(SearchSheetView), sidebarMode: 'none' },
  // W4-01：历史列表/导出（回放 W4-02 待产品拍板）
  history: { render: lazyRender(HistorySheetView), sidebarMode: 'none' },
  // W4-03：browser 壳（CDP 契约未定，W4-04 接真实）
  browser: { render: lazyRender(BrowserSheetView), sidebarMode: 'sheet' },
  // W3-01：gateway 只读概览（适配器/平台会话分区；写回 W3-02 桩化）
  gateway: { render: lazyRender(GatewaySheetView), sidebarMode: 'none' },
} satisfies Record<SheetKind, SheetRenderEntry>

export function resolveSheetRender(kind: SheetKind): SheetRenderEntry | undefined {
  return SHEET_RENDER_REGISTRY[kind]
}
