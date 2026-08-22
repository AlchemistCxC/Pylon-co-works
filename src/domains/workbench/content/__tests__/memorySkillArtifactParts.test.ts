import { describe, expect, it } from 'vitest'
import { parseContentPart, createUnknownContentPart } from '../contentPartSchema.ts'

/**
 * C15 RED：memory/skill/MCP-resource/artifact ContentPart 契约（DIC-C15-01）。
 *
 * - 安全 metadata/引用/摘要承载，identity/source/status 结构化；
 * - 未知 subtype 落 UnknownPart（generic fallback 可见）；
 * - 插件卸载后 normalized snapshot 仍可重放（不依赖 renderer definition）。
 */

describe('C15 memory/skill/mcp/artifact content parts', () => {
  it('validates a memory part with identity, source, and status', () => {
    const part = {
      kind: 'memory',
      memoryId: 'mem-1', source: 'hermes', scope: 'session',
      title: 'User prefers dark mode', summary: 'stored preference',
      status: 'recalled', version: 3,
    }
    expect(parseContentPart(part).ok).toBe(true)
  })

  it('validates an mcp-resource part with server/tool/resource identity', () => {
    const part = {
      kind: 'mcp-resource',
      server: 'fs-mcp', resourceUri: 'file:///docs/spec.md',
      mimeType: 'text/markdown', connectionState: 'connected',
    }
    expect(parseContentPart(part).ok).toBe(true)
  })

  it('validates an artifact part with uri and version metadata', () => {
    const part = {
      kind: 'artifact',
      artifactId: 'art-1', title: 'report.pdf', uri: 'https://example.com/report.pdf',
      version: 2, hasBlob: true,
    }
    expect(parseContentPart(part).ok).toBe(true)
  })

  it('falls back to unknown for unrecognized attachment subtypes while keeping the raw visible', () => {
    const unknown = createUnknownContentPart('mystery-attachment', { blob: 'x' })
    expect(unknown.kind).toBe('unknown')
    expect(unknown.summary).toContain('mystery-attachment')
  })
})
