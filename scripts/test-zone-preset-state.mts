/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { GLOBAL_PRESETS, ZONE_FIELDS } from '../src/presets.ts'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'
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
} from '../src/domains/theme/presetReducer.ts'

// A0：预设路由逻辑已抽为纯 reducer（domains/theme/presetReducer.ts），本测试直接 import
// 做行为断言（替代旧版源码正则断言）。确定性：save 的 id/now 由调用方注入。

const zones = ['global', 'sidebar', 'chat', 'cc', 'right'] as const
const nord = GLOBAL_PRESETS.find(p => p.name === 'nord')!
const glass = GLOBAL_PRESETS.find(p => p.name === 'glass')!
const solarized = GLOBAL_PRESETS.find(p => p.name === 'solarized')!

function makeState(overrides: Partial<ThemePresetState> = {}): ThemePresetState {
  return {
    appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
    custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
    customPresets: [],
    ccLayout: DEFAULT_CC_LAYOUT,
    ccHeight: 150,
    ccBgHeight: 150,
    inputMode: 'cli',
    inputVariant: 'cli',
    inputSubmitButtonMode: 'inline',
    footerLayout: 'free',
    cliHintMode: 'full',
    ccHidden: [],
    ccStyle: 'wave',
    cliOverflowMode: 'fixed-scroll',
    ...overrides,
  }
}

// ── D1 校验漏斗：ccHeight clamp + ccBgHeight 跟随 + inputVariant↔inputMode 联动 ──
{
  const state = makeState()
  // ccHeight 低于最小高（64 base）→ clamp 上调，ccBgHeight 跟随
  const lowPatch = setZoneFieldReducer(state, 'cc', { ccHeight: 5 })
  assert.equal(typeof lowPatch.ccHeight, 'number')
  assert.ok((lowPatch.ccHeight as number) >= 64, 'ccHeight 必须 clamp 到最小高')
  assert.ok((lowPatch.ccBgHeight as number) >= (lowPatch.ccHeight as number), 'ccBgHeight 必须 ≥ ccHeight')
  // inputVariant → inputMode 联动
  const variantPatch = setZoneFieldReducer(state, 'cc', { inputVariant: 'composer' })
  assert.equal(variantPatch.inputMode, 'default', 'inputVariant=composer → inputMode=default')
  assert.equal(variantPatch.inputVariant, 'composer')
  // inputMode → inputVariant 联动（cli ⟺ cli）
  const modePatch = setZoneFieldReducer(makeState({ inputVariant: 'composer' }), 'cc', { inputMode: 'cli' })
  assert.equal(modePatch.inputVariant, 'cli', 'inputMode=cli → inputVariant=cli')
}

// ── setZoneField：写入字段 + 标 zone custom，不污染其他 zone、不带 appliedPreset（基准不动）──
{
  const state = makeState()
  const patch = setZoneFieldReducer(state, 'chat', { chatFontSize: 99 })
  assert.equal(patch.chatFontSize, 99, 'setZoneField 应写入字段')
  assert.equal(patch.custom?.chat, true)
  assert.equal('appliedPreset' in patch, false, '字段写入不得带 appliedPreset（基准不动）')
  for (const zone of zones) {
    if (zone !== 'chat') assert.equal(patch.custom?.[zone], state.custom[zone], `${zone}: 不污染 custom`)
  }
}

// ── applyZonePreset：写字段 + 记名 + 清 custom ──
{
  const state = makeState()
  const zoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, nord.theme[f]]))
  const patch = applyZonePresetReducer(state, 'chat', 'nord', zoneTheme)
  assert.equal(patch.appliedPreset?.chat, 'nord')
  assert.equal(patch.custom?.chat, false)
  for (const field of ZONE_FIELDS.chat) {
    assert.deepEqual(patch[field], nord.theme[field], `chat.${String(field)} 应写入预设字段`)
  }
  // 无全局预设时不影响 global
  assert.equal(patch.appliedPreset?.global, '')
}

