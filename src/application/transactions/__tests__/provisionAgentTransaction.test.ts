import { describe, expect, it, vi } from 'vitest'
import { provisionAgentTransaction } from '../provisionAgentTransaction.ts'

const candidate = {
  candidateId: 'builtin.detector.peri:fixture',
  agentId: 'peri-local',
  name: 'Peri Local',
  provider: 'peri',
  executable: 'C:\\Agents\\peri.exe',
  args: ['acp'],
}

describe('provisionAgentTransaction', () => {
  it('验证、持久化、刷新并激活后才报告 ready', async () => {
    const calls: string[] = []
    const imported = [{ id: 'peri-local', name: 'Peri Local', exe: candidate.executable }]
    const deps = {
      validate: vi.fn(async () => {
        calls.push('validate')
        return { ok: true, agentId: 'peri-local', durationMs: 8 }
      }),
      persist: vi.fn(async () => { calls.push('persist') }),
      refreshAgents: vi.fn(async () => { calls.push('refresh'); return imported }),
      applyAgents: vi.fn(() => { calls.push('apply') }),
      activate: vi.fn(async () => { calls.push('activate'); return true }),
    }

    const result = await provisionAgentTransaction(candidate, deps)

    expect(result).toEqual({
      kind: 'ready',
      agentId: 'peri-local',
      validation: { ok: true, agentId: 'peri-local', durationMs: 8 },
    })
    expect(calls).toEqual(['validate', 'persist', 'refresh', 'apply', 'activate'])
    expect(deps.applyAgents).toHaveBeenCalledWith(imported)
  })

  it('验证失败时停在 validation-failed，不写配置也不激活', async () => {
    const validation = {
      ok: false as const,
      agentId: 'peri-local',
      durationMs: 12,
      error: { code: 'initialize_failed', message: 'not ACP', action: 'edit-agent-config' },
    }
    const deps = {
      validate: vi.fn(async () => validation),
      persist: vi.fn(async () => undefined),
      refreshAgents: vi.fn(async () => []),
      applyAgents: vi.fn(),
      activate: vi.fn(async () => true),
    }

    await expect(provisionAgentTransaction(candidate, deps)).resolves.toEqual({
      kind: 'validation-failed',
      agentId: 'peri-local',
      validation,
    })
    expect(deps.persist).not.toHaveBeenCalled()
    expect(deps.activate).not.toHaveBeenCalled()
  })

  it('配置已落盘但 runtime 激活失败时如实报告 stored-not-active', async () => {
    const validation = { ok: true as const, agentId: 'peri-local', durationMs: 8 }
    const deps = {
      validate: vi.fn(async () => validation),
      persist: vi.fn(async () => undefined),
      refreshAgents: vi.fn(async () => [{ id: 'peri-local', name: 'Peri Local' }]),
      applyAgents: vi.fn(),
      activate: vi.fn(async () => false),
    }

    await expect(provisionAgentTransaction(candidate, deps)).resolves.toEqual({
      kind: 'stored-not-active',
      agentId: 'peri-local',
      validation,
    })
    expect(deps.applyAgents).toHaveBeenCalledOnce()
  })

  it('入口已经完成验证时复用验证结果，不重复启动候选进程', async () => {
    const validation = { ok: true as const, agentId: 'peri-local', durationMs: 8 }
    const deps = {
      validate: vi.fn(async () => validation),
      persist: vi.fn(async () => undefined),
      refreshAgents: vi.fn(async () => [{ id: 'peri-local', name: 'Peri Local' }]),
      applyAgents: vi.fn(),
      activate: vi.fn(async () => true),
    }

    const result = await provisionAgentTransaction(candidate, deps, { validation })

    expect(result.kind).toBe('ready')
    expect(deps.validate).not.toHaveBeenCalled()
  })

  it('显式接受高置信未验证候选时允许落盘，但仍如实报告激活结果', async () => {
    const validation = {
      ok: false as const, agentId: 'peri-local', durationMs: 8,
      error: { code: 'timeout', message: 'timed out', action: 'retry' },
    }
    const deps = {
      validate: vi.fn(async () => validation),
      persist: vi.fn(async () => undefined),
      refreshAgents: vi.fn(async () => [{ id: 'peri-local', name: 'Peri Local' }]),
      applyAgents: vi.fn(),
      activate: vi.fn(async () => false),
    }

    const result = await provisionAgentTransaction(candidate, deps, { validation, acceptUnverified: true })

    expect(result.kind).toBe('stored-not-active')
    expect(deps.persist).toHaveBeenCalledOnce()
  })

  it('无界面的导入入口可只完成共享持久化事务，不隐式切换 runtime', async () => {
    const validation = { ok: true as const, agentId: 'peri-local', durationMs: 8 }
    const deps = {
      validate: vi.fn(async () => validation),
      persist: vi.fn(async () => undefined),
      refreshAgents: vi.fn(async () => [{ id: 'peri-local', name: 'Peri Local' }]),
      applyAgents: vi.fn(),
      activate: vi.fn(async () => true),
    }

    await expect(provisionAgentTransaction(candidate, deps, { activate: false })).resolves.toEqual({
      kind: 'stored', agentId: 'peri-local', validation,
    })
    expect(deps.activate).not.toHaveBeenCalled()
  })
})
