import { describe, expect, it } from 'vitest'
import { buildCapabilityOptions } from '../capabilityOptions.ts'

describe('buildCapabilityOptions', () => {
  it('keeps selected ids that disappeared from the registry as unavailable', () => {
    expect(buildCapabilityOptions('mcp', [{ id: 'filesystem', label: '文件系统', source: 'agent' }], ['filesystem', 'old'])).toEqual([
      { kind: 'mcp', id: 'filesystem', label: '文件系统', source: 'agent', enabled: true, available: true },
      { kind: 'mcp', id: 'old', label: 'old', source: 'persisted', enabled: true, available: false, diagnostic: '当前来源未提供此能力' },
    ])
  })

  it('deduplicates ids and marks registry options enabled from persisted selection', () => {
    const options = buildCapabilityOptions('skill', [{ id: 'review' }, { id: 'review', label: 'duplicate' }], ['review'])
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ id: 'review', enabled: true, available: true })
  })
})

