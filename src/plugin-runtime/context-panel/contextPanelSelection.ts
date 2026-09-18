import type {
  ContextPanelContributionContext,
  ContextPanelRegistryEntry,
} from './contextPanelTypes.ts'
import { reportRuntimeError } from '../../runtimeError.ts'

const reportedWhenFailures = new WeakSet<NonNullable<ContextPanelRegistryEntry['value']['when']>>()

/**
 * 当前上下文下**可以显示**的右栏面板（chrome、布局槽与宿主共用同一条选择器）。
 *
 * 只按 `when` 闸门过滤，**不再按 `workspaceKind` 过滤**：后者曾把右栏内容锁死在 Sheet
 * 种类上（agent Sheet 只有「上下文」、file Sheet 只有「关联」），于是一个面板的 Sheet 连
 * 切换器都凑不出来（用户实机报「侧栏内部没有切换栏种类的按钮」）。现在种类只决定
 * **自动选中谁**（见 `resolveContextPanelDefault`），用户想切到哪一类都能切。
 *
 * `when` 仍是硬闸门：它是插件表达「此刻这个面板根本没有意义」的手段（例如无会话时不显示），
 * 与「适不适合这个 Sheet」是两回事，两者不该混成一条轴。
 */
export function selectContextPanels(
  entries: readonly ContextPanelRegistryEntry[],
  context: ContextPanelContributionContext,
): readonly ContextPanelRegistryEntry[] {
  return entries.filter(entry => {
    try {
      return entry.value.when?.(context) ?? true
    } catch (error) {
      const predicate = entry.value.when
      if (predicate && !reportedWhenFailures.has(predicate)) {
        reportedWhenFailures.add(predicate)
        reportRuntimeError(`右栏贡献 ${entry.contributionId} 判断可用性`, error)
      }
      return false
    }
  })
}

/**
 * 用户没有显式选择过面板时，右栏默认显示谁。
 *
 * 优先级：声明了**当前 Sheet 种类**的面板（`workspaceKind` 的亲和语义）→ 第一个 `global`
 * 面板 → 列表第一个。用户一旦在切换器里选过，`rightRailStore.activePanelId` 就是显式选择，
 * 跨 Sheet 保持——切 Sheet 不该把用户刚选的栏抢回默认值。
 */
export function resolveContextPanelDefault(
  entries: readonly ContextPanelRegistryEntry[],
  workspaceKind: string | undefined,
): ContextPanelRegistryEntry | undefined {
  if (workspaceKind) {
    const affine = entries.find(entry => entry.value.workspaceKind === workspaceKind)
    if (affine) return affine
  }
  return entries.find(entry => entry.value.scope === 'global') ?? entries[0]
}
