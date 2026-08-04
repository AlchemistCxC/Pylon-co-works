import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'
import {
  applyCustomPresetReducer,
  type ThemePresetState,
} from '../src/domains/theme/presetReducer.ts'

// A0：applyCustomPreset 纯计算在 presetReducer，本测试直接调真实 reducer
// （替代旧版"复刻 harness + store 源码断言"），验证业务状态隔离 + ccLayout 归一化。

const reducerSource = readFileSync(new URL('../src/domains/theme/presetReducer.ts', import.meta.url), 'utf8')
assert.match(reducerSource, /pickCustomPresetTheme\(preset\.theme/, 'reducer 必须经白名单捕获预设主题')
assert.match(reducerSource, /normalizeCcLayout\(theme\.ccLayout\)/, 'reducer 必须归一化 ccLayout')
assert.doesNotMatch(reducerSource, /\.\.\.preset\.theme\s*,[\s\S]*profiles|profiles\s*:/, 'reducer 不得直铺预设主题')

function makeState(customPresets: ThemePresetState['customPresets']): ThemePresetState {
  return {
    appliedPreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
    custom: { global: false, sidebar: false, chat: false, cc: false, right: false },
    customPresets,
    ccLayout: DEFAULT_CC_LAYOUT,
    ccHeight: 150,
    ccBgHeight: 150,
    inputMode: 'cli',
    footerLayout: 'free',
    cliHintMode: 'full',
    ccHidden: [],
    ccStyle: 'wave',
    cliOverflowMode: 'fixed-scroll',
    globalBgColor: '#before',
  }
}

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

const patch = applyCustomPresetReducer(makeState([preset]), 'custom-isolation')
assert.ok(patch, '存在的自定义预设应返回 patch')

// 主题字段应用 + 业务键隔离（pickCustomPresetTheme 白名单过滤）
assert.equal(patch.globalBgColor, '#123456')
assert.equal((patch as Record<string, unknown>).profiles, undefined, 'profiles 不得进入 patch')
assert.equal((patch as Record<string, unknown>).sessions, undefined, 'sessions 不得进入 patch')
assert.equal((patch as Record<string, unknown>).sessionModes, undefined, 'sessionModes 不得进入 patch')
assert.equal((patch as Record<string, unknown>).agents, undefined, 'agents 不得进入 patch')
assert.equal((patch as Record<string, unknown>).customPresets, undefined, 'customPresets 不得被预设覆盖')

// ccLayout 归一化（越界排布被 clamp）
assert.equal(patch.ccLayout?.version, DEFAULT_CC_LAYOUT.version)
assert.deepEqual(patch.ccLayout?.placements.input, { slot: 'input', order: 99, offsetX: 48, offsetY: -16 })

// 路由：全 zone 记 id + 全 custom 清
assert.equal(patch.appliedPreset?.global, 'custom-isolation')
assert.equal(patch.appliedPreset?.chat, 'custom-isolation')
assert.equal(patch.custom?.global, false)

// 不存在的预设 → null（无操作）
assert.equal(applyCustomPresetReducer(makeState([preset]), 'custom-missing'), null)

console.log('applyCustomPreset 业务状态隔离回归测试通过（真实 reducer）')
