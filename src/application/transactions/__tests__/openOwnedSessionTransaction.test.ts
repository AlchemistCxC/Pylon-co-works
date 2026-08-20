import { describe, expect, it, vi } from 'vitest'
import { openOwnedSessionTransaction, type OpenOwnedSessionDeps } from '../openOwnedSessionTransaction'
import type { Session } from '../../../identityStore'

/**
 * I01-W4 owner-aware 打开事务测试：owner 解析、切 owner 成功/失败保持原页面、
 * 复查 session 变化（mismatch）、owner 无法确定（blocked，不静默归 active）。
 */
function session(id: string, agentId: string, source: string): Session {
  return { id, agentId, source, name: `s-${id}`, periId: `peri-${id}`, profileId: 'p', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
}

function okResult(): { ok: true; value: string } {
  return { ok: true, value: 'switched' }
}

function deps(overrides: Partial<OpenOwnedSessionDeps> = {}): OpenOwnedSessionDeps {
  const calls: string[] = []
  let sessions: Session[] = [session('s-a', 'agent-a', 'local:x'), session('s-b', 'agent-b', 'local:x')]
  const base: OpenOwnedSessionDeps = {
    getSessions: () => sessions,
    activeAgent: 'agent-a',
    addSession: vi.fn(() => 's-new'),
    updateSession: vi.fn(),
    switchAgent: vi.fn(async () => { calls.push('switch'); return okResult() }),
    selectSession: vi.fn(() => { calls.push('select') }),
    openAgentSheet: vi.fn(() => { calls.push('open') }),
  }
  const combined = { ...base, ...overrides } as OpenOwnedSessionDeps & { _calls: string[]; _setSessions: (s: Session[]) => void }
  combined._calls = calls
  combined._setSessions = (next: Session[]) => { sessions = next }
  return combined
}

describe('openOwnedSessionTransaction', () => {
  it('owner 即 activeAgent 时直接导航（不切 Agent）', async () => {
    const d = deps()
    const result = await openOwnedSessionTransaction({ targetId: 's-a' }, d)
    expect(result.ok).toBe(true)
    expect((d as unknown as { _calls: string[] })._calls).toEqual(['select', 'open'])
  })

  it('owner ≠ activeAgent 时先切 owner 成功再导航', async () => {
    const d = deps()
    const result = await openOwnedSessionTransaction({ targetId: 's-b' }, d)
    expect(result.ok).toBe(true)
    expect((d as unknown as { _calls: string[] })._calls).toEqual(['switch', 'select', 'open'])
  })

  it('切 owner 失败（判别结果非抛异常）→ transport，不 selectSession 不开 sheet（保持原页面）', async () => {
    const d = deps({
      switchAgent: vi.fn(async () => ({ ok: false as const, kind: 'transport' as const, message: 'agent offline' })),
    })
    const result = await openOwnedSessionTransaction({ targetId: 's-b' }, d)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('transport')
      expect(result.message).toContain('agent offline')
    }
    expect((d as unknown as { _calls: string[] })._calls).toEqual([])
  })

  it('复查时 session 已删除 → mismatch，不开 sheet', async () => {
    const d = deps({
      switchAgent: vi.fn(async () => {
        (d as unknown as { _setSessions: (s: Session[]) => void })._setSessions([]) // 切换期间目标被删除
        return okResult()
      }),
    })
    const result = await openOwnedSessionTransaction({ targetId: 's-b' }, d)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('mismatch')
  })

  it('owner 无法确定（存档无归属且无本地行）→ blocked，不静默归 active Agent', async () => {
    const d = deps()
    const result = await openOwnedSessionTransaction({ source: 'local:ghost', periId: 'peri-ghost', title: '旧存档' }, d)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('blocked')
      expect(result.message).toContain('归属不明')
    }
    expect((d as unknown as { _calls: string[] })._calls).toEqual([])
  })

  it('存档 source 与 periId 指向不同 Session → conflict，不静默采用 source owner', async () => {
    const d = deps()
    const result = await openOwnedSessionTransaction(
      { source: 'local:x', periId: 'peri-s-b', title: '冲突存档' },
      d,
    )
    expect(result).toMatchObject({ ok: false, kind: 'conflict' })
    expect((d as unknown as { _calls: string[] })._calls).toEqual([])
  })

  it('存档仅 periId 唯一命中 → 使用该 Session owner 恢复', async () => {
    const d = deps()
    const result = await openOwnedSessionTransaction(
      { source: 'missing', periId: 'peri-s-b', title: '旧存档' },
      d,
    )
    expect(result.ok).toBe(true)
    expect((d as unknown as { _calls: string[] })._calls).toEqual(['switch', 'select', 'open'])
  })

  it('存档条目显式带 owner → 按 owner 恢复并导航', async () => {
    const d = deps({
      addSession: vi.fn(() => {
        (d as unknown as { _setSessions: (s: Session[]) => void })._setSessions([session('s-new', 'agent-b', 'local:x')])
        return 's-new'
      }),
    })
    const result = await openOwnedSessionTransaction(
      { source: 'local:x', periId: 'peri-x', title: '旧', updatedAt: 10, ownerAgentId: 'agent-b' },
      d,
    )
    expect(result.ok).toBe(true)
    // 已切到 agent-b（owner ≠ activeAgent）
    expect((d as unknown as { _calls: string[] })._calls).toContain('switch')
    expect((d as unknown as { _calls: string[] })._calls).toContain('open')
  })
})
