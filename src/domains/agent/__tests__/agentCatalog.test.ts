import { describe, expect, it } from 'vitest'
import { builtinAgentCatalog, parseAgentCatalog } from '../agentCatalog.ts'

describe('Shared Agent Catalog', () => {
  it('projects one provider baseline into descriptors, detectors and tools', () => {
    expect(builtinAgentCatalog.providers()).toEqual(['peri', 'hermes', 'claude-code'])
    expect(builtinAgentCatalog.descriptors().map(entry => entry.provider)).toEqual(builtinAgentCatalog.providers())
    expect(builtinAgentCatalog.detectors().map(entry => entry.provider)).toEqual(builtinAgentCatalog.providers())
    expect(new Set(builtinAgentCatalog.tools().map(entry => entry.provider))).toEqual(new Set(builtinAgentCatalog.providers()))
  })

  it('keeps every detector on an explicit ACP invocation', () => {
    expect(builtinAgentCatalog.detectors()).toEqual([
      { id: 'builtin.detector.peri', provider: 'peri', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.hermes', provider: 'hermes', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.claude-code', provider: 'claude-code', protocol: 'acp', priority: 100 },
    ])
  })

  it('covers Claude canonical task/goal/MCP/skill/memory tools with aliases and capabilities', () => {
    const claudeTools = new Map(
      builtinAgentCatalog.tools()
        .filter(entry => entry.provider === 'claude-code')
        .map(entry => [entry.name.toLowerCase(), entry]),
    )
    expect(claudeTools.get('agent')).toMatchObject({ aliases: ['Task'], capabilities: expect.arrayContaining(['delegate']) })
    expect(claudeTools.get('todowrite')).toMatchObject({ capabilities: expect.arrayContaining(['plan']) })
    expect(claudeTools.get('goaltool')).toMatchObject({ aliases: ['Goal'], capabilities: expect.arrayContaining(['goal']) })
    expect(claudeTools.get('mcp')).toMatchObject({ capabilities: expect.arrayContaining(['mcp', 'dynamic-schema']) })
    expect(claudeTools.get('skill')).toMatchObject({ aliases: ['SkillTool'], capabilities: expect.arrayContaining(['skill']) })
    expect(claudeTools.get('localmemoryrecall')).toMatchObject({ aliases: ['Memory'], capabilities: expect.arrayContaining(['memory']) })
  })

  it('validates structured config evidence without exposing it as a second detector registry', () => {
    expect(builtinAgentCatalog.detectors()).toHaveLength(3)
    const minimum = {
      provider: 'fixture', displayName: 'Fixture', protocol: 'acp',
      capabilities: { sessionUpdates: true, interactionEvents: true, permissionRequests: false, replay: true, responseMethods: [] },
      interactionKinds: [], protocolDefaults: { setModelApi: 'config_option' }, tools: [],
      detection: {
        detectorId: 'fixture', priority: 1, invocations: [{ command: 'fixture', args: ['acp'] }], configDirs: ['.fixture'],
        configEvidence: [{ relativePath: 'config.yaml', format: 'yaml', fields: ['provider', 'model'] }],
      },
    }
    expect(() => parseAgentCatalog({ schemaVersion: 1, providers: [minimum] })).not.toThrow()
    expect(() => parseAgentCatalog({ schemaVersion: 1, providers: [{
      ...minimum,
      detection: { ...minimum.detection, configEvidence: [{ relativePath: '../secret', format: 'json', fields: ['token'] }] },
    }] })).toThrow(/配置目录内/)
  })

  it('rejects unsupported schema versions and duplicate providers', () => {
    expect(() => parseAgentCatalog({ schemaVersion: 2, providers: [] })).toThrow(/schemaVersion/)
    const minimum = {
      displayName: 'A', protocol: 'acp',
      capabilities: { sessionUpdates: true, interactionEvents: true, permissionRequests: false, replay: true, responseMethods: [] },
      interactionKinds: [], protocolDefaults: { setModelApi: 'config_option' },
      detection: { detectorId: 'a', priority: 1, invocations: [{ command: 'a', args: ['acp'] }], configDirs: [] },
      tools: [],
    }
    expect(() => parseAgentCatalog({ schemaVersion: 1, providers: [
      { ...minimum, provider: 'same' },
      { ...minimum, provider: 'same', detection: { ...minimum.detection, detectorId: 'b' } },
    ] })).toThrow(/provider 重复/)
  })
})
