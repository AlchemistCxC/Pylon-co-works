import type { InterfaceModeContribution } from '../../../plugin-runtime/interface-mode/interfaceModeTypes.ts'

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
  }),
  Object.freeze({
    id: 'terminal-like',
    label: 'Terminal-like',
    description: '经典记录流与四套终端呈现风格',
    icon: 'terminal',
    order: 20,
    defaultPresentationProfileId: 'builtin.presentation.terminal-classic',
    quickSwitchTargetId: 'modern-gui',
    chromeStyle: 'glyphs',
    workbench: Object.freeze({ renderKind: 'renderer-suite', defaultSuiteId: 'builtin.solid' }),
  }),
])
