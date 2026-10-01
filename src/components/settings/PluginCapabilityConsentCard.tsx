import SolidMount from '../../host/SolidMount'
import type { KernelBootstrap } from '../../kernel/kernelBootstrap.ts'

/**
 * P53 D2 · 宿主授权卡：声明了 capability 但未获用户授权的插件在此批准/拒绝。
 *
 * #515：实体已迁 `PluginCapabilityConsentCard.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface PluginCapabilityConsentCardProps {
  /** 待授权声明清单：bootstrap capability-consent 失败投影。 */
  readonly pending: readonly {
    pluginId: string
    pluginVersion: string
    capabilities: readonly string[]
    message: string
  }[]
  readonly bootstrap?: Pick<KernelBootstrap, 'retryPlugin'>
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface PluginCapabilityConsentCardSolidModule {
  renderPluginCapabilityConsentCard(container: HTMLElement, latest: () => PluginCapabilityConsentCardProps): () => void
}

const modules = import.meta.glob<PluginCapabilityConsentCardSolidModule>('./PluginCapabilityConsentCard.solid.tsx', { eager: true })
const solidModule = modules['./PluginCapabilityConsentCard.solid.tsx']
if (!solidModule) throw new Error('PluginCapabilityConsentCard Solid 实体未进入 Vite module graph')

export default function PluginCapabilityConsentCard(props: PluginCapabilityConsentCardProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderPluginCapabilityConsentCard(container, latest)} />
}
