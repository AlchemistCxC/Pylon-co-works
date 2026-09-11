import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_DESCRIPTORS } from '../builtinAgentDescriptors.ts'

describe('builtin agent descriptors', () => {
  it('covers every verified native ACP provider and excludes RPC-only pi', () => {
    // A5①：catalog 新增 codex，描述符列表随之扩展（仍为精确断言）。
    expect(BUILTIN_AGENT_DESCRIPTORS.map(descriptor => descriptor.provider)).toEqual([
      'peri',
      'hermes',
      'claude-code',
      'codex',
    ])
    expect(BUILTIN_AGENT_DESCRIPTORS.every(descriptor => descriptor.protocol === 'acp')).toBe(true)
    expect(BUILTIN_AGENT_DESCRIPTORS.some(descriptor => descriptor.provider === 'pi')).toBe(false)
  })
})
