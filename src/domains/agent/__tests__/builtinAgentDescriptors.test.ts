import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_DESCRIPTORS } from '../builtinAgentDescriptors.ts'

describe('builtin agent descriptors', () => {
  it('covers every verified native ACP provider and excludes RPC-only pi', () => {
    expect(BUILTIN_AGENT_DESCRIPTORS.map(descriptor => descriptor.provider)).toEqual([
      'peri',
      'hermes',
      'claude-code',
    ])
    expect(BUILTIN_AGENT_DESCRIPTORS.every(descriptor => descriptor.protocol === 'acp')).toBe(true)
    expect(BUILTIN_AGENT_DESCRIPTORS.some(descriptor => descriptor.provider === 'pi')).toBe(false)
  })
})
