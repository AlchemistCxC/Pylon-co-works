/**
 * featureAvailability — 功能可用态（报告阶段 4.5-4.7）。
 *
 * available/read-only/unsupported/disconnected/unknown 五态：
 * - available：能力已声明且可用
 * - read-only：可读但不可写（保留位）
 * - unsupported：能力显式关闭/不支持
 * - disconnected：Agent 未连接（capability 缺失时保守处理）
 * - unknown：能力未声明（保守——不默认开放写操作）
 */
export type FeatureAvailability = 'available' | 'read-only' | 'unsupported' | 'disconnected' | 'unknown'

export function resolveFeatureAvailability(capability: boolean | undefined, connected: boolean): FeatureAvailability {
  if (!connected) return 'disconnected'
  if (capability === true) return 'available'
  if (capability === false) return 'unsupported'
  // 未声明 ≠ 不支持，但保守：不默认开放（报告阶段 4.7）
  return 'unknown'
}

/** 该可用态是否允许写操作（available 才放行；read-only 保守视为禁写） */
export function canWrite(availability: FeatureAvailability): boolean {
  return availability === 'available'
}

/** UI 展示文案（disabled 控件解释原因用，报告阶段 10.6） */
export function availabilityReason(availability: FeatureAvailability): string | null {
  switch (availability) {
    case 'available': return null
    case 'read-only': return '当前只读，暂不支持修改'
    case 'unsupported': return '该能力未被 Agent 支持'
    case 'disconnected': return 'Agent 未连接，暂不可用'
    case 'unknown': return '能力未确认，暂不开放'
  }
}
