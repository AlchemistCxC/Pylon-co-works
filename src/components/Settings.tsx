import SolidMount from '../host/SolidMount'
import type { WorkspaceViewProps } from '../plugin-runtime/workspaces/workspaceTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'

// P52 D4：React 类型图不得触碰 .solid 文件（会把 Solid JSX 拉进 React tsconfig 程序），
// 实体经 eager glob 缝加载，挂载函数接口在本文件声明。
interface SettingsSolidModule {
  renderSettings(container: HTMLElement, latest: () => SettingsProps): () => void
}

const modules = import.meta.glob<SettingsSolidModule>('./Settings.solid.tsx', { eager: true })
const solidModule = modules['./Settings.solid.tsx']
if (!solidModule) throw new Error('Settings Solid 实体未进入 Vite module graph')

/** 与 Solid 实体（Settings.solid.tsx）内声明的 SettingsProps 逐字段一致。 */
export type SettingsProps = WorkspaceViewProps<SettingsSheetState>

/**
 * Settings — 设置 sheet 主组件（A-V3 拆分后只保留装配职责）。
 * #515：实体在 Settings.solid.tsx，本文件是 React 世界薄桥（批7 拆除）——
 * settings/* 已实体化的子组件由实体直连；仍为 React 面的子组件经岛挂载。
 */
export default function Settings(props: SettingsProps) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.renderSettings(container, latest)} />
}