// ── applyZonePreset（A2）：只写 zone 基准/custom，不手写 global 标记（全局由派生承担）──
{
  const withGlobal = (name: string) => makeState({ appliedPreset: { ...makeState().appliedPreset, global: name } })
  const glassZoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, glass.theme[f]]))

  const patch = applyZonePresetReducer(withGlobal('nord'), 'chat', 'glass', glassZoneTheme)
  assert.equal(patch.appliedPreset?.chat, 'glass')
  assert.equal(patch.appliedPreset?.global, 'nord', 'applyZonePreset 不手写 global 标记')
  assert.equal(patch.custom?.global, false)
}

// ── deriveGlobalStatus（A2，覆盖规则 1/2 单一真值）──
{
  const base = makeState()
  assert.equal(deriveGlobalStatus(base), '', '全空无触碰 → 无预设')
  const allNord = { ...base, appliedPreset: { ...base.appliedPreset, global: 'nord', sidebar: 'nord', chat: 'nord', cc: 'nord', right: 'nord' } }
  assert.equal(deriveGlobalStatus(allNord), 'nord', '全 5 zone 一致 → 跟随该基准')
  assert.equal(deriveGlobalStatus({ ...allNord, appliedPreset: { ...allNord.appliedPreset, cc: '' } }), 'custom', '空 zone 算偏离 → custom')
  assert.equal(deriveGlobalStatus({ ...allNord, appliedPreset: { ...allNord.appliedPreset, cc: 'glass' } }), 'custom', 'zone 基准不一致 → custom')
  assert.equal(deriveGlobalStatus({ ...base, custom: { ...base.custom, chat: true } }), 'custom', '任一 zone 触碰 → custom（规则 1）')
  assert.equal(deriveGlobalStatus({ ...base, appliedPreset: { ...base.appliedPreset, chat: 'nord' } }), 'custom', '只 apply 单 zone → 全局 custom（规则 2）')
  assert.deepEqual(deriveZoneStatus({ ...allNord, custom: { ...allNord.custom, chat: true } }, 'chat'), { appliedName: 'nord', isCustom: true })
}

// ── applyZonePreset cc 同步：ccLayout 恢复规范 + ccHeight clamp 且 ccBgHeight 跟随 ──
{
  const state = makeState()
  const ccTheme = Object.fromEntries(ZONE_FIELDS.cc.map(f => [f, nord.theme[f]])) as Partial<ThemePresetState['ccLayout'] & Record<string, unknown>>
  const patch = applyZonePresetReducer(state, 'cc', 'nord', ccTheme)
  assert.equal(patch.ccLayout?.version, DEFAULT_CC_LAYOUT.version, 'cc zone 预设应恢复规范排布')
  if (patch.ccHeight !== undefined) {
    assert.equal(typeof patch.ccHeight, 'number')
    assert.ok((patch.ccBgHeight ?? 0) >= patch.ccHeight, 'ccBgHeight 必须 ≥ ccHeight（背景不短于容器）')
  }
}

// ── setGlobalPreset：全 zone 记名 + 全 custom 清 + 规范排布 ──
{
  const state = makeState()
  const patch = setGlobalPresetReducer('solarized', solarized.theme)
  for (const zone of zones) {
    assert.equal(patch.appliedPreset?.[zone], 'solarized', `${zone}: 全局预设应同步名称`)
    assert.equal(patch.custom?.[zone], false, `${zone}: 全局预设应清 custom`)
  }
  assert.equal(patch.ccLayout?.version, DEFAULT_CC_LAYOUT.version, '全局预设应恢复规范排布')
}

