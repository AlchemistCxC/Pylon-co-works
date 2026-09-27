import SolidMount from '../host/SolidMount'

/**
 * SheetLauncher — Sheet 启动命令面板（#279 第 3 梯队 Solid 化）。
 *
 * 本文件是 App（React lazy）与 Solid 实体之间的**薄桥 + 加载缝**：实体在
 * `SheetLauncher.solid.tsx`——原 cmdk（React 生态）依赖已按可见行为契约手写收敛
 * （过滤/环选/Empty/cmdk 属性词汇），React 类型图不触碰 .solid 文件（P52 D4 同构）。
 * open/agents/sheets 经 SolidMount 响应式通道透传。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface SheetLauncherSolidModule {
  renderSheetLauncher(container: HTMLElement, latest: () => SheetLauncherProps): () => void
}

export interface SheetLauncherProps {
  open: boolean
  agents: { id: string; name: string }[]
  sheets: import('./sheetTypes').SheetRecord[]
  onOpenChange: (open: boolean) => void
  onFocusSheet: (id: string) => void
  onOpenSheet: (kind: string, title: string, agentId?: string) => void
  onOpenSettings: () => void
  onOpenProfiles: () => void
}

const modules = import.meta.glob<SheetLauncherSolidModule>('./SheetLauncher.solid.tsx', { eager: true })
const solidModule = modules['./SheetLauncher.solid.tsx']
if (!solidModule) throw new Error('SheetLauncher Solid 实体未进入 Vite module graph')

export default function SheetLauncher(props: SheetLauncherProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSheetLauncher(container, latest)} />
}
