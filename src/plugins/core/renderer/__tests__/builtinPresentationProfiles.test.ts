import { describe, expect, it } from 'vitest'
import { BUILTIN_PRESENTATION_PROFILES } from '../builtinPresentationProfiles.ts'
import { validatePresentationProfile } from '../../../../plugin-runtime/presentation/presentationProfileRegistry.ts'

const TERMINAL_CLASSIC_SNAPSHOT = {
  id: 'builtin.presentation.terminal-classic',
  label: '终端经典',
  description: '紧凑命令记录流、可读正文、CLI 输入和克制的工具状态。',
  family: 'terminal',
  order: 100,
  tokens: {
    msgStyle: 'terminal', messageLayout: 'classic', chatFont: 'mono', msgFont: 'system',
    msgLineHeight: 1.55, inputMode: 'cli', inputVariant: 'cli', inputBg: 'rgba(0,0,0,0.02)',
    inputBorderColor: '', inputFocusBorder: 'rgba(0,0,0,0.22)', inputRadius: 0, inputFocusRingWidth: 0,
    ccVariant: 'terminal',
    assistantDot: false, toolIndicator: '●', toolIndicatorRun: 'circle', toolIndicatorOk: 'circle', toolIndicatorErr: 'circle', toolIndicatorGlow: 0,
    toolConnectorMode: 'none', spinnerFramePreset: 'ascii-line', spinnerVerbSet: 'engineering',
    cliHintMode: 'compact', footerLayout: 'free',
  },
  assets: { promptGlyph: '❯', runningGlyph: '●', completedGlyph: '●', failedGlyph: '●' },
}

const COMPLETE_SURFACE_TOKENS = [
  'msgStyle', 'messageLayout', 'messageUserBg', 'messageAssistantBg', 'messageReasoningBg',
  'messageBorderColor', 'messageRadius', 'inputMode', 'inputVariant', 'inputBg',
  'inputBorderColor', 'inputFocusBorder', 'inputRadius', 'inputFocusRingWidth',
] as const

const COMPLETE_CC_INPUT_TOKENS = [
  'inputMode', 'inputVariant', 'inputBg', 'inputBorderColor', 'inputFocusBorder',
  'inputRadius', 'inputFocusRingWidth', 'ccVariant', 'cliHintMode', 'footerLayout',
] as const

describe('built-in terminal-like presentation profiles', () => {
  it('所有内置预设均可通过生产 PresentationProfileRegistry 校验', () => {
    for (const profile of BUILTIN_PRESENTATION_PROFILES) {
      expect(() => validatePresentationProfile(profile), profile.id).not.toThrow()
    }
  })

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

it.each([
    ['builtin.presentation.agent-command', 'content.plan', { density: 'compact', defaultExpanded: true }],
    ['builtin.presentation.agent-map', 'activity.subagent', { viewMode: 'tree', identityMarker: 'avatar' }],
    ['builtin.presentation.focus-flow', 'activity.workflow', { workflowLayout: 'list', collapseCompleted: true }],
  ])('%s 提供可由 Solid renderer 消费的执行视图预设', (profileId, kind, expected) => {
    const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
    expect(profile).toBeDefined()
    expect(profile?.kindTokens?.[kind]).toMatchObject(expected)
  })

  it.each(BUILTIN_PRESENTATION_PROFILES.map(profile => profile.id))('%s 显式覆盖中控与输入的必需 token', profileId => {
    const profile = BUILTIN_PRESENTATION_PROFILES.find(candidate => candidate.id === profileId)
    expect(profile).toBeDefined()
    for (const token of COMPLETE_CC_INPUT_TOKENS) expect(profile?.tokens).toHaveProperty(token)
  })
})
