/**
 * permissionButtons — 权限弹窗按钮映射（P0-03）。
 *
 * options → 按钮描述：保持 wire 顺序、optionId 原值，label 缺省回退 optionId
 * （D15——不硬编码 Peri/Hermes 按钮集，纯域可单测；组件只做渲染不解释 wire）。
 */

import type { PermissionRequest } from './permissionTypes.ts'

export interface PermissionButton {
  optionId: string
  label: string
  kind?: string
}

export function resolvePermissionButtons(request: PermissionRequest): PermissionButton[] {
  return request.options.map(option => ({
    optionId: option.optionId,
    label: typeof option.label === 'string' && option.label.length > 0 ? option.label : option.optionId,
    kind: typeof option.kind === 'string' ? option.kind : undefined,
  }))
}
