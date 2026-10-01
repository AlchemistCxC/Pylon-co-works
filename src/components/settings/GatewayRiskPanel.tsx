import SolidMount from '../../host/SolidMount'

/**
 * GatewayRiskPanel — Settings「Agent 与连接 › Gateway」风险 consumer（ISSUE-13 W5）。
 *
 * #515：实体已迁 `GatewayRiskPanel.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface GatewayRiskPanelProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface GatewayRiskPanelSolidModule {
  renderGatewayRiskPanel(container: HTMLElement, latest: () => GatewayRiskPanelProps): () => void
}

const modules = import.meta.glob<GatewayRiskPanelSolidModule>('./GatewayRiskPanel.solid.tsx', { eager: true })
const solidModule = modules['./GatewayRiskPanel.solid.tsx']
if (!solidModule) throw new Error('GatewayRiskPanel Solid 实体未进入 Vite module graph')

export default function GatewayRiskPanel(_props: GatewayRiskPanelProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderGatewayRiskPanel(container, latest)} />
}
