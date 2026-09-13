// 迁移自 scripts/test-apply-custom-preset.mts（P91 A1）；源码正则结构守卫段不迁（行为已由下列断言证实）。
import { describe, expect, it } from 'vitest'
import { DEFAULT_CC_LAYOUT } from '../../../ccLayoutState.ts'
import {
  applyCustomPresetReducer,
  type ThemePresetState,
} from '../presetReducer.ts'

// A0：applyCustomPreset 纯计算在 presetReducer，本测试直接调真实 reducer，
// 验证业务状态隔离 + ccLayout 归一化。

function makeState(customPresets: ThemePresetState['customPresets']): ThemePresetState {
  return {
    appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
    custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
    customPresets,
    ccLayout: DEFAULT_CC_LAYOUT,
    ccHeight: 150,
    ccBgHeight: 150,
    inputMode: 'cli',
    inputVariant: 'cli',
    inputSubmitButtonMode: 'never',
    footerLayout: 'free',
    cliHintMode: 'full',
    ccHidden: [],
    ccStyle: 'wave',
    cliOverflowMode: 'fixed-scroll',
  }
}

describe('applyCustomPresetReducer — 业务状态隔离 + ccLayout 归一化（迁移自 scripts/test-apply-custom-preset.mts，P91 A1）', () => {
  // 被"投毒"的预设主题：合法主题字段 + 越界排布 + 业务键（不应进入 patch）
  const poisonedTheme = {
    globalBgColor: '#123456',
    ccLayout: {
      version: 3 as const,
      placements: {
        ...DEFAULT_CC_LAYOUT.placements,
        input: { slot: 'input' as const, order: 999, offsetX: 999, offsetY: -999 },
      },
    },
    profiles: [{ id: 'overwritten' }],
    activeProfileId: 'overwritten',
    sessions: [{ id: 'overwritten' }],
    sessionLiveStats: { overwritten: {} },
    sessionModes: { overwritten: 'bad' },
    sessionConfig: { overwritten: {} },
    liveGeneratingSources: ['overwritten'],
    agents: [{ id: 'overwritten', name: 'bad' }],
    activeAgent: 'overwritten',
    agentStatuses: { overwritten: { status: 'bad' } },
    customPresets: [{ id: 'overwritten' }],
  }

  const preset = {
    id: 'custom-isolation',
    name: '隔离测试',
    theme: poisonedTheme as unknown as ThemePresetState['customPresets'][number]['theme'],
    createdAt: 1,
    updatedAt: 1,
  }

  it('存在的自定义预设应返回 patch：主题字段应用 + 业务键隔离（白名单过滤）', () => {
    const patch = applyCustomPresetReducer(makeState([preset]), 'custom-isolation')
    expect(patch).not.toBeNull()
    expect(patch!.globalBgColor).toBe('#123456')
    expect((patch as Record<string, unknown>).profiles).toBeUndefined()
    expect((patch as Record<string, unknown>).sessions).toBeUndefined()
    expect((patch as Record<string, unknown>).sessionModes).toBeUndefined()
    expect((patch as Record<string, unknown>).agents).toBeUndefined()
    expect((patch as Record<string, unknown>).customPresets).toBeUndefined()
  })

  it('ccLayout 归一化：越界排布被 clamp', () => {
    const patch = applyCustomPresetReducer(makeState([preset]), 'custom-isolation')
    expect(patch!.ccLayout?.version).toBe(DEFAULT_CC_LAYOUT.version)
    expect(patch!.ccLayout?.placements.input).toEqual({ slot: 'input', order: 99, offsetX: 48, offsetY: -16 })
  })

  it('路由：全 zone 记 id + 全 custom 清', () => {
    const patch = applyCustomPresetReducer(makeState([preset]), 'custom-isolation')
    expect(patch!.appliedPreset?.global).toBe('custom-isolation')
    expect(patch!.appliedPreset?.chat).toBe('custom-isolation')
    expect(patch!.custom?.global).toBe(false)
  })

  it('不存在的预设 → null（无操作）', () => {
    expect(applyCustomPresetReducer(makeState([preset]), 'custom-missing')).toBeNull()
  })
})
