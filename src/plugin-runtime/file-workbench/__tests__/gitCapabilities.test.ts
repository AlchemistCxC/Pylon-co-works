import { describe, expect, it, vi } from 'vitest'
import type { GitProvider } from '../fileWorkbenchTypes.ts'
import { resolveGitCapabilities } from '../gitCapabilities.ts'
import { builtinGitProvider } from '../../../plugins/core/file/builtinFileWorkbench'

function provider(overrides: Partial<GitProvider> = {}): GitProvider {
  return {
    id: 'test.git',
    canHandle: () => true,
    status: vi.fn(),
    history: vi.fn(),
    diff: vi.fn(),
    ...overrides,
  }
}

describe('resolveGitCapabilities（0-C4 契约：未实现方法 → UI 隐藏入口）', () => {
  it('最小 provider（无任何可选方法）→ 全 false', () => {
    const caps = resolveGitCapabilities(provider())
    expect(caps.graph).toBe(false)
    expect(caps.showFile).toBe(false)
    expect(caps.blame).toBe(false)
    expect(caps.sequenceState).toBe(false)
    expect(caps.stash).toBe(false)
    expect(caps.historyOps).toBe(false)
    expect(caps.conflictFlow).toBe(false)
  })

  it('实现部分方法 → 对应能力 true，其余保持 false', () => {
    const caps = resolveGitCapabilities(provider({
      logGraph: vi.fn(),
      stage: vi.fn(),
      reset: vi.fn(),
    }))
    expect(caps.graph).toBe(true)
    expect(caps.historyOps).toBe(true)
    expect(caps.stash).toBe(false)
    expect(caps.conflictFlow).toBe(false)
  })

  it('null provider → 全 false（不抛）', () => {
    const caps = resolveGitCapabilities(null)
    expect(caps.graph).toBe(false)
    expect(caps.showFile).toBe(false)
  })

  it('内置 provider：showFile/sequenceState 已实现，图/写操作尚未实现', () => {
    const caps = resolveGitCapabilities(builtinGitProvider)
    expect(caps.showFile).toBe(true)
    expect(caps.sequenceState).toBe(true)
    expect(caps.graph).toBe(false)
    expect(caps.historyOps).toBe(false)
  })
})
