import type { ToolVisualState } from './toolStatus.ts'

export interface ToolIndicatorAsset {
  id: string
  label: string
  glyph: string
  runningClass: string
  okClass: string
  errorClass: string
  ariaLabel: Record<ToolVisualState, string>
}

const ariaLabel = (label: string): Record<ToolVisualState, string> => ({
  queued: `${label}，排队中`,
  running: `${label}，运行中`,
  waiting: `${label}，等待中`,
  completed: `${label}，已完成`,
  failed: `${label}，失败`,
  cancelled: `${label}，已取消`,
  unknown: `${label}，状态未知`,
})

const createAsset = (id: string, label: string, glyph: string): ToolIndicatorAsset => ({
  id,
  label,
  glyph,
  runningClass: 'run',
  okClass: 'ok',
  errorClass: 'err',
  ariaLabel: ariaLabel(label),
})

export const TOOL_INDICATOR_ASSETS = Object.freeze([
  createAsset('circle', '圆点', '●'),
  createAsset('diamond', '菱形', '◆'),
  createAsset('square', '方块', '■'),
  createAsset('triangle', '三角', '▲'),
  createAsset('play', '播放', '▶'),
  createAsset('ring', '圆环', '○'),
  createAsset('double-ring', '双环', '◎'),
  createAsset('chevron', '尖括号', '›'),
  createAsset('branch', '分支', '├'),
  createAsset('node', '节点', '◇'),
  createAsset('hex', '六边形', '⬡'),
] as const)

export type ToolIndicatorId = typeof TOOL_INDICATOR_ASSETS[number]['id']

const DEFAULT_ASSET = TOOL_INDICATOR_ASSETS[0]

/**
 * 新主题保存 preset id；旧主题保存 glyph。两种持久化值均可解析，未知值回退为原始 glyph。
 */
export function resolveToolIndicatorAsset(value?: string): ToolIndicatorAsset {
  if (!value) return DEFAULT_ASSET
  return TOOL_INDICATOR_ASSETS.find(asset => asset.id === value || asset.glyph === value)
    || { ...DEFAULT_ASSET, glyph: value, label: '自定义指示器', ariaLabel: ariaLabel('自定义指示器') }
}

export function toolIndicatorOptions(): { value: string; label: string }[] {
  return TOOL_INDICATOR_ASSETS.map(asset => ({ value: asset.id, label: `${asset.glyph} ${asset.label}` }))
}
