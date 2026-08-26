import { TOOL_STATE_LABELS, type ToolVisualState } from '../../domains/tool/status.ts'

export interface ToolIndicatorAsset {
  id: string
  label: string
  glyph: string
  runningClass: string
  okClass: string
  errorClass: string
  ariaLabel: Record<ToolVisualState, string>
}

const TOOL_STATES: readonly ToolVisualState[] = ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown']

// B2：aria 后缀派生自单一状态标签表（TOOL_STATE_LABELS），不再平行维护
const ariaLabel = (label: string): Record<ToolVisualState, string> =>
  Object.fromEntries(TOOL_STATES.map(state => [state, `${label}，${TOOL_STATE_LABELS[state]}`])) as Record<ToolVisualState, string>

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
  createAsset('dot-small', '小圆点', '·'),
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
  createAsset('asterisk', '星号', '✱'),
  createAsset('star', '星标', '★'),
  createAsset('check', '完成勾', '✓'),
  createAsset('cross', '失败叉', '×'),
  createAsset('warning', '警告', '!'),
  createAsset('plus', '加号', '+'),
  createAsset('slash', '斜杠', '╱'),
  createAsset('hourglass', '沙漏', '⧗'),
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

/** Resolve a state-specific glyph while accepting old themes with one field. */
export function resolveToolIndicatorAssetForTone(
  tone: 'run' | 'ok' | 'err',
  values: { toolIndicator?: string; toolIndicatorRun?: string; toolIndicatorOk?: string; toolIndicatorErr?: string },
): ToolIndicatorAsset {
  const value = tone === 'ok'
    ? values.toolIndicatorOk || values.toolIndicator
    : tone === 'err'
      ? values.toolIndicatorErr || values.toolIndicator
      : values.toolIndicatorRun || values.toolIndicator
  return resolveToolIndicatorAsset(value)
}

export function toolIndicatorOptions(): { value: string; label: string }[] {
  return TOOL_INDICATOR_ASSETS.map(asset => ({ value: asset.id, label: `${asset.glyph} ${asset.label}` }))
}
