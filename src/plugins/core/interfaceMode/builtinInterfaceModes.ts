import type { InterfaceModeContribution } from '../../../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { DEFAULT_SHELL_RECIPE_ID } from '../../../plugin-runtime/shell-recipe/shellRecipeTypes.ts'

export const BUILTIN_INTERFACE_MODES: readonly InterfaceModeContribution[] = Object.freeze([
  Object.freeze({
    id: 'modern-gui',
    label: '现代 GUI',
    description: '图形化工作台、语义图标与分层交互',
    icon: 'panels',
    order: 10,
    defaultPresentationProfileId: 'builtin.presentation.modern-gui',
    quickSwitchTargetId: 'terminal-like',
    chromeStyle: 'icons',
    workbench: Object.freeze({ renderKind: 'renderer-suite', defaultSuiteId: 'builtin.solid' }),
    shellRecipeId: DEFAULT_SHELL_RECIPE_ID,
  }),
  Object.freeze({
    id: 'terminal-like',
    // #116 子项 4c：三选一里另两项已是「现代 GUI」「蓝调战术」，原先只有它显示英文。
    label: '经典终端',
    description: '经典记录流与四套终端呈现风格',
    icon: 'terminal',
    order: 20,
    defaultPresentationProfileId: 'builtin.presentation.terminal-classic',
    quickSwitchTargetId: 'modern-gui',
    chromeStyle: 'glyphs',
    workbench: Object.freeze({ renderKind: 'renderer-suite', defaultSuiteId: 'builtin.solid' }),
    shellRecipeId: DEFAULT_SHELL_RECIPE_ID,
  }),
  Object.freeze({
    id: 'tactical-blue',
    label: '蓝调战术',
    description: '蓝黑战术网格、斜切视觉与完整 Agent 工作台',
    icon: 'panels',
    order: 30,
    defaultPresentationProfileId: 'builtin.presentation.tactical-blue',
    quickSwitchTargetId: 'modern-gui',
    chromeStyle: 'icons',
    workbench: Object.freeze({ renderKind: 'renderer-suite', defaultSuiteId: 'builtin.solid' }),
    shellRecipeId: DEFAULT_SHELL_RECIPE_ID,
  }),
])
