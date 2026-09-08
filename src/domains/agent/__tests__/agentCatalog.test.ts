import { describe, expect, it } from 'vitest'
import { builtinAgentCatalog, parseAgentCatalog } from '../agentCatalog.ts'
import rawCatalog from '../../../../shared/agent-catalog.json' with { type: 'json' }
import detectionFixture from '../../../../shared/agent-catalog-detection.fixture.json' with { type: 'json' }

describe('Shared Agent Catalog', () => {
  it('parses structured v2 detection fields without changing their values', () => {
    const document = structuredClone(rawCatalog)
    Object.assign(document.providers[0].detection, detectionFixture)
    expect(parseAgentCatalog(document).providers[0].detection).toMatchObject(detectionFixture)
  })

  it('defaults missing v2 detection extensions to an empty policy', () => {
    const document = structuredClone(rawCatalog)
    const detection = document.providers[0].detection as Record<string, unknown>
    for (const key of Object.keys(detectionFixture)) delete detection[key]
    expect(parseAgentCatalog(document).providers[0].detection).toMatchObject({ versionArgs: [], packageManager: null, requires: { node: null, uv: null }, checks: [] })
  })

  it('defaults adaptation to null and rejects unknown policy names', () => {
    const parsed = parseAgentCatalog(rawCatalog).providers
    expect(parsed.slice(0, 2).every(provider => provider.adaptation === null)).toBe(true)
    expect(parsed[2].adaptation).toMatchObject({ versionGates: { steeringPromptRequiredMinVersion: '0.65.0' } })
    const document = structuredClone(rawCatalog)
    document.providers[0].adaptation = { unsupported: true } as never
    expect(() => parseAgentCatalog(document)).toThrow(/未知字段/)
  })

  it.each([
    { packageManager: 'npx' }, { requires: [] }, { checks: ['node-min'] },
    { packageManager: { kind: 'npm' } }, { requires: { python: '3' } },
    { checks: [{ ...detectionFixture.checks[0], kind: 'shell' }] },
    { checks: [{ ...detectionFixture.checks[0], fix: { kind: 'execute', payload: 'command' } }] },
  ])('rejects invalid detection policy %j', invalid => {
    const document = structuredClone(rawCatalog)
    Object.assign(document.providers[0].detection, invalid)
    expect(() => parseAgentCatalog(document)).toThrow()
  })
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

  it('manual executable selection reuses catalog provider and ACP arguments', () => {
    expect(builtinAgentCatalog.matchExecutable('C:\\Agents\\peri.exe')).toEqual({
      provider: 'peri', displayName: 'Peri', args: ['acp'],
    })
    expect(builtinAgentCatalog.matchExecutable('C:\\Users\\me\\bin\\hermes-acp.cmd')).toEqual({
      provider: 'hermes', displayName: 'Hermes', args: [],
    })
    expect(builtinAgentCatalog.matchExecutable('C:\\Agents\\unknown.exe')).toBeNull()
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
    expect(() => parseAgentCatalog({ schemaVersion: 2, providers: [minimum] })).not.toThrow()
    expect(() => parseAgentCatalog({ schemaVersion: 2, providers: [{
      ...minimum,
      detection: { ...minimum.detection, configEvidence: [{ relativePath: '../secret', format: 'json', fields: ['token'] }] },
    }] })).toThrow(/配置目录内/)
  })

  it('rejects unsupported schema versions and duplicate providers', () => {
    expect(() => parseAgentCatalog({ schemaVersion: 1, providers: [] })).toThrow(/schemaVersion/)
    const minimum = {
      displayName: 'A', protocol: 'acp',
      capabilities: { sessionUpdates: true, interactionEvents: true, permissionRequests: false, replay: true, responseMethods: [] },
      interactionKinds: [], protocolDefaults: { setModelApi: 'config_option' },
      detection: { detectorId: 'a', priority: 1, invocations: [{ command: 'a', args: ['acp'] }], configDirs: [] },
      tools: [],
    }
    expect(() => parseAgentCatalog({ schemaVersion: 2, providers: [
      { ...minimum, provider: 'same' },
      { ...minimum, provider: 'same', detection: { ...minimum.detection, detectorId: 'b' } },
    ] })).toThrow(/provider 重复/)
  })
})
