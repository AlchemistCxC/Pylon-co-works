import type { AgentSidebarContribution, AgentSidebarTitleAction } from './sidebarTypes.ts'

/**
 * Agent Sheet 的左栏**整页**状态。
 *
 * 只剩 `activePageId`：当前展开到主区整页的模块 id；`null` 表示主区显示聊天视图。
 * 它回答的是「**这张 Sheet** 的主区此刻显示什么」，因此留在 Sheet 级状态里。
 *
 * 模块的折叠/展开不在这里——那是用户对左栏这个界面区域的整理意图，属于**跨 Sheet
 * 的界面偏好**，真值在 `domains/workbench/sidebarBlockCollapse`（独立 localStorage
 * key，issue #202）。
 */
export interface AgentSidebarPageState {
  readonly activePageId: string | null
}

export const EMPTY_PAGE_STATE: AgentSidebarPageState = Object.freeze({ activePageId: null })

/**
 * 模块折叠映射：模块 id → 用户是否把它收起。
 *
 * 与 `sidebarBlockCollapse` store 里的类型同构（两边都保持这个结构形状，互不 import，
 * 同 `sidebarModulePrefs` 不依赖贡献契约的分层取舍）。
 */
export type BlockCollapseMap = Readonly<Record<string, boolean>>

/**
 * 是否可折叠。所有模块一视同仁，默认 `true`。
 *
 * `alwaysOpen` **不再**压制折叠：它的语义已收窄为「不可隐藏」（常驻模块栈、不出现在显隐
 * 设置的可改项里）。用户明确要求会话模块也能折叠——「点击后工作区啥的都收进来」。
 */
export function resolveBlockCollapsible(contribution: AgentSidebarContribution): boolean {
  return contribution.collapsible ?? true
}

export function resolveBlockDefaultCollapsed(contribution: AgentSidebarContribution): boolean {
  if (contribution.alwaysOpen === true) return false
  return contribution.defaultCollapsed ?? false
}

/** 标题点击语义，省略为 `expand`。 */
export function resolveTitleAction(contribution: AgentSidebarContribution): AgentSidebarTitleAction {
  return contribution.onTitleClick ?? 'expand'
}

/**
 * 宿主是否该在模块头渲染一个「打开」按钮。
 *
 * 用户把模块的点击方案归纳为三种（点击展开 / 点击进页面 / 都要）。前两者由
 * `onTitleClick` 表达；**「都要」= `expand` + 声明了 `page`** —— 标题负责展开，
 * 页面由头部这个自动按钮进入。`onTitleClick: 'page'` 时标题已负责进页面，不再重复。
 */
export function shouldShowOpenPageAction(contribution: AgentSidebarContribution): boolean {
  return contribution.page !== undefined && resolveTitleAction(contribution) === 'expand'
}

/**
 * 从任意持久化值收敛出整页状态。未知形状一律回落空状态——包括旧模型的
 * `{ sidebarMode: 'work' | 'chat' }`，也包括「折叠映射同住 Sheet 状态」的上一代形状：
 * 折叠已迁出为跨 Sheet 偏好（issue #202），遗留的 `blockCollapsed` 字段在此被自然
 * 丢弃。换模型**不需要存储键迁移**。
 */
export function normalizePageState(raw: unknown): AgentSidebarPageState {
  if (raw && typeof raw === 'object') {
    const value = raw as { activePageId?: unknown }
    const activePageId = typeof value.activePageId === 'string' && value.activePageId.trim() !== '' ? value.activePageId.trim() : null
    return Object.freeze({ activePageId })
  }
  return EMPTY_PAGE_STATE
}

/** 某模块此刻是否折叠：用户显式操作过以用户为准，否则取贡献声明的默认值。 */
export function isBlockCollapsed(
  contribution: AgentSidebarContribution,
  collapsed: BlockCollapseMap,
): boolean {
  if (!resolveBlockCollapsible(contribution)) return false
  const explicit = collapsed[contribution.id]
  return explicit ?? resolveBlockDefaultCollapsed(contribution)
}

/** 翻转某模块的折叠并产出新映射（不可折叠的模块原样返回）。落库归 `sidebarBlockCollapseStore`。 */
export function toggleBlockCollapsed(
  contribution: AgentSidebarContribution,
  collapsed: BlockCollapseMap,
): BlockCollapseMap {
  if (!resolveBlockCollapsible(contribution)) return collapsed
  const next = !isBlockCollapsed(contribution, collapsed)
  return { ...collapsed, [contribution.id]: next }
}

/** 某模块此刻是否已展开为主区整页。 */
export function isBlockPageOpen(contribution: AgentSidebarContribution, state: AgentSidebarPageState): boolean {
  return contribution.page !== undefined && state.activePageId === contribution.id
}

/**
 * 打开某模块的整页。只有声明了 `page` 的模块可打开——否则返回原状态，
 * 避免持久化一个指向「无处可去」的 id。
 */
export function openBlockPage(
  contribution: AgentSidebarContribution,
  state: AgentSidebarPageState,
): AgentSidebarPageState {
  if (contribution.page === undefined || state.activePageId === contribution.id) return state
  return { ...state, activePageId: contribution.id }
}

/** 关掉整页，回到聊天视图。 */
export function closeBlockPage(state: AgentSidebarPageState): AgentSidebarPageState {
  if (state.activePageId === null) return state
  return { ...state, activePageId: null }
}

/**
 * 从注册表快照里解出当前打开的页面贡献。
 * 只认**同时**声明了 `page` 的贡献：指向已被卸载/未声明的 id 一律回落 `null`
 * （插件停用后不应把主区锁在一个不存在的页面上）。
 */
export function resolveOpenPage(
  contributions: readonly AgentSidebarContribution[],
  state: AgentSidebarPageState,
): AgentSidebarContribution | null {
  if (state.activePageId === null) return null
  return contributions.find(item => item.id === state.activePageId && item.page !== undefined) ?? null
}
