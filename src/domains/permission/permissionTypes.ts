/**
 * permissionTypes — 权限请求 wire 收窄模型（P0-01）。
 *
 * pylon:permission-request 事件（契约 §2.3/§3）的前端收窄：保留 requestId 原值、
 * options 顺序与 optionId 原值（D15——不硬编码 Peri/Hermes 按钮集），其余字段宽容
 * （未知键保留，供 P0-03 弹窗与 diff 特化读取，不做任何解释）。
 */

/** wire option 项的前端收窄：optionId 是唯一必需键，其余字段宽容保留 */
export interface PermissionOption {
  optionId: string
  label?: string
  kind?: string
  [key: string]: unknown
}

/** 权限请求（前端收窄形态） */
export interface PermissionRequest {
  requestId: number
  sessionId?: string
  toolCallId?: string
  title?: string
  /** 已脱敏（后端保证 ≤500） */
  prompt?: string
  options: PermissionOption[]
  requestedAt?: number
}
