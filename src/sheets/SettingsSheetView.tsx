/**
 * Settings Sheet 主区视图（#154 阶段 4）。
 *
 * 实现在 `components/Settings.tsx`（迁入 sheet 体系后该组件的 props 即
 * `WorkspaceViewProps<SettingsSheetState>`）；本模块只提供 sheet 注册表的
 * 惰性入口，与 `AgentSheetView` 等兄弟 Sheet 的命名保持一致。
 * 一二级导航在注册表 `sidebar`（`SettingsSheetSidebar.tsx`），不在主区。
 */
export { default } from '../components/Settings.tsx'
