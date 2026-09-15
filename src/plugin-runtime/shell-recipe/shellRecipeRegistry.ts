import { ValidatedContributionRegistry } from '../registry/validatedContributionRegistry.ts'
import { INTERFACE_MODE_ID_PATTERN } from '../interface-mode/interfaceModeRegistry.ts'
import type { ShellRailSide, ShellRecipeContribution } from './shellRecipeTypes.ts'

function validateRailSide(value: unknown, label: string): value is ShellRailSide {
  if (value !== 'left' && value !== 'right') throw new Error(`${label} 非法：${String(value)}`)
  return true
}

export function validateShellRecipeContribution(
  contribution: ShellRecipeContribution,
): ShellRecipeContribution {
  if (!INTERFACE_MODE_ID_PATTERN.test(contribution.id)) throw new Error(`Shell Recipe id 非法：${contribution.id}`)
  if (!contribution.label?.trim()) throw new Error(`Shell Recipe label 不能为空：${contribution.id}`)
  if (contribution.order !== undefined && !Number.isFinite(contribution.order)) {
    throw new Error(`Shell Recipe order 非法：${contribution.id}`)
  }
  validateRailSide(contribution.sidebarSide, `Shell Recipe ${contribution.id} sidebarSide`)
  validateRailSide(contribution.contextPanelSide, `Shell Recipe ${contribution.id} contextPanelSide`)
  // v1 语义：双栏各占一侧；同侧堆叠需要第二版旋钮（ADR-0003）。
  if (contribution.sidebarSide === contribution.contextPanelSide) {
    throw new Error(`Shell Recipe ${contribution.id} sidebarSide 与 contextPanelSide 不得同侧`)
  }
  return Object.freeze({ ...contribution })
}

export class ShellRecipeRegistry extends ValidatedContributionRegistry<ShellRecipeContribution> {
  constructor() { super(validateShellRecipeContribution) }
}
