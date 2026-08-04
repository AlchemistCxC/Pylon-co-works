import { strict as assert } from 'node:assert'
import { GLOBAL_PRESETS, ZONE_FIELDS } from '../src/presets.ts'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'
import {
  applyCustomPresetReducer,
  applyZonePresetReducer,
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
    activePreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
    dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
    customPresets: [],
    ccLayout: DEFAULT_CC_LAYOUT,
    ccHeight: 150,
    ccBgHeight: 150,
    inputMode: 'cli',
    footerLayout: 'free',
    cliHintMode: 'full',
    ccHidden: [],
    ccStyle: 'wave',
    cliOverflowMode: 'fixed-scroll',
    ...overrides,
  }
}

// ── setZoneField：写入字段 + 标记 zone custom/dirty，不污染其他 zone ──
{
  const state = makeState()
  const patch = setZoneFieldReducer(state, 'chat', { chatFontSize: 99 })
  assert.equal(patch.chatFontSize, 99, 'setZoneField 应写入字段')
  assert.equal(patch.activePreset?.chat, 'custom')
  assert.equal(patch.dirty?.chat, true)
  for (const zone of zones) {
    if (zone === 'chat') continue
    assert.equal(patch.activePreset?.[zone], state.activePreset[zone], `${zone}: 不污染 activePreset`)
    assert.equal(patch.dirty?.[zone], state.dirty[zone], `${zone}: 不污染 dirty`)
  }
}

// ── applyZonePreset：写字段 + 记名 + 清 dirty ──
{
  const state = makeState()
  const zoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, nord.theme[f]]))
  const patch = applyZonePresetReducer(state, 'chat', 'nord', zoneTheme)
  assert.equal(patch.activePreset?.chat, 'nord')
  assert.equal(patch.dirty?.chat, false)
  for (const field of ZONE_FIELDS.chat) {
    assert.deepEqual(patch[field], nord.theme[field], `chat.${String(field)} 应写入预设字段`)
  }
  // 无全局预设时不影响 global
  assert.equal(patch.activePreset?.global, '')
}

// ── applyZonePreset + breaksGlobal：切离全局 → global custom+dirty；同源不破 ──
{
  const withGlobal = (name: string) => makeState({ activePreset: { ...makeState().activePreset, global: name } })
  const nordZoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, nord.theme[f]]))
  const glassZoneTheme = Object.fromEntries(ZONE_FIELDS.chat.map(f => [f, glass.theme[f]]))

  const breaking = applyZonePresetReducer(withGlobal('nord'), 'chat', 'glass', glassZoneTheme)
  assert.equal(breaking.activePreset?.global, 'custom', 'zone 预设切离全局 → global 标 custom')
  assert.equal(breaking.dirty?.global, true, 'global dirty 置 true')

  const sameName = applyZonePresetReducer(withGlobal('nord'), 'chat', 'nord', nordZoneTheme)
  assert.equal(sameName.activePreset?.global, 'nord', 'zone 预设与全局同源 → 不破 global')
  assert.equal(sameName.dirty?.global, false)
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

// ── setGlobalPreset：全 zone 记名 + 全 dirty 清 + 规范排布 ──
{
  const state = makeState()
  const patch = setGlobalPresetReducer('solarized', solarized.theme)
  for (const zone of zones) {
    assert.equal(patch.activePreset?.[zone], 'solarized', `${zone}: 全局预设应同步名称`)
    assert.equal(patch.dirty?.[zone], false, `${zone}: 全局预设应清 dirty`)
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
  assert.equal((saved.theme as Record<string, unknown>).ccHeight, 150, '保存应捕获当前全主题（含 ccHeight）')

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
  for (const zone of zones) assert.equal(patch!.activePreset?.[zone], 'custom-9')
  assert.equal(applyCustomPresetReducer(state, 'custom-missing'), null, '不存在的预设应返回 null（无操作）')
}

// ── removeCustomPreset：删列表 + 引用 zone 转 custom ──
{
  const saved = saveCustomPresetReducer(makeState(), { id: 'custom-3', name: 'P', now: 1000 })
  const state = makeState({
    customPresets: saved.patch.customPresets,
    activePreset: { global: 'custom-3', sidebar: 'custom-3', chat: '', cc: '', right: '' },
    dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
  })
  const patch = removeCustomPresetReducer(state, 'custom-3')
  assert.deepEqual(patch.customPresets, [], '预设应从列表删除')
  assert.equal(patch.activePreset?.global, 'custom', '引用该预设的 zone 应转 custom')
  assert.equal(patch.activePreset?.sidebar, 'custom')
  assert.equal(patch.dirty?.global, true, '转 custom 的 zone dirty 置 true')
  assert.equal(patch.activePreset?.chat, '', '未引用的 zone 不受影响')
}

// ── 业务实体不干扰：patch 只含主题/预设路由键 ──
{
  const state = makeState()
  const patch = setZoneFieldReducer(state, 'chat', { chatFontSize: 1 })
  const patchKeys = new Set(Object.keys(patch))
  for (const key of patchKeys) {
    assert.ok(key === 'chatFontSize' || key === 'activePreset' || key === 'dirty', `patch 不得含业务键: ${key}`)
  }
}

console.log('预设路由纯 reducer 行为回归测试通过（5 zones，确定性）')
