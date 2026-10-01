import SolidMount from '../../host/SolidMount'
import type { RenderCtx } from './themeFieldRenderer.tsx'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface GlobalPresetSectionSolidModule {
  renderGlobalPresetSection(container: HTMLElement, latest: () => GlobalPresetSectionProps): () => void
}

const modules = import.meta.glob<GlobalPresetSectionSolidModule>('./GlobalPresetSection.solid.tsx', { eager: true })
const solidModule = modules['./GlobalPresetSection.solid.tsx']
if (!solidModule) throw new Error('GlobalPresetSection Solid 实体未进入 Vite module graph')

/**
 * 与 Solid 实体（GlobalPresetSection.solid.tsx）内声明的 GlobalPresetSectionProps 逐字段一致。
 *
 * #515 同批契约变更（第一批 deferred 项收口）：原 `{ isSearching, children }` 由
 * Settings.tsx 注入 React 子树（ZoneGroupFields）；Settings 同批 Solid 化后改 solid 直连，
 * children 由 `ctx` + `density` 的实体直连渲染取代。唯一消费者 Settings 已同步切换。
 */
export interface GlobalPresetSectionProps {
  isSearching: boolean
  ctx: RenderCtx
  density?: 'basic' | 'standard' | 'all'
}

/**
 * GlobalPresetSection — 设置页 global 分区的预设事务与呈现（A-V3 拆分自 Settings.tsx）。
 * #515：实体在 GlobalPresetSection.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function GlobalPresetSection(props: GlobalPresetSectionProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderGlobalPresetSection(container, latest)} />
}
