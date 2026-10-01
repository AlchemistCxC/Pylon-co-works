import SolidMount from '../host/SolidMount'
import type { WorkspaceViewProps } from '../plugin-runtime/workspaces/workspaceTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'

/**
 * Settings Sheet 左栏导航（#154 阶段 4：一二级同栏分层）。
 *
 * 上半：4 个一级域（大字号 + 字形）——旧覆盖层里域切换只存在于标题栏菜单，
 * 现在域与分区同栏；下半：当前域分区（小字号缩进，沿用分区/子组/置顶/插件页交互）；
 * 页脚：重置主题两段式确认（#116 子项 9 语义原样迁入）。
 * 几何（宽度/分割线/折叠）归布局层的 `.sidebar`，本组件只提供内容。
 *
 * #515：实体在 SettingsSheetSidebar.solid.tsx，本文件是 React 世界薄桥（批7 拆除）。
 * state 可变 props 经 SolidMount 响应式通道透传（patchSheetState 后主区与本栏同帧联动）。
 */

/** Solid 实体的模块接口（React 类型图内的唯一事实）。 */
interface SettingsSheetSidebarSolidModule {
  mountSettingsSheetSidebar(container: HTMLElement, latest: () => WorkspaceViewProps<SettingsSheetState>): () => void
}

const modules = import.meta.glob<SettingsSheetSidebarSolidModule>('./SettingsSheetSidebar.solid.tsx', { eager: true })
const solidModule = modules['./SettingsSheetSidebar.solid.tsx']
if (!solidModule) throw new Error('SettingsSheetSidebar Solid 实体未进入 Vite module graph')

export default function SettingsSheetSidebar(props: WorkspaceViewProps<SettingsSheetState>) {
  return <SolidMount initial={props} mount={(container, latest) => solidModule.mountSettingsSheetSidebar(container, latest)} />
}
