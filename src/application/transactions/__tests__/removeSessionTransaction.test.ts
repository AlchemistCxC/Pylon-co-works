/**
 * removeSessionTransaction 行为测试（报告阶段 3.2）：
 * close 失败不静默删除、成功后清会话与消息缓存、会话不存在 validation。
 */
import { describe, expect, it, vi } from 'vitest'
import { removeSessionTransaction } from '../removeSessionTransaction'
import type { Session } from '../../../identityStore'

const SESSION: Session = {
  id: 's1', name: '会话一', source: 'local:x', profileId: 'p', createdAt: 0,
  lastActiveAt: 0, platform: 'local', workdir: '', sessionPrompt: '',
  skills: [], hooks: [], autoName: '',
}

function createDeps(overrides: Partial<Parameters<typeof removeSessionTransaction>[1]> = {}) {
  const calls: string[] = []
  const deps = {
    findSession: (id: string) => (id === SESSION.id ? SESSION : undefined),
    closeSession: async (source: string) => { calls.push(`close:${source}`) },
    removeSession: (id: string) => { calls.push(`remove:${id}`) },
    clearMessages: (id: string) => { calls.push(`clear:${id}`) },
    reportError: vi.fn(),
    ...overrides,
  }
  return { deps, calls }
}

describe('removeSessionTransaction', () => {
  it('成功：close → removeSession → clearMessages，返回 ok', async () => {
    const { deps, calls } = createDeps()
    const result = await removeSessionTransaction('s1', deps)
    expect(result).toEqual({ ok: true, value: 's1' })
    expect(calls).toEqual(['close:local:x', 'remove:s1', 'clear:s1'])
  })

  it('close 失败：不删除、不清理，返回 transport 并报告错误', async () => {
    const { deps, calls } = createDeps({
      closeSession: async () => { throw new Error('close failed') },
    })
    const result = await removeSessionTransaction('s1', deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('transport')
    expect(calls).toEqual([])
    expect(deps.reportError).toHaveBeenCalledWith('关闭会话', expect.any(Error))
  })

  it('会话不存在：validation 失败，不调 close', async () => {
    const { deps, calls } = createDeps()
    const result = await removeSessionTransaction('missing', deps)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.kind).toBe('validation')
    expect(calls).toEqual([])
  })
})
