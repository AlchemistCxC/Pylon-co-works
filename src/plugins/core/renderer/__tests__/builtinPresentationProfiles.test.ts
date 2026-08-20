import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../builtinPresentationProfiles.ts'

const TERMINAL_CLASSIC_SNAPSHOT = {
  id: 'builtin.presentation.terminal-classic',
  label: '终端经典',
  description: '紧凑命令记录流、等宽正文、CLI 输入和克制的工具状态。',
  family: 'terminal',
  order: 100,
  tokens: {
    msgStyle: 'terminal', messageLayout: 'classic', chatFont: 'mono', msgFont: 'mono',
    msgLineHeight: 1.55, inputMode: 'cli', inputVariant: 'cli', ccVariant: 'terminal',
    assistantDot: false, toolIndicator: '●', toolIndicatorGlow: 0,
    toolConnectorMode: 'none', spinnerFramePreset: 'ascii-line', spinnerVerbSet: 'engineering',
    cliHintMode: 'compact', footerLayout: 'free',
  },
  assets: { promptGlyph: '❯', runningGlyph: '●', completedGlyph: '✓', failedGlyph: '!' },
}

const COMPLETE_SURFACE_TOKENS = [
  'msgStyle', 'messageLayout', 'messageUserBg', 'messageAssistantBg', 'messageReasoningBg',
  'messageBorderColor', 'messageRadius', 'inputMode', 'inputVariant', 'inputBg',
  'inputBorderColor', 'inputFocusBorder', 'inputRadius', 'inputFocusRingWidth',
] as const

describe('built-in terminal-like presentation profiles', () => {
  it('冻结 terminal-classic 的完整定义，防止其他 Profile 施工改变经典终端', () => {
    expect(BUILTIN_PRESENTATION_PROFILES.find(profile => profile.id === 'builtin.presentation.terminal-classic')).toEqual(TERMINAL_CLASSIC_SNAPSHOT)
  })

  it('现代工作台是 modern-gui 的独立 Profile，不伪装成第五个终端风格', () => {
    expect(BUILTIN_PRESENTATION_PROFILES.find(profile => profile.id === 'builtin.presentation.modern-gui')).toMatchObject({
      family: 'gui',
      interfaceMode: 'modern-gui',
    })
  })

  it.each([
    'builtin.presentation.terminal-modern',
    'builtin.presentation.paper-low-contrast',
    'builtin.presentation.console-glass',
  ])('%s 显式覆盖输入面与消息面的完整 token', profileId => {
    const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
    expect(profile).toBeDefined()
    for (const token of COMPLETE_SURFACE_TOKENS) expect(profile?.tokens).toHaveProperty(token)
  })
})
