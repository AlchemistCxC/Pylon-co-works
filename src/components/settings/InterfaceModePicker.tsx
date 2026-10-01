import SolidMount from '../../host/SolidMount'

/**
 * InterfaceModePicker — 界面模式选择卡（radiogroup）。
 *
 * #515：实体已迁 `InterfaceModePicker.solid.tsx`，本文件是 React 世界薄桥（批7 拆除）。
 */

export interface InterfaceModePickerProps {}

/** Solid 实体的模块接口（React 类型图内的唯一事实，与实体侧逐字段一致）。 */
interface InterfaceModePickerSolidModule {
  renderInterfaceModePicker(container: HTMLElement, latest: () => InterfaceModePickerProps): () => void
}

const modules = import.meta.glob<InterfaceModePickerSolidModule>('./InterfaceModePicker.solid.tsx', { eager: true })
const solidModule = modules['./InterfaceModePicker.solid.tsx']
if (!solidModule) throw new Error('InterfaceModePicker Solid 实体未进入 Vite module graph')

export default function InterfaceModePicker(_props: InterfaceModePickerProps) {
  return <SolidMount initial={{}} mount={(container, latest) => solidModule.renderInterfaceModePicker(container, latest)} />
}
