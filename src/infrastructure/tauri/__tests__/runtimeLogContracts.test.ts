/**
 * runtimeLogContracts — RuntimeLogEntry wire 收窄测试（W1-08）。
 *
 * LOG-03（方案书 §5.14 增量字段）：normalize 保留 code/category/recoverable/
 * userActionRequired/rawAvailable + correlation（OBS-02 身份）——UI 可见会话身份，
 * 闭环 OBS-07 P5 correlationDroppedFrontend。宽容收窄：非法值省略不报错。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRuntimeLogEntry } from '../runtimeLogContracts'

function wireEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    timestamp: '1722500000000',
    level: 'info',
    source: 'acp',
    message: 'ok',
    ...overrides,
  }
}

describe('normalizeRuntimeLogEntry（LOG-03 增量字段）', () => {
  it('保留 code/category/recoverable/userActionRequired/rawAvailable（§5.14）', () => {
    const entry = normalizeRuntimeLogEntry(wireEntry({
      code: 'agent_crashed',
      category: 'stderr',
      recoverable: false,
      userActionRequired: true,
      rawAvailable: true,
    }))
    expect(entry).not.toBeNull()
    expect(entry!.code).toBe('agent_crashed')
    expect(entry!.category).toBe('stderr')
    expect(entry!.recoverable).toBe(false)
    expect(entry!.userActionRequired).toBe(true)
    expect(entry!.rawAvailable).toBe(true)
  })

  it('保留 correlation 身份（OBS-02）——OBS-07 correlationDroppedFrontend 闭环', () => {
    const entry = normalizeRuntimeLogEntry(wireEntry({
      correlation: {
        agentId: 'hermes-a',
        provider: 'openai',
        source: 'subprocess',
        localSessionId: 'local-1',
        remoteSessionId: 'remote-1',
        periId: 'peri-1',
        clientGeneration: 5,
        requestId: 'perm-9',
        toolCallId: 'tc-9',
      },
    }))
    expect(entry!.correlation).toEqual({
      agentId: 'hermes-a',
      provider: 'openai',
      source: 'subprocess',
      localSessionId: 'local-1',
      remoteSessionId: 'remote-1',
      periId: 'peri-1',
      clientGeneration: 5,
      requestId: 'perm-9',
      toolCallId: 'tc-9',
    })
  })

  it('增量字段非法/缺失 → 宽容省略，不报错', () => {
    const entry = normalizeRuntimeLogEntry(wireEntry({
      code: 42,
      category: '',
      recoverable: 'yes',
      userActionRequired: null,
      rawAvailable: undefined,
    }))
    expect(entry).not.toBeNull()
    expect(entry!.code).toBeUndefined()
    expect(entry!.category).toBeUndefined()
    expect(entry!.recoverable).toBeUndefined()
    expect(entry!.userActionRequired).toBeUndefined()
    expect(entry!.rawAvailable).toBeUndefined()
  })

  it('correlation 残缺（缺 agentId/source/generation）→ 整体拒绝，不保留残缺身份', () => {
    // OBS-02 纪律：禁止只记录 source 或只记录 sessionId——身份必须完整。
    expect(normalizeRuntimeLogEntry(wireEntry({ correlation: { source: 'subprocess' } }))!.correlation).toBeUndefined()
    expect(normalizeRuntimeLogEntry(wireEntry({ correlation: { agentId: 'a' } }))!.correlation).toBeUndefined()
    expect(normalizeRuntimeLogEntry(wireEntry({ correlation: { agentId: 'a', source: 's', clientGeneration: 'x' } }))!.correlation).toBeUndefined()
  })

  it('CR-201：clientGeneration 强转形态（null/空串/布尔/数组/负数/小数）→ 整体拒绝，不因 Number() 放宽', () => {
    // LOG-03 玉衡审查 CR-201（MINOR）：旧 `Number(value.clientGeneration)` 宽松强转使
    // `Number(null)===0`/`Number('')===0`/`Number(true)===1`/`Number([])===0` 通过"有限
    // 非负"检查，与 AC-3 残缺身份整体拒绝语义有出入。修复后仅接受有限非负整数。
    const corruptedForms: unknown[] = [null, '', true, [], -1, 2.5, '5']
    for (const generation of corruptedForms) {
      expect(
        normalizeRuntimeLogEntry(wireEntry({
          correlation: { agentId: 'a', source: 's', clientGeneration: generation },
        }))!.correlation,
      ).toBeUndefined()
    }
    // 合法有限非负整数（Rust wire `client_generation: u64` 真值）仍保留
    const ok = normalizeRuntimeLogEntry(wireEntry({
      correlation: { agentId: 'a', source: 's', clientGeneration: 3 },
    }))!
    expect(ok.correlation).toMatchObject({ agentId: 'a', source: 's', clientGeneration: 3 })
  })

  it('既有关键行为不回退：level 归一、timestamp 数字/字符串、fields 仅字符串', () => {
    const entry = normalizeRuntimeLogEntry(wireEntry({
      level: 'BOGUS',
      timestamp: 1234,
      fields: { a: 'x', b: 5, c: { nested: true } },
    }))
    expect(entry!.level).toBe('info')
    expect(entry!.timestamp).toBe(1234)
    expect(entry!.fields).toEqual({ a: 'x' })
  })
})
