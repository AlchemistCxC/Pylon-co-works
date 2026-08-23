import { describe, expect, it } from 'vitest'
import { normalizeContentBlock } from '../../normalizers/normalizerSupport.ts'
import { parseContentPart } from '../contentPartSchema.ts'

describe('C15 first-class extension content normalization', () => {
  it('normalizes memory and skill into typed safe metadata instead of unknown', () => {
    const memory = normalizeContentBlock({
      type: 'memory', memoryId: 'mem-1', title: 'Dark mode', source: 'hermes',
      scope: 'session', version: 3, status: 'recalled', enabled: true,
      summary: 'stored preference', apiToken: 'must-not-survive', vendorFuture: 9,
    })
    expect(memory.part).toMatchObject({
      kind: 'memory', memoryId: 'mem-1', title: 'Dark mode', source: 'hermes',
      scope: 'session', version: 3, status: 'recalled', enabled: true,
      raw: expect.objectContaining({ vendorFuture: 9 }),
    })
    expect(JSON.stringify(memory.part)).not.toContain('must-not-survive')

    expect(normalizeContentBlock({
      type: 'skill', skillId: 'skill-1', title: 'Audit', source: 'claude-code',
      status: 'used', used: true, uri: 'skill://audit',
    }).part).toMatchObject({ kind: 'skill', skillId: 'skill-1', used: true })
  })

  it('normalizes MCP resources and recursive artifact previews without inline blobs', () => {
    expect(normalizeContentBlock({
      type: 'mcp_resource', server_name: 'fs-mcp', tool_name: 'ReadMcpResource',
      uri: 'file:///docs/spec.md', mimeType: 'text/markdown', connectionState: 'connected',
    }).part).toMatchObject({
      kind: 'mcp-resource', server: 'fs-mcp', tool: 'ReadMcpResource',
      resourceUri: 'file:///docs/spec.md', connectionState: 'connected',
    })

    const artifact = normalizeContentBlock({
      type: 'artifact', artifactId: 'art-1', title: 'Report', uri: 'artifact://report',
      version: 2, mimeType: 'text/markdown', blob: 'private-binary',
      parts: [{ type: 'text', text: 'preview' }, { type: 'future_block', token: 'secret' }],
    }).part
    expect(artifact).toMatchObject({
      kind: 'artifact', artifactId: 'art-1', hasBlob: true,
      parts: [{ kind: 'text', text: 'preview' }, { kind: 'unknown', originalType: 'future_block' }],
    })
    expect(JSON.stringify(artifact)).not.toContain('private-binary')
    expect(JSON.stringify(artifact)).not.toContain('secret')
  })

  it('rejects cross-family and incomplete typed payloads at the semantic boundary', () => {
    expect(parseContentPart({ kind: 'memory', title: 'missing identity', source: 'hermes' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'skill', skillId: 's', title: 'Skill', source: 'peri', enabled: 'yes' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'mcp-resource', server: 'mcp', resourceUri: '' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'artifact', artifactId: 'a', title: 'A', uri: 'artifact://a', parts: [{ kind: 'text' }] }).ok).toBe(false)
    expect(parseContentPart({ kind: 'memory', memoryId: 'm', title: 'M', source: 'hermes', artifactId: 'cross-family' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'memory', memoryId: 'm', title: 'M', source: 'hermes', status: '' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'mcp-resource', server: 'mcp', resourceUri: 'file:///a', title: '' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'artifact', artifactId: 'a', title: 'A', uri: 'artifact://a', mimeType: '' }).ok).toBe(false)
    expect(parseContentPart({ kind: 'artifact', artifactId: 'a', title: 'A', uri: 'artifact://a', actions: [''] }).ok).toBe(false)

    const malformed = normalizeContentBlock({ type: 'memory', memoryId: 'm', title: 'M', source: 'hermes', enabled: 'yes' })
    expect(malformed.part).toMatchObject({ kind: 'unknown', originalType: 'memory' })
    expect(malformed.diagnostic).toMatchObject({ code: 'content.memory.invalid' })

    const invalidArtifact = normalizeContentBlock({ type: 'artifact', artifactId: 'a', title: 'A', uri: '', blob: 'never-inline' })
    expect(invalidArtifact.part).toMatchObject({ kind: 'unknown', originalType: 'artifact' })
    expect(JSON.stringify(invalidArtifact.part)).not.toContain('never-inline')
  })

  it('never retains malformed inline artifact content in the unknown fallback', () => {
    const malformed = normalizeContentBlock({
      type: 'artifact', artifactId: 'a', title: 'A', uri: 'artifact://a',
      content: 'private-inline-binary',
    })

    expect(malformed.part).toMatchObject({
      kind: 'unknown', originalType: 'artifact', raw: expect.objectContaining({ hasBlob: true }),
    })
    expect(JSON.stringify(malformed.part)).not.toContain('private-inline-binary')
  })

  it('bounds oversized artifact previews before they enter the canonical document', () => {
    const oversized = normalizeContentBlock({
      type: 'artifact', artifactId: 'large', title: 'Large', uri: 'artifact://large',
      parts: Array.from({ length: 257 }, (_, index) => ({ type: 'text', text: `line-${index}` })),
    })

    expect(oversized.part).toMatchObject({ kind: 'unknown', originalType: 'artifact', truncated: true })
    expect(oversized.diagnostic).toMatchObject({ code: 'content.artifact.invalid' })
  })
})
