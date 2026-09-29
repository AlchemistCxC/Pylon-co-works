/**
 * launchIconKeys — 稳定图标键表单源（结构审查 A-V7）。
 *
 * 键是宿主解释的字符串（不是组件），会出现在插件贡献里。React（lucide-react 组件）
 * 与 Solid（LucideIcon.solid 字符串名）各自建映射时**必须**以本键表为键类型——
 * 键集在编译期穷举校验，两侧漂移直接编译红，替代原「逐键一致」注释纪律。
 */
export const LAUNCH_ICON_KEYS = [
  'activity',
  'book-open',
  'agent',
  'boxes',
  'clock',
  'folder-tree',
  'globe',
  'history',
  'layout-dashboard',
  'messages',
  'plus',
  'search',
  'settings',
  'sliders',
  'waypoints',
] as const

export type LaunchIconKey = (typeof LAUNCH_ICON_KEYS)[number]
