import { ValidatedContributionRegistry } from '../registry/validatedContributionRegistry.ts'
import { validatePromptContribution, type PromptContribution, type PromptContributionTarget } from './promptContributionTypes.ts'

/**
 * #201：prompt 注入贡献注册表。与 FontContributionRegistry 同一注册表基建
 * （PluginIdentity 命名空间 + 快照订阅 + shadow transaction），宿主消费面见
 * `host/commandSetResolver.assembleSessionPrompt`。
 *
 * 启用过滤按**注册属主**（ownerPluginId）判定，与命令清单的 `enabledPluginIds`
 * 语义一致（缺省 = 全部已注册贡献）。
 */
export class PromptContributionRegistry extends ValidatedContributionRegistry<PromptContribution> {
  constructor() { super(validatePromptContribution) }

  /** 按注入目标取已启用插件的贡献（非空文本；order 稳定排序）。 */
  resolveTarget(target: PromptContributionTarget, enabledPluginIds?: readonly string[]): readonly PromptContribution[] {
    const { entries } = this.getSnapshot()
    return entries
      .filter(entry => entry.value.target === target)
      .filter(entry => enabledPluginIds === undefined || enabledPluginIds.includes(entry.ownerPluginId))
      .map(entry => entry.value)
      .filter(contribution => contribution.text.length > 0)
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  }
}
