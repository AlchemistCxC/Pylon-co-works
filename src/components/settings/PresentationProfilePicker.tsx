import SolidMount from '../../host/SolidMount'

/**
 * PresentationProfilePicker — 呈现风格选择卡。
 *
 * #515：实体已迁 `PresentationProfilePicker.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface PresentationProfilePickerProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface PresentationProfilePickerSolidModule {
  renderPresentationProfilePicker(container: HTMLElement, latest: () => PresentationProfilePickerProps): () => void
}

const modules = import.meta.glob<PresentationProfilePickerSolidModule>('./PresentationProfilePicker.solid.tsx', { eager: true })
const solidModule = modules['./PresentationProfilePicker.solid.tsx']
if (!solidModule) throw new Error('PresentationProfilePicker Solid 实体未进入 Vite module graph')

export default function PresentationProfilePicker(_props: PresentationProfilePickerProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderPresentationProfilePicker(container, latest)} />
}
