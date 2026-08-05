import { lazy, Suspense } from 'react'
import type { SheetKind, SheetRecord, SheetContext, SheetRenderEntry } from './sheetTypes.ts'
import AgentSheetView from '../sheets/AgentSheetView'
import OverviewSheetView from '../sheets/OverviewSheetView'
import Sidebar from '../components/Sidebar'

/**
 * sheetRegistry — 渲染注册表（W1-02，F1-B/F2-A）。
 *
 * 纯数据表 SHEET_REGISTRY（sheetRegistry.ts）仍为 kind/label/singleton 单一真值；
 * 本表持主区渲染器（agent 直挂，其余 lazy+Suspense）+ 侧栏/右栏声明（W1-03/04 消费）。
 * 方案 B 双表（纯数据表可被 node 测试实际 import 全表——验收要求），用
 * `satisfies Record<SheetKind, ...>` 类型守卫 + 完整性 test 防漂移。
 * renderKey 保留（调试用 + 持久化不存组件引用）。
 */

// Prism 管理 Sheet 非首屏：按需分包
const PrismManagerSheetView = lazy(() => import('../sheets/PrismManagerSheetView'))

const LOADING_FALLBACK = (
  <div className="sheet-empty-host">
    <div className="sheet-empty-kicker">LOADING</div>
    <p>加载模块…</p>
  </div>
)

function UnavailableSheet({ kind }: { kind: string }) {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">SHEET</div>
      <h2>{kind} 尚未接入</h2>
      <p>当前只建立了 Sheet 状态与导航壳，运行内容尚未接入。</p>
    </div>
  )
}

// agent 直挂（主工作台首屏）；W1-03：AgentSheetView 收窄为 { sheet, ctx }，只渲染主区
const agentRender = (sheet: SheetRecord, ctx: SheetContext) => <AgentSheetView sheet={sheet} ctx={ctx} />

export const SHEET_RENDER_REGISTRY: Record<SheetKind, SheetRenderEntry> = {
  // W1-03：侧栏上移——agent 的 Sidebar 由布局层经 slot 渲染（entry.sidebar 声明）
  agent: { render: agentRender, sidebar: Sidebar },
  prism: { render: () => <Suspense fallback={LOADING_FALLBACK}><PrismManagerSheetView /></Suspense> },
  runtime: { render: () => <UnavailableSheet kind="runtime" /> },
  file: { render: () => <UnavailableSheet kind="file" /> },
  // W1-05：overview 启动选择器（虚拟空态，不写入持久 sheet 数组）
  overview: { render: (sheet, ctx) => <OverviewSheetView sheet={sheet} ctx={ctx} /> },
  search: { render: () => <UnavailableSheet kind="search" /> },
  history: { render: () => <UnavailableSheet kind="history" /> },
  browser: { render: () => <UnavailableSheet kind="browser" /> },
  gateway: { render: () => <UnavailableSheet kind="gateway" /> },
} satisfies Record<SheetKind, SheetRenderEntry>

export function resolveSheetRender(kind: SheetKind): SheetRenderEntry | undefined {
  return SHEET_RENDER_REGISTRY[kind]
}
