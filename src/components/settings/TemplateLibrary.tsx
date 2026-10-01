import SolidMount from '../../host/SolidMount'
import type { PresetApplyResult } from '../../domains/theme/presetBundle.ts'

/**
 * TemplateLibrary — 官方/自定义模板库（W2-14，F3-C/T2）。
 *
 * #515：实体已迁 `TemplateLibrary.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 * 预览本体经实体的 glob 缝挂 SettingsPreview React 岛（TemplateLibraryPreviewIsland）。
 */

export interface TemplateLibraryProps {
  onApply: (presetName: string) => void | Promise<void>
  onRestore: (presetName: string) => void | Promise<void>
  onCustomApply?: (presetId: string) => Promise<PresetApplyResult>
}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface TemplateLibrarySolidModule {
  renderTemplateLibrary(container: HTMLElement, latest: () => TemplateLibraryProps): () => void
}

const modules = import.meta.glob<TemplateLibrarySolidModule>('./TemplateLibrary.solid.tsx', { eager: true })
const solidModule = modules['./TemplateLibrary.solid.tsx']
if (!solidModule) throw new Error('TemplateLibrary Solid 实体未进入 Vite module graph')

export default function TemplateLibrary(props: TemplateLibraryProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderTemplateLibrary(container, latest)} />
}
