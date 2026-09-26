import { normalizeSettingsIntent, type SettingsIntent } from '../components/settings/settingsDomains.ts'

/**
 * Settings Sheet 的持久化状态（#154 阶段 4：设置由固定覆盖层迁入 sheet 体系）。
 *
 * 导航真值（domain / section / pluginPageId / agentId）沿用 settingsDomains 的
 * `SettingsIntent` 契约——深链归一（`normalizeSettingsIntent`）与既有
 * `pylon:open-settings` 事件、LEGACY 别名全部零迁移。在此之上
 * 只补一个渲染器目录的分类导航位：侧栏点 renderers 三级项与速搜命中
 * rendererRoute 都要落同一个分类，属于导航态而非视图态。
 */
export interface SettingsSheetState extends SettingsIntent {
  readonly rendererCategoryId?: string
}

/**
 * 深链形状（旧 Settings props / open-settings detail）→ 合法 sheet 状态。未知值一律归一，不抛。
 *
 * #274：`pluginPageId` 的 resolve 区分「显式 null」与「键缺失」——patchSheetState
 * 对 sheet 状态是浅合并，归一输出若把清除意图归并成「键缺失」，旧值在合并下永远
 * 存活，插件贡献页导航即被困。故归一输出**恒含** `pluginPageId`（string 或 null），
 * 作为完整快照参与「最后写入胜出」；落盘前由 serialize 剥除 null（持久化形状
 * 与历史版本零差异，ADR-0013 决定 4 老状态可读）。
 */
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
  const pluginPageId =
    input.pluginPageId === null
      ? null
      : typeof input.pluginPageId === 'string' && input.pluginPageId
        ? input.pluginPageId
        : (intent.pluginPageId ?? null)
  const rendererCategoryId = typeof input.rendererCategoryId === 'string' && input.rendererCategoryId
    ? input.rendererCategoryId
    : undefined
  return {
    domain: intent.domain,
    section: intent.section,
    pluginPageId,
    ...(intent.agentId ? { agentId: intent.agentId } : {}),
    ...(rendererCategoryId ? { rendererCategoryId } : {}),
  }
}

/** 落盘形状：剥除内存中间态的显式 null（「无插件页」在磁盘上仍是无键）。 */
export function serializeSettingsSheetState(raw: unknown): SettingsSheetState {
  const state = normalizeSettingsSheetState(raw)
  if (state.pluginPageId !== null) return state
  const { pluginPageId: _cleared, ...rest } = state
  return rest
}

export function deserializeSettingsSheetState(raw: unknown): SettingsSheetState {
  return normalizeSettingsSheetState(raw)
}
