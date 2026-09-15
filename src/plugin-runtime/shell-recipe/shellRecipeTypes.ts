import type { RegistryEntry } from '../registry/types.ts'

export type ShellRailSide = 'left' | 'right'

/**
 * Declarative shell rearrangement owned by an Interface Mode. The host keeps
 * rendering the skeleton (titlebar, rails, workspace); a recipe only
 * parameterises the arrangement (rail sides). Native window controls and the
 * drag region stay host-owned regardless of the recipe (ADR-0003).
 */
export interface ShellRecipeContribution {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly order?: number
  /** Side of the session sidebar shell. Default 'left'. */
  readonly sidebarSide: ShellRailSide
  /** Side of the context panel rail. Default 'right'. Must differ from sidebarSide. */
  readonly contextPanelSide: ShellRailSide
}

export type ShellRecipeRegistryEntry = RegistryEntry<ShellRecipeContribution>

export const DEFAULT_SHELL_RECIPE_ID = 'builtin.shell.classic'

export const DEFAULT_SHELL_RECIPE: ShellRecipeContribution = Object.freeze({
  id: DEFAULT_SHELL_RECIPE_ID,
  label: '经典双栏',
  description: '会话侧栏在左、上下文面板在右的宿主默认排布。',
  order: 10,
  sidebarSide: 'left',
  contextPanelSide: 'right',
})
