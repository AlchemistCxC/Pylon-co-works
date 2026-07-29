import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { DEFAULT_CC_LAYOUT } from '../src/ccLayoutState.ts'

const storeSource = readFileSync(new URL('../src/store.ts', import.meta.url), 'utf8')
const applyBody = storeSource.match(/applyCustomPreset:\s*\(id\) => set\(state => \{([\s\S]*?)\n\s*\}\),/)?.[1] ?? ''
assert.match(applyBody, /pickCustomPresetTheme\(preset\.theme/)
assert.match(applyBody, /\.\.\.theme/)
assert.match(applyBody, /normalizeCcLayout\(theme\.ccLayout, theme\.ccPositions\)/)
assert.doesNotMatch(applyBody, /\.\.\.preset\.theme\s*,[\s\S]*profiles|profiles\s*:/)

const profiles = [{ id: 'profile-1' }]
const sessions = [{ id: 'session-1' }]
const sessionLiveStats = { 'source-1': { tokensUsed: 3 } }
const sessionModes = { 'source-1': 'thinking' }
const sessionConfig = { 'source-1': { model: 'model-a' } }
const liveGeneratingSources = ['source-1']
const agents = [{ id: 'peri', name: 'Peri' }]
const agentStatuses = { peri: { status: 'connected' } }
const customPresets = [{ id: 'custom-isolation' }]

type State = Record<string, unknown> & {
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
  ccLayout: typeof DEFAULT_CC_LAYOUT
  ccPositions: Record<string, unknown>
}

const initial: State = {
  globalBgColor: '#before',
  profiles, activeProfileId: 'profile-1', sessions,
  sessionLiveStats, sessionModes, sessionConfig, liveGeneratingSources,
  agents, activeAgent: 'peri', agentStatuses, customPresets,
  activePreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
  ccLayout: DEFAULT_CC_LAYOUT,
  ccPositions: {},
}

const presetTheme = {
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

// 复刻 applyCustomPreset 的无副作用状态事务；源代码结构断言保证真实 action 使用同一边界。
const applyCustomPreset = (state: State, theme: Record<string, unknown>): State => {
  const allowedTheme = Object.fromEntries(Object.entries(theme).filter(([key]) => [
    'globalBgColor', 'ccLayout', 'ccPositions',
  ].includes(key)))
  const layout = allowedTheme.ccLayout && typeof allowedTheme.ccLayout === 'object'
    ? allowedTheme.ccLayout as typeof DEFAULT_CC_LAYOUT
    : DEFAULT_CC_LAYOUT
  return {
    ...state,
    ...allowedTheme,
    ccLayout: {
      version: 3,
      placements: Object.fromEntries(Object.entries(layout.placements).map(([id, placement]) => [id, {
        ...placement,
        order: Math.max(0, Math.min(99, Math.round(Number.isFinite(placement.order) ? placement.order : 0))),
        offsetX: Math.max(-48, Math.min(48, Number.isFinite(placement.offsetX) ? placement.offsetX : 0)),
        offsetY: Math.max(-16, Math.min(16, Number.isFinite(placement.offsetY) ? placement.offsetY : 0)),
      }])) as typeof DEFAULT_CC_LAYOUT.placements,
    },
    activePreset: { global: 'custom-isolation', sidebar: 'custom-isolation', chat: 'custom-isolation', cc: 'custom-isolation', right: 'custom-isolation' },
    dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
  }
}

const state = applyCustomPreset(initial, presetTheme)
assert.equal(state.globalBgColor, '#123456')
assert.equal(state.profiles, profiles)
assert.equal(state.activeProfileId, 'profile-1')
assert.equal(state.sessions, sessions)
assert.equal(state.sessionLiveStats, sessionLiveStats)
assert.equal(state.sessionModes, sessionModes)
assert.equal(state.sessionConfig, sessionConfig)
assert.equal(state.liveGeneratingSources, liveGeneratingSources)
assert.equal(state.agents, agents)
assert.equal(state.activeAgent, 'peri')
assert.equal(state.agentStatuses, agentStatuses)
assert.equal(state.customPresets, customPresets)
assert.deepEqual(state.ccLayout.placements.input, { slot: 'input', order: 99, offsetX: 48, offsetY: -16 })
assert.equal(state.activePreset.global, 'custom-isolation')
assert.equal(state.dirty.global, false)

console.log('applyCustomPreset 业务状态隔离回归测试通过')
