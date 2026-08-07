import type { SheetInput, SheetRegistryEntry, SheetKind } from './sheetTypes.ts'

const singleton = (key: string) => (_input: Pick<SheetInput, 'agentId' | 'singletonKey' | 'metadata'>) => key
const agentSingleton = (input: Pick<SheetInput, 'agentId' | 'singletonKey' | 'metadata'>) => input.agentId ? `agent:${input.agentId}` : undefined

// W1-01（F1-A）：9 kind 注册表（diff/changes/git-history 删除；overview/search/history/browser/gateway 新增）
export const SHEET_REGISTRY: Record<SheetKind, SheetRegistryEntry> = {
  agent: { kind: 'agent', label: 'Agent', renderKey: 'agent-sheet', singleton: true, getSingletonKey: agentSingleton },
  prism: { kind: 'prism', label: 'Prism', renderKey: 'prism-manager-sheet', singleton: true, getSingletonKey: singleton('prism') },
  runtime: { kind: 'runtime', label: 'Runtime', renderKey: 'runtime-sheet', singleton: true, getSingletonKey: singleton('runtime') },
  file: { kind: 'file', label: 'File', renderKey: 'file-sheet', singleton: false, getSingletonKey: input => input.singletonKey },
  overview: { kind: 'overview', label: 'Overview', renderKey: 'overview-sheet', singleton: true, getSingletonKey: singleton('overview') },
  search: { kind: 'search', label: 'Search', renderKey: 'search-sheet', singleton: true, getSingletonKey: singleton('search') },
  history: { kind: 'history', label: 'History', renderKey: 'history-sheet', singleton: true, getSingletonKey: singleton('history') },
  browser: { kind: 'browser', label: 'Browser', renderKey: 'browser-sheet', singleton: true, getSingletonKey: singleton('browser') },
  gateway: { kind: 'gateway', label: 'Gateway', renderKey: 'gateway-sheet', singleton: true, getSingletonKey: singleton('gateway') },
}

export function getSheetRegistryEntry(kind: unknown): SheetRegistryEntry | undefined {
  return typeof kind === 'string' && kind in SHEET_REGISTRY
    ? SHEET_REGISTRY[kind as SheetKind]
    : undefined
}

// ── FE-AUD-007：Launcher 工具项纯数据源（单一真值——新增 Sheet 只改此处与 render registry）──

export interface SheetLaunchOption {
  kind: SheetKind
  title: string
  description: string
  /** 后端能力未确认的入口：false → Launcher disabled 并标注（不保留假完成态） */
  launchable: boolean
}

export const SHEET_LAUNCH_OPTIONS: SheetLaunchOption[] = [
  { kind: 'file', title: 'File', description: '工作区文件 / SCM / 搜索', launchable: true },
  { kind: 'gateway', title: 'Gateway', description: '网关适配器与路由概览', launchable: true },
  { kind: 'history', title: 'History', description: '存档会话列表与导出', launchable: true },
  { kind: 'search', title: 'Search', description: '跨会话快照搜索', launchable: true },
  { kind: 'runtime', title: 'Runtime', description: '运行日志与启动诊断', launchable: true },
  { kind: 'browser', title: 'Browser', description: '浏览器会话', launchable: true },
  { kind: 'prism', title: 'Prism', description: 'Prism 管理', launchable: true },
]

export function getSheetLaunchOption(kind: SheetKind): SheetLaunchOption | undefined {
  return SHEET_LAUNCH_OPTIONS.find(option => option.kind === kind)
}

export function resolveSheetSingletonKey(input: Pick<SheetInput, 'kind' | 'agentId' | 'singletonKey' | 'metadata'>): string | undefined {
  return getSheetRegistryEntry(input.kind)?.getSingletonKey(input)
}
