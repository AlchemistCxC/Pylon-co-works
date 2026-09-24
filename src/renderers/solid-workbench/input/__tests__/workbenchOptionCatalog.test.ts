import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODE_OPTIONS,
  DEFAULT_REASONING_OPTIONS,
  resolveDocumentOptionValue,
  resolveModeOptionEntries,
  resolveModelOptionEntries,
  resolveReasoningOptionEntries,
  shortControlCenterError,
  type WorkbenchOptionEntry,
} from '../workbenchOptionCatalog.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../../domains/workbench/workbenchRuntime.ts'
import type { SessionConfigOption } from '../../../../domains/workbench/session/sessionSurface.ts'
import { createWorkbenchDocument } from '../../../../domains/workbench/workbenchProjector.ts'
import { normalizeSessionMode } from '../../../../components/chat/sessionModeState.ts'

function emptySnapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: null, status: 'idle', messages: [], generating: false,
    generationStart: 0, tokenCount: 0, summary: null, tasks: [],
    availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

/** 会话态快照：把 provider 上报的选项装进规范化文档（思考强度的候选只从这里来）。 */
function snapshotWithOptions(options: readonly SessionConfigOption[]): WorkbenchRuntimeSnapshot {
  const document = createWorkbenchDocument('s-reasoning')
  return emptySnapshot({ document: { ...document, session: { ...document.session, options } } })
}

/** provider 只报了当前值、**没有给候选清单** —— `resolveDocumentOptionEntries` 会回落成单元素列表。 */
const ONLY_CURRENT_VALUE: SessionConfigOption[] = [
  { id: 'thought_level', label: '思考强度', value: 'high' },
]