// ── saveCustomPreset：命名强制 + 确定性创建/更新 ──
{
  const state = makeState()
  assert.throws(() => saveCustomPresetReducer(state, { id: 'custom-1', name: '   ', now: 1000 }), /不能为空/, '空名必须抛错')

  const created = saveCustomPresetReducer(state, { id: 'custom-1', name: '我的预设', now: 1000 })
  assert.equal(created.savedId, 'custom-1')
  assert.equal(created.patch.customPresets?.length, 1)
  const saved = created.patch.customPresets![0]
  assert.equal(saved.name, '我的预设')
  assert.equal(saved.createdAt, 1000)
  assert.equal(saved.updatedAt, 1000)
  // W2-15（F3-B）：保存存 delta——ccHeight 150 与默认相等被过滤；非默认值必须捕获
  assert.equal((saved.theme as Record<string, unknown>).ccHeight, undefined, '默认相等字段不进 delta')
  const customState = makeState({ ccHeight: 200, ccBgHeight: 200 })
  const createdCustom = saveCustomPresetReducer(customState, { id: 'custom-x', name: '带高度', now: 1000 })
  assert.equal((createdCustom.patch.customPresets![0].theme as Record<string, unknown>).ccHeight, 200, '保存应捕获非默认全主题（含 ccHeight）')

  const updated = saveCustomPresetReducer(makeState({ customPresets: created.patch.customPresets }), { id: 'custom-1', name: '改名', now: 2000 })
  assert.equal(updated.patch.customPresets?.length, 1)
  assert.equal(updated.patch.customPresets![0].name, '改名')
  assert.equal(updated.patch.customPresets![0].updatedAt, 2000)
}

// ── applyCustomPreset：应用字段 + 全 zone 记 id + 找不到返回 null ──
{
  const saved = saveCustomPresetReducer(makeState(), { id: 'custom-9', name: 'P', now: 1000 })
  const state = makeState({ customPresets: saved.patch.customPresets })
  const patch = applyCustomPresetReducer(state, 'custom-9')
  assert.ok(patch, '存在的自定义预设应返回 patch')
  for (const zone of zones) assert.equal(patch!.appliedPreset?.[zone], 'custom-9')
  assert.equal(applyCustomPresetReducer(state, 'custom-missing'), null, '不存在的预设应返回 null（无操作）')
}

// ── removeCustomPreset：删列表 + 引用 zone 转 custom ──
{
  const saved = saveCustomPresetReducer(makeState(), { id: 'custom-3', name: 'P', now: 1000 })
  const state = makeState({
    customPresets: saved.patch.customPresets,
    appliedPreset: { global: 'custom-3', sidebar: 'custom-3', chat: '', cc: '', right: '' },
    custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
  })
  const patch = removeCustomPresetReducer(state, 'custom-3')
  assert.deepEqual(patch.customPresets, [], '预设应从列表删除')
  assert.equal(patch.appliedPreset?.global, '', '引用该预设的 zone 失去基准')
  assert.equal(patch.appliedPreset?.sidebar, '')
  assert.equal(patch.custom?.global, true, '失去基准的 zone custom 置 true（自定义快照）')
  assert.equal(patch.appliedPreset?.chat, '', '未引用的 zone 不受影响')
  assert.equal(patch.custom?.chat, false)
}

// ── 业务实体不干扰：patch 只含主题/预设路由键 ──
{
  const state = makeState()
  const patch = setZoneFieldReducer(state, 'chat', { chatFontSize: 1 })
  const patchKeys = new Set(Object.keys(patch))
  for (const key of patchKeys) {
    assert.ok(key === 'chatFontSize' || key === 'appliedPreset' || key === 'custom', `patch 不得含业务键: ${key}`)
  }
}

console.log('预设路由纯 reducer 行为回归测试通过（5 zones，确定性）')

// ── MEDIUM 5：UI 层 chips sync 必须满足同一联动不变量（cli→cli / default→composer）──
{
  const ccDefs = readFileSync(new URL('../src/domains/cc/widgetDefinitions.ts', import.meta.url), 'utf8')
  assert.match(ccDefs, /value: 'cli', label: '命令行', sync: \{ key: 'inputVariant', value: 'cli' \}/, '命令行 chip 必须同步 inputVariant=cli')
  assert.match(ccDefs, /value: 'default', label: '标准输入', sync: \{ key: 'inputVariant', value: 'composer' \}/, '标准输入 chip 必须同步 inputVariant=composer')
}
