// 迁移自 scripts/test-apply-custom-preset.mts（P91 A1）；源码正则结构守卫段不迁（行为已由下列断言证实）。
import { describe, expect, it } from 'vitest'
import { DEFAULT_CC_LAYOUT } from '../../cc/ccLayoutState.ts'
import { GLOBAL_PRESETS } from '../../../presets/index.ts'
import { effectivePresetTheme } from '../../../zones/index.ts'
import { ZONE_FIELDS } from '../../../themeFieldDefs.ts'
import type { ThemeSettings } from '../../../store'
import {
  applyCustomPresetReducer,
  applyZonePresetReducer,
  deriveGlobalStatus,
  deriveZoneStatus,
  removeCustomPresetReducer,
  saveCustomPresetReducer,
  setGlobalPresetReducer,
  setZoneFieldReducer,
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
    inputMode: 'cli',
    inputVariant: 'cli',
    inputSubmitButtonMode: 'never',
    footerLayout: 'free',
    cliHintMode: 'full',
    ccHidden: [],
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
        // ★ 样本保留 legacy `slot`（老预设数据的真实形状）：#238 刀3 起读盘/归一化一律不读它
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
    // ★ #238 刀3：归一化结果里不再有 `slot`（老字段被丢掉，其余 clamp 语义不变）
    expect(patch!.ccLayout?.placements.input).toEqual({ order: 99, offsetX: 48, offsetY: -16 })
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

// ── 迁移自 scripts/test-zone-preset-state.mts（P91 A1）：预设路由纯 reducer 全套（5 zones，确定性）。
// 末尾 widgetDefinitions chips 源码正则断言段不迁（结构守卫，留给后续下沉片）。
describe('预设路由纯 reducer 全套（迁移自 scripts/test-zone-preset-state.mts，P91 A1）', () => {
  const zones = ['global', 'sidebar', 'chat', 'cc', 'right'] as const
  const nord = GLOBAL_PRESETS.find(p => p.name === 'nord')!
  const glass = GLOBAL_PRESETS.find(p => p.name === 'glass')!
  const solarized = GLOBAL_PRESETS.find(p => p.name === 'solarized')!

  function makeZoneState(overrides: Partial<ThemePresetState> = {}): ThemePresetState {
    return {
      appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
      custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
      customPresets: [],
      ccLayout: DEFAULT_CC_LAYOUT,
      ccHeight: 150,
      inputMode: 'cli',
      inputVariant: 'cli',
      inputSubmitButtonMode: 'inline',
      footerLayout: 'free',
      cliHintMode: 'full',
      ccHidden: [],
        cliOverflowMode: 'fixed-scroll',
      ...overrides,
    }
  }

  it('D1 校验漏斗：ccHeight clamp + inputVariant↔inputMode 联动', () => {
    const state = makeZoneState()
    // ccHeight 低于最小高（64 base）→ clamp 上调
    const lowPatch = setZoneFieldReducer(state, 'cc', { ccHeight: 5 })
    expect(typeof lowPatch.ccHeight).toBe('number')
    expect(lowPatch.ccHeight as number).toBeGreaterThanOrEqual(64) // ccHeight 必须 clamp 到最小高
    // inputVariant → inputMode 联动
    const variantPatch = setZoneFieldReducer(state, 'cc', { inputVariant: 'composer' })
    expect(variantPatch.inputMode).toBe('default') // inputVariant=composer → inputMode=default
    expect(variantPatch.inputVariant).toBe('composer')
    // inputMode → inputVariant 联动（cli ⟺ cli）
    const modePatch = setZoneFieldReducer(makeZoneState({ inputVariant: 'composer' }), 'cc', { inputMode: 'cli' })
    expect(modePatch.inputVariant).toBe('cli') // inputMode=cli → inputVariant=cli
  })

  it('setZoneField：写入字段 + 标 zone custom，不污染其他 zone、不带 appliedPreset（基准不动）', () => {
    const state = makeZoneState()
    const patch = setZoneFieldReducer(state, 'chat', { chatFontSize: 99 })
    expect(patch.chatFontSize).toBe(99) // setZoneField 应写入字段
    expect(patch.custom?.chat).toBe(true)
    expect('appliedPreset' in patch).toBe(false) // 字段写入不得带 appliedPreset（基准不动）
    for (const zone of zones) {
      if (zone !== 'chat') expect(patch.custom?.[zone]).toBe(state.custom[zone]) // `${zone}: 不污染 custom`
    }
  })

  it('applyZonePreset：写字段 + 记名 + 清 custom', () => {
    const state = makeZoneState()
    const zoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, effectivePresetTheme(nord)[f]])) as Partial<ThemeSettings>
    const patch = applyZonePresetReducer(state, 'chat', 'nord', zoneTheme)
    expect(patch.appliedPreset?.chat).toBe('nord')
    expect(patch.custom?.chat).toBe(false)
    for (const field of ZONE_FIELDS.chat) {
      expect(patch[field]).toEqual(effectivePresetTheme(nord)[field]) // `chat.${String(field)} 应写入预设字段`
    }
    // 无全局预设时不影响 global
    expect(patch.appliedPreset?.global).toBe('')
  })

  it('applyZonePreset（A2）：只写 zone 基准/custom，不手写 global 标记（全局由派生承担）', () => {
    const withGlobal = (name: string) => makeZoneState({ appliedPreset: { ...makeZoneState().appliedPreset, global: name } })
    const glassZoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, effectivePresetTheme(glass)[f]])) as Partial<ThemeSettings>

    const patch = applyZonePresetReducer(withGlobal('nord'), 'chat', 'glass', glassZoneTheme)
    expect(patch.appliedPreset?.chat).toBe('glass')
    expect(patch.appliedPreset?.global).toBe('nord') // applyZonePreset 不手写 global 标记
    expect(patch.custom?.global).toBe(false)
  })

  it('deriveGlobalStatus（A2，覆盖规则 1/2 单一真值）+ deriveZoneStatus', () => {
    const base = makeZoneState()
    expect(deriveGlobalStatus(base)).toBe('') // 全空无触碰 → 无预设
    const allNord = { ...base, appliedPreset: { ...base.appliedPreset, global: 'nord', sidebar: 'nord', chat: 'nord', cc: 'nord', right: 'nord' } }
    expect(deriveGlobalStatus(allNord)).toBe('nord') // 全 5 zone 一致 → 跟随该基准
    expect(deriveGlobalStatus({ ...allNord, appliedPreset: { ...allNord.appliedPreset, cc: '' } })).toBe('custom') // 空 zone 算偏离 → custom
    expect(deriveGlobalStatus({ ...allNord, appliedPreset: { ...allNord.appliedPreset, cc: 'glass' } })).toBe('custom') // zone 基准不一致 → custom
    expect(deriveGlobalStatus({ ...base, custom: { ...base.custom, chat: true } })).toBe('custom') // 任一 zone 触碰 → custom（规则 1）
    expect(deriveGlobalStatus({ ...base, appliedPreset: { ...base.appliedPreset, chat: 'nord' } })).toBe('custom') // 只 apply 单 zone → 全局 custom（规则 2）
    expect(deriveZoneStatus({ ...allNord, custom: { ...allNord.custom, chat: true } }, 'chat')).toEqual({ appliedName: 'nord', isCustom: true })
  })

  it('applyZonePreset cc 同步：ccLayout 恢复规范 + ccHeight clamp', () => {
    const state = makeZoneState()
    const ccTheme = Object.fromEntries(ZONE_FIELDS.cc.map(f => [f, effectivePresetTheme(nord)[f]])) as Partial<ThemeSettings>
    const patch = applyZonePresetReducer(state, 'cc', 'nord', ccTheme)
    expect(patch.ccLayout?.version).toBe(DEFAULT_CC_LAYOUT.version) // cc zone 预设应恢复规范排布
    if (patch.ccHeight !== undefined) {
      expect(typeof patch.ccHeight).toBe('number')
    }
  })

  it('setGlobalPreset：全 zone 记名 + 全 custom 清 + 规范排布', () => {
    const patch = setGlobalPresetReducer('solarized', effectivePresetTheme(solarized))
    for (const zone of zones) {
      expect(patch.appliedPreset?.[zone]).toBe('solarized') // `${zone}: 全局预设应同步名称`
      expect(patch.custom?.[zone]).toBe(false) // `${zone}: 全局预设应清 custom`
    }
    expect(patch.ccLayout?.version).toBe(DEFAULT_CC_LAYOUT.version) // 全局预设应恢复规范排布
  })

  it('saveCustomPreset：命名强制 + 确定性创建/更新；保存存 delta（W2-15 F3-B）', () => {
    const state = makeZoneState()
    expect(() => saveCustomPresetReducer(state, { id: 'custom-1', name: '   ', now: 1000 })).toThrow(/不能为空/) // 空名必须抛错

    const created = saveCustomPresetReducer(state, { id: 'custom-1', name: '我的预设', now: 1000 })
    expect(created.savedId).toBe('custom-1')
    expect(created.patch.customPresets?.length).toBe(1)
    const saved = created.patch.customPresets![0]
    expect(saved.name).toBe('我的预设')
    expect(saved.createdAt).toBe(1000)
    expect(saved.updatedAt).toBe(1000)
    // W2-15（F3-B）：保存存 delta——ccHeight 150 与默认相等被过滤；非默认值必须捕获
    expect((saved.theme as Record<string, unknown>).ccHeight).toBeUndefined() // 默认相等字段不进 delta
    const customState = makeZoneState({ ccHeight: 200 })
    const createdCustom = saveCustomPresetReducer(customState, { id: 'custom-x', name: '带高度', now: 1000 })
    expect((createdCustom.patch.customPresets![0].theme as Record<string, unknown>).ccHeight).toBe(200) // 保存应捕获非默认全主题（含 ccHeight）

    const updated = saveCustomPresetReducer(makeZoneState({ customPresets: created.patch.customPresets }), { id: 'custom-1', name: '改名', now: 2000 })
    expect(updated.patch.customPresets?.length).toBe(1)
    expect(updated.patch.customPresets![0].name).toBe('改名')
    expect(updated.patch.customPresets![0].updatedAt).toBe(2000)
  })

  it('applyCustomPreset：应用字段 + 全 zone 记 id + 找不到返回 null', () => {
    const saved = saveCustomPresetReducer(makeZoneState(), { id: 'custom-9', name: 'P', now: 1000 })
    const state = makeZoneState({ customPresets: saved.patch.customPresets })
    const patch = applyCustomPresetReducer(state, 'custom-9')
    expect(patch).not.toBeNull() // 存在的自定义预设应返回 patch
    for (const zone of zones) expect(patch!.appliedPreset?.[zone]).toBe('custom-9')
    expect(applyCustomPresetReducer(state, 'custom-missing')).toBeNull() // 不存在的预设应返回 null（无操作）
  })

  it('removeCustomPreset：删列表 + 引用 zone 转 custom', () => {
    const saved = saveCustomPresetReducer(makeZoneState(), { id: 'custom-3', name: 'P', now: 1000 })
    const state = makeZoneState({
      customPresets: saved.patch.customPresets,
      appliedPreset: { global: 'custom-3', sidebar: 'custom-3', chat: '', cc: '', right: '' },
      custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
    })
    const patch = removeCustomPresetReducer(state, 'custom-3')
    expect(patch.customPresets).toEqual([]) // 预设应从列表删除
    expect(patch.appliedPreset?.global).toBe('') // 引用该预设的 zone 失去基准
    expect(patch.appliedPreset?.sidebar).toBe('')
    expect(patch.custom?.global).toBe(true) // 失去基准的 zone custom 置 true（自定义快照）
    expect(patch.appliedPreset?.chat).toBe('') // 未引用的 zone 不受影响
    expect(patch.custom?.chat).toBe(false)
  })

  it('业务实体不干扰：patch 只含主题/预设路由键', () => {
    const state = makeZoneState()
    const patch = setZoneFieldReducer(state, 'chat', { chatFontSize: 1 })
    const patchKeys = new Set(Object.keys(patch))
    for (const key of patchKeys) {
      expect(key === 'chatFontSize' || key === 'appliedPreset' || key === 'custom').toBe(true) // `patch 不得含业务键: ${key}`
    }
  })
})
