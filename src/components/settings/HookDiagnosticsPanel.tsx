import SolidMount from '../../host/SolidMount'

/**
 * HookDiagnosticsPanel — 插件 hook 运行诊断（设置 › 插件 › Hook 诊断）。
 *
 * #515：实体已迁 `HookDiagnosticsPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface HookDiagnosticsPanelProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface HookDiagnosticsPanelSolidModule {
  renderHookDiagnosticsPanel(container: HTMLElement, latest: () => HookDiagnosticsPanelProps): () => void
}

const modules = import.meta.glob<HookDiagnosticsPanelSolidModule>('./HookDiagnosticsPanel.solid.tsx', { eager: true })
const solidModule = modules['./HookDiagnosticsPanel.solid.tsx']
if (!solidModule) throw new Error('HookDiagnosticsPanel Solid 实体未进入 Vite module graph')

export default function HookDiagnosticsPanel(_props: HookDiagnosticsPanelProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderHookDiagnosticsPanel(container, latest)} />
}
