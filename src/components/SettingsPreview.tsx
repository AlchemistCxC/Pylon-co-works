import SolidMount from '../host/SolidMount'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SettingsPreviewSolidModule {
  renderSettingsPreview(container: HTMLElement, latest: () => SettingsPreviewProps): () => void
}

const modules = import.meta.glob<SettingsPreviewSolidModule>('./SettingsPreview.solid.tsx', { eager: true })
const solidModule = modules['./SettingsPreview.solid.tsx']
if (!solidModule) throw new Error('SettingsPreview Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（SettingsPreview.solid.tsx）内声明的 SettingsPreviewProps 逐字段一致。 */
export interface SettingsPreviewProps { zone: string }

/**
 * SettingsPreview — 设置页实时预览画布（P52 D4 中控预览挂真实 SolidControlCenter）。
 * #515：实体在 SettingsPreview.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 */
export default function SettingsPreview(props: SettingsPreviewProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSettingsPreview(container, latest)} />
}
