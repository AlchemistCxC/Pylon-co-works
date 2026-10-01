import SolidMount from '../../host/SolidMount'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'

/** 与 Solid 实体（AgentRendererSuiteWorkbench.solid.tsx）内声明逐字段一致。 */
export interface WorkbenchFatalFailure {
  readonly suiteId: string
  readonly pluginId?: string
  readonly phase: string
  readonly message: string
  readonly retained?: boolean
}

/** 与 Solid 实体（AgentRendererSuiteWorkbench.solid.tsx）内声明的同名接口逐字段一致。 */
export interface AgentRendererSuiteWorkbenchProps {
  sheet: SheetRecord
  ctx: SheetContext
  modeId: string
  defaultSuiteId: string
  isReplay: boolean
}

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface AgentRendererSuiteWorkbenchSolidModule {
  mountAgentRendererSuiteWorkbench: (container: HTMLElement, latest: () => AgentRendererSuiteWorkbenchProps) => () => void
}

const modules = import.meta.glob<AgentRendererSuiteWorkbenchSolidModule>('./AgentRendererSuiteWorkbench.solid.tsx', { eager: true })
const solidModule = modules['./AgentRendererSuiteWorkbench.solid.tsx']
if (!solidModule) throw new Error('AgentRendererSuiteWorkbench Solid 实体未进入 Vite module graph')

/**
 * AgentRendererSuiteWorkbench — Renderer Suite 工作台宿主。
 * #515：实体在 AgentRendererSuiteWorkbench.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function AgentRendererSuiteWorkbench(props: AgentRendererSuiteWorkbenchProps) {
  return <SolidMount initial={props} mount={solidModule.mountAgentRendererSuiteWorkbench} />
}
