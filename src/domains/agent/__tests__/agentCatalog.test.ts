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

  it('projects closed adaptation policy and rejects unknown policy names', () => {
    const parsed = parseAgentCatalog(rawCatalog).providers
    expect(parsed.slice(0, 2).every(provider => provider.adaptation?.adapterRelation === null)).toBe(true)
    expect(parsed.slice(0, 2).every(provider => provider.adaptation?.sessionEstablishment.order.join(',') === 'resume,load,new')).toBe(true)
    expect(parsed[2].adaptation?.versionGates).toEqual([
      { id: 'steering-prompt-required', minVersion: '0.65.0', enabled: true, evidence: 'adapter-agent-info-version' },
      { id: 'goal-control-out-of-band', minVersion: null, enabled: false, evidence: 'static-policy' },
      { id: 'cursor-acp-backend', minVersion: null, enabled: false, evidence: 'launch-recipe' },
    ])
    const document = structuredClone(rawCatalog)
    document.providers[0].adaptation = { unsupported: true } as never
    expect(() => parseAgentCatalog(document)).toThrow(/未知字段/)
  })

  it('derives the executable hint from catalog data instead of a provider switch', () => {
    // A4：新增 provider 只需改 catalog，不需改组件。
    const claude = builtinAgentCatalog.executableHint('claude-code')
    expect(claude).toMatch(/ccb/)
    expect(claude).toMatch(/ACP wrapper/)
    expect(claude).toMatch(/Claude Code CLI/)
    expect(claude).toMatch(/配置探测读 \.claude/)
    // 大小写与空白不敏感；未知 provider 落到通用文案。
    expect(builtinAgentCatalog.executableHint('  CLAUDE-CODE ')).toBe(claude)
    const generic = builtinAgentCatalog.executableHint('future-agent')
    expect(generic).not.toMatch(/ccb/)
    expect(generic).toMatch(/绝对路径/)
    expect(builtinAgentCatalog.executableHint(null)).toBe(generic)
    // 每一条 catalog provider 都能给出非空提示。
    for (const provider of builtinAgentCatalog.providers()) {
      expect(builtinAgentCatalog.executableHint(provider).length).toBeGreaterThan(0)
    }
  })

  it('carries a Windows-only launch recipe for every provider', () => {
    expect(parseAgentCatalog(rawCatalog).providers.map(provider => provider.launch)).toEqual([
      { kind: 'path', command: 'peri', args: ['acp'], env: [], cwdPolicy: null },
      { kind: 'path', command: 'hermes', args: ['acp'], env: [], cwdPolicy: null },
      { kind: 'path', command: 'ccb', args: ['--acp'], env: [], cwdPolicy: null },
      // A5①：codex 的 ACP 入口是适配器 codex-acp（无参数）。
      { kind: 'path', command: 'codex-acp', args: [], env: [], cwdPolicy: null },
    ])
  })

  it.each([
    { kind: 'deno', command: 'x' },
    { kind: 'path', command: 'C:\\tools\\agent.exe' },
    { kind: 'path', command: 'agent', args: ['/bin/sh', '-c', 'agent'] },
    { kind: 'path', command: 'sh', args: ['-c', 'agent'] },
    { kind: 'path', command: 'agent', args: ['--signal', 'SIGTERM'] },
    { kind: 'path', command: 'agent', env: [{ name: 'ANTHROPIC_API_KEY', value: 'x' }] },
    { kind: 'path', command: 'agent', shellExpansion: true },
  ])('rejects a launch recipe that is not a plain Windows child %j', invalid => {
    const document = structuredClone(rawCatalog)
    document.providers[0].launch = invalid as never
    expect(() => parseAgentCatalog(document)).toThrow()
  })

  it('rejects an undeclared launch recipe and older schemas', () => {
    const document = structuredClone(rawCatalog)
    document.providers[0].launch = null as never
    expect(() => parseAgentCatalog(document)).toThrow(/launch 未声明/)
    expect(() => parseAgentCatalog({ schemaVersion: 2, providers: [] })).toThrow(/schemaVersion/)
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
    expect(builtinAgentCatalog.providers()).toEqual(['peri', 'hermes', 'claude-code', 'codex'])
    expect(builtinAgentCatalog.descriptors().map(entry => entry.provider)).toEqual(builtinAgentCatalog.providers())
    expect(builtinAgentCatalog.detectors().map(entry => entry.provider)).toEqual(builtinAgentCatalog.providers())
    // codex 目前不声明工具表（无真源可依），因此它可能不出现在 tools() 里；
    // 其余 provider 必须齐全。
    expect(new Set(builtinAgentCatalog.tools().map(entry => entry.provider)))
      .toEqual(new Set(['peri', 'hermes', 'claude-code']))
  })

  it('keeps every detector on an explicit ACP invocation', () => {
    expect(builtinAgentCatalog.detectors()).toEqual([
      { id: 'builtin.detector.peri', provider: 'peri', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.hermes', provider: 'hermes', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.claude-code', provider: 'claude-code', protocol: 'acp', priority: 100 },
      { id: 'builtin.detector.codex', provider: 'codex', protocol: 'acp', priority: 100 },
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
    expect(builtinAgentCatalog.detectors()).toHaveLength(4)
    const minimum = {
      provider: 'fixture', displayName: 'Fixture', protocol: 'acp',
      capabilities: { sessionUpdates: true, interactionEvents: true, permissionRequests: false, replay: true, responseMethods: [] },
      interactionKinds: [], protocolDefaults: { setModelApi: 'config_option' }, tools: [],
      launch: { kind: 'path', command: 'fixture', args: ['acp'] },
      detection: {
        detectorId: 'fixture', priority: 1, invocations: [{ command: 'fixture', args: ['acp'] }], configDirs: ['.fixture'],
        configEvidence: [{ relativePath: 'config.yaml', format: 'yaml', fields: ['provider', 'model'] }],
      },
    }
    expect(() => parseAgentCatalog({ schemaVersion: 3, providers: [minimum] })).not.toThrow()
    expect(() => parseAgentCatalog({ schemaVersion: 3, providers: [{
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
      launch: { kind: 'path', command: 'a', args: ['acp'] },
      detection: { detectorId: 'a', priority: 1, invocations: [{ command: 'a', args: ['acp'] }], configDirs: [] },
      tools: [],
    }
    expect(() => parseAgentCatalog({ schemaVersion: 3, providers: [
      { ...minimum, provider: 'same' },
      { ...minimum, provider: 'same', detection: { ...minimum.detection, detectorId: 'b' } },
    ] })).toThrow(/provider 重复/)
  })
})
