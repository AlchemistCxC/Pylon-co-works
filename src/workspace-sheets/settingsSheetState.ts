import { normalizeSettingsIntent, type SettingsIntent } from '../settingsDomains.ts'

/**
 * Settings Sheet 的持久化状态（#154 阶段 4：设置由固定覆盖层迁入 sheet 体系）。
 *
 * 导航真值（domain / section / pluginPageId / agentId）沿用 settingsDomains 的
 * `SettingsIntent` 契约——深链归一（`normalizeSettingsIntent`）与既有
 * `pylon:open-settings` 事件、LEGACY_SETTINGS_ROUTES 别名全部零迁移。在此之上
 * 只补一个渲染器目录的分类导航位：侧栏点 renderers 三级项与速搜命中
 * rendererRoute 都要落同一个分类，属于导航态而非视图态。
 */
export interface SettingsSheetState extends SettingsIntent {
  readonly rendererCategoryId?: string
}

/** 深链形状（旧 Settings props / open-settings detail）→ 合法 sheet 状态。未知值一律归一，不抛。 */
export function normalizeSettingsSheetState(raw: unknown): SettingsSheetState {
  const input = (raw && typeof raw === 'object' ? raw : {}) as {
    domain?: unknown
    section?: unknown
    agentId?: unknown
    pluginPageId?: unknown
    rendererCategoryId?: unknown
  }
  const intent = normalizeSettingsIntent({
    domain: typeof input.domain === 'string' ? input.domain : null,
    section: typeof input.section === 'string' ? input.section : null,
    agentId: typeof input.agentId === 'string' ? input.agentId : null,
  })
  const pluginPageId = typeof input.pluginPageId === 'string' && input.pluginPageId
    ? input.pluginPageId
    : intent.pluginPageId
  const rendererCategoryId = typeof input.rendererCategoryId === 'string' && input.rendererCategoryId
    ? input.rendererCategoryId
    : undefined
  return {
    domain: intent.domain,
    section: intent.section,
    ...(pluginPageId ? { pluginPageId } : {}),
    ...(intent.agentId ? { agentId: intent.agentId } : {}),
    ...(rendererCategoryId ? { rendererCategoryId } : {}),
  }
}

export function serializeSettingsSheetState(raw: unknown): SettingsSheetState {
  return normalizeSettingsSheetState(raw)
}

export function deserializeSettingsSheetState(raw: unknown): SettingsSheetState {
  return normalizeSettingsSheetState(raw)
}
