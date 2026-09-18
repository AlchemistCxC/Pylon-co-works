import type { AgentSidebarContribution } from './sidebarTypes.ts'

/**
 * 左栏区块状态。
 *
 * - `blockCollapsed`：键是区块 id，值是「用户是否把它收起了」。
 *   用显式映射而不是「塌陷 id 清单」，是因为贡献可以声明 `defaultCollapsed`：
 *   若只记录塌陷项，用户把默认塌陷的区块**展开**后无处落笔（从清单移除 → 又回落到
 *   默认塌陷），方向即反转。显式映射两个方向都记得住。
 * - `activePageId`：当前展开到主区整页的区块 id；`null` 表示主区显示聊天视图。
 *
 * 两个字段必须**一起写**：`patchSheetState` 是替换语义，只写一个会抹掉另一个。
 * 因此本模块只暴露产出完整状态的助手，调用方不得自行拼半个对象。
 */
export interface AgentSidebarBlockState {
  readonly blockCollapsed: Readonly<Record<string, boolean>>
  readonly activePageId: string | null
}

export const EMPTY_BLOCK_STATE: AgentSidebarBlockState = Object.freeze({ blockCollapsed: Object.freeze({}), activePageId: null })

/**
 * 是否可折叠。默认按分区给：
 * - `modules` 是常驻能力区块，默认可折叠（用户要能把它们收起来腾出会话区）；
 * - `sessions` 是左栏主体，默认不可折叠（折了左栏就没内容了）。
 */
export function resolveBlockCollapsible(contribution: AgentSidebarContribution): boolean {
  return contribution.collapsible ?? contribution.region === 'modules'
}

export function resolveBlockDefaultCollapsed(contribution: AgentSidebarContribution): boolean {
  return contribution.defaultCollapsed ?? false
}

/**
 * 从任意持久化值收敛出区块状态。未知形状一律回落空状态——包括旧模型的
 * `{ sidebarMode: 'work' | 'chat' }`，因此换模型**不需要存储键迁移**。
 */
export function normalizeBlockState(raw: unknown): AgentSidebarBlockState {
  if (raw && typeof raw === 'object') {
    const value = raw as { blockCollapsed?: unknown; activePageId?: unknown }
    const collapsedEntries = value.blockCollapsed && typeof value.blockCollapsed === 'object' && !Array.isArray(value.blockCollapsed)
      ? Object.entries(value.blockCollapsed as Record<string, unknown>)
        .filter(([id, collapsed]) => id.trim() !== '' && typeof collapsed === 'boolean')
      : []
    const activePageId = typeof value.activePageId === 'string' && value.activePageId.trim() !== '' ? value.activePageId.trim() : null
    return Object.freeze({
      blockCollapsed: Object.freeze(Object.fromEntries(collapsedEntries as [string, boolean][])),
      activePageId,
    })
  }
  return EMPTY_BLOCK_STATE
}

/** 某区块此刻是否折叠：用户显式操作过以用户为准，否则取贡献声明的默认值。 */
export function isBlockCollapsed(
  contribution: AgentSidebarContribution,
  state: AgentSidebarBlockState,
): boolean {
  if (!resolveBlockCollapsible(contribution)) return false
  const explicit = state.blockCollapsed[contribution.id]
  return explicit ?? resolveBlockDefaultCollapsed(contribution)
}

/** 翻转某区块的折叠并落成新状态（不可折叠的区块原样返回）。 */
export function toggleBlockCollapsed(
  contribution: AgentSidebarContribution,
  state: AgentSidebarBlockState,
): AgentSidebarBlockState {
  if (!resolveBlockCollapsible(contribution)) return state
  const next = !isBlockCollapsed(contribution, state)
  return { ...state, blockCollapsed: { ...state.blockCollapsed, [contribution.id]: next } }
}

/** 某区块此刻是否已展开为主区整页。 */
export function isBlockPageOpen(contribution: AgentSidebarContribution, state: AgentSidebarBlockState): boolean {
  return contribution.page !== undefined && state.activePageId === contribution.id
}

/**
 * 打开某区块的整页。只有声明了 `page` 的区块可打开——否则返回原状态，
 * 避免持久化一个指向「无处可去」的 id。
 */
export function openBlockPage(
  contribution: AgentSidebarContribution,
  state: AgentSidebarBlockState,
): AgentSidebarBlockState {
  if (contribution.page === undefined || state.activePageId === contribution.id) return state
  return { ...state, activePageId: contribution.id }
}

/** 关掉整页，回到聊天视图。 */
export function closeBlockPage(state: AgentSidebarBlockState): AgentSidebarBlockState {
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
  state: AgentSidebarBlockState,
): AgentSidebarContribution | null {
  if (state.activePageId === null) return null
  return contributions.find(item => item.id === state.activePageId && item.page !== undefined) ?? null
}
