import {
  Activity,
  Bot,
  Boxes,
  FolderTree,
  Globe,
  History,
  LayoutDashboard,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  SquareStack,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'

/**
 * 稳定图标键 → 图标的唯一映射。由 **Workspace launch 项**与**左栏区块头动作**共用。
 *
 * 键是宿主解释的字符串（不是 React 组件），因此可以出现在插件贡献里；未知键安全降级为
 * 通用图标。抽出来是因为原先这份表只服务于 SheetLauncher，左栏区块头再写一份就会漂移。
 */
export const LAUNCH_ICONS: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  agent: Bot,
  boxes: Boxes,
  'folder-tree': FolderTree,
  globe: Globe,
  history: History,
  'layout-dashboard': LayoutDashboard,
  plus: Plus,
  search: Search,
  settings: Settings,
  sliders: SlidersHorizontal,
  waypoints: Waypoints,
}

export function resolveLaunchIcon(icon?: string): LucideIcon {
  return (icon && LAUNCH_ICONS[icon]) || SquareStack
}
