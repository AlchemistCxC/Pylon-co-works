import SolidMount from '../../host/SolidMount'

/**
 * RendererSuitePicker — Suite 级选择 UI；message renderer id 不在此暴露。
 *
 * #515：实体已迁 `RendererSuitePicker.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface RendererSuitePickerProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface RendererSuitePickerSolidModule {
  renderRendererSuitePicker(container: HTMLElement, latest: () => RendererSuitePickerProps): () => void
}

const modules = import.meta.glob<RendererSuitePickerSolidModule>('./RendererSuitePicker.solid.tsx', { eager: true })
const solidModule = modules['./RendererSuitePicker.solid.tsx']
if (!solidModule) throw new Error('RendererSuitePicker Solid 实体未进入 Vite module graph')

export default function RendererSuitePicker(_props: RendererSuitePickerProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderRendererSuitePicker(container, latest)} />
}