describe('Workbench option catalog', () => {
  it('reads the provider-selected reasoning value from normalized options', () => {
    expect(resolveDocumentOptionValue([
      {
        id: 'thought_level',
        label: '思考强度',
        value: 'high',
        schema: { options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
      },
    ], 'reasoning')).toBe('high')
  })

  it('model candidates come from advertised surfaces only — no hardcoded fallback (issue #53)', () => {
    const entries = resolveModelOptionEntries(emptySnapshot())
    expect(entries).toEqual([])
    expect(entries.map(item => item.id)).not.toContain('deepseek-v4-flash')
    expect(entries.map(item => item.id)).not.toContain('deepseek-v4-pro')
  })

  it('keeps the selected draft visible when nothing is advertised', () => {
    const entries = resolveModelOptionEntries(emptySnapshot(), 'my-default-model')
    expect(entries.map(item => item.id)).toEqual(['my-default-model'])
  })

  it('unions session snapshot and agent-advertised entries with case-insensitive dedupe', () => {
    const agentAdvertised: readonly WorkbenchOptionEntry[] = [
      { id: 'SESSION-MODEL', label: '重名（首个来源胜出）' },
      { id: 'kimi-k2', label: 'Kimi K2' },
    ]
    const entries = resolveModelOptionEntries(
      emptySnapshot({ availableModels: ['session-model'] }),
      undefined,
      agentAdvertised,
    )
    expect(entries.map(item => item.id)).toEqual(['session-model', 'kimi-k2'])
    expect(entries.find(item => item.id === 'kimi-k2')?.label).toBe('Kimi K2')
    expect(entries.find(item => item.id === 'session-model')?.label).toBe('session-model')
  })

  it('ignores agent-advertised entries only when the caller does not pass them', () => {
    const entries = resolveModelOptionEntries(emptySnapshot({ availableModels: ['session-model'] }))
    expect(entries.map(item => item.id)).toEqual(['session-model'])
  })

  // 候选表是「agent 没上报时」的兜底菜单——菜单里出现的 id 必须过得了写入通道的归一化表
  // (sessionModeState.normalizeSessionMode)，否则用户点了必报「无效的会话或权限模式」。
  it('keeps every fallback mode candidate acceptable to the mode write channel', () => {
    const ids = DEFAULT_MODE_OPTIONS.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(normalizeSessionMode(id)).not.toBeNull()
  })

  // 更强的一条：兜底 id 必须**原样**过通道，不得被别名折成另一个 id。
  // 折了就说明上 wire 的值不是菜单里那个值——例如 accept_edits 被折成 accept_edit，
  // 而 agent 不认 accept_edit，会静默降级回 default（用户看到的是「选了等于没选」）。
  it('sends every fallback mode candidate on the wire as itself, never folded by an alias', () => {
    for (const entry of DEFAULT_MODE_OPTIONS) {
      expect(normalizeSessionMode(entry.id)).toBe(entry.id)
    }
  })

  // optionIds 会把当前值插进快照列表（好让 UI 总能显示它），于是"只有当前值"会被误读成
  // "provider 上报过候选"。此时必须回落兜底表：菜单按设计排除当前值，若把单元素集合当权威，
  // 菜单就一项不剩 —— 用户切换档位后再点开就是空盒，且换不回其它档位。
  it('treats a candidate surface holding only the current mode as not advertised', () => {
    const entries = resolveModeOptionEntries(emptySnapshot({ availableModes: ['auto'], activeMode: 'auto' }))
    expect(entries.map(entry => entry.id)).toEqual(DEFAULT_MODE_OPTIONS.map(entry => entry.id))
  })

  it('still prefers a real advertised mode surface over the fallback catalogue', () => {
    const entries = resolveModeOptionEntries(emptySnapshot({
      availableModes: ['default', 'accept_edits'], activeMode: 'accept_edits',
    }))
    expect(entries.map(entry => entry.id)).toEqual(['default', 'accept_edits'])
  })

  it('falls back to the catalogue when there is neither a candidate surface nor a current mode', () => {
    const entries = resolveModeOptionEntries(emptySnapshot({ availableModes: [], activeMode: '' }))
    expect(entries.map(entry => entry.id)).toEqual(DEFAULT_MODE_OPTIONS.map(entry => entry.id))
  })
})

describe('shortControlCenterError (#51)', () => {
  it('maps stable backend codes to brief UI copy instead of the full diagnostic', () => {
    expect(shortControlCenterError(
      'model_not_advertised: requested value "m-9" is not in the agent-advertised choices [m-1, m-2, m-3]',
      '模型切换失败',
    )).toBe('模型未被该会话宣告，无法切换')
    expect(shortControlCenterError(
      'reasoning_not_advertised: requested value "ultra" is not in the agent-advertised choices [low, high]',
      '思考等级切换失败',
    )).toBe('思考等级未被该会话宣告，无法切换')
  })

  it('caps unknown messages and keeps the fallback for empty errors', () => {
    const long = 'x'.repeat(200)
    expect(shortControlCenterError(long, '失败').length).toBe(80)
    expect(shortControlCenterError(undefined, '模型切换失败')).toBe('模型切换失败')
  })
})

describe('思考强度的候选面 —— 与权限 / 模型对称的守卫（#266 CC-12）', () => {
  it('provider 只报了当前值、没给候选清单 ⇒ 用兜底表（否则菜单是空盒）', () => {
    const ids = resolveReasoningOptionEntries(snapshotWithOptions(ONLY_CURRENT_VALUE), 'high').map(entry => entry.id)
    expect(ids).toEqual(DEFAULT_REASONING_OPTIONS.map(entry => entry.id))
    expect(ids).toContain('high')
  })

  it('★ 当前值不在兜底表里时，仍换得回去（这条挡的是"只剩当前值"的老病灶）', () => {
    const unknown: SessionConfigOption[] = [{ id: 'thought_level', label: '思考强度', value: 'ultra-custom' }]
    const ids = resolveReasoningOptionEntries(snapshotWithOptions(unknown), 'ultra-custom').map(entry => entry.id)
    // 未加守卫时这里只会有一项（['ultra-custom']）⇒ 菜单空盒、换不回去；加了守卫 ⇒ 兜底档全体回来。
    expect(ids).toContain('ultra-custom')
    expect(ids).toContain('low')
    expect(ids).toHaveLength(DEFAULT_REASONING_OPTIONS.length + 1)
  })

  it('真候选面（带 choices）⇒ 用它，不回落兜底表', () => {
    const advertised: SessionConfigOption[] = [{
      id: 'thought_level', label: '思考强度', value: 'high',
      schema: { options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
    }]
    expect(resolveReasoningOptionEntries(snapshotWithOptions(advertised), 'high').map(entry => entry.id))
      .toEqual(['low', 'high'])
  })

  it('既没有候选面也没有当前值 ⇒ 兜底表', () => {
    expect(resolveReasoningOptionEntries(emptySnapshot()).map(entry => entry.id))
      .toEqual(DEFAULT_REASONING_OPTIONS.map(entry => entry.id))
  })

  it('★ 形参不传、文档里有值 ⇒ 守卫仍生效（比对基准取文档值，不依赖调用方）', () => {
    // 把基准系在形参上的写法在这一档会静默放行（current 为空 ⇒ advertisedChoices 原样返回）。
    const ids = resolveReasoningOptionEntries(snapshotWithOptions(ONLY_CURRENT_VALUE)).map(entry => entry.id)
    expect(ids).toEqual(DEFAULT_REASONING_OPTIONS.map(entry => entry.id))
  })
})
