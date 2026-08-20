import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildToolRenderModel,
  getToolSummary,
  resolveConnectorColor,
  resolveToolKind,
  resolveToolRenderer,
  resolveToolType,
} from '../toolPresentation'
import { clearToolRegistryForTests, registerToolRegistryEntry } from '../toolRegistry'

beforeEach(() => clearToolRegistryForTests())
afterEach(() => clearToolRegistryForTests())

describe('Peri/Hermes 工具类型字典', () => {
  it.each([
    ['Read', 'read', 'read', 'peri'],
    ['Write', 'edit', 'write', 'peri'],
    ['Edit', 'edit', 'edit', 'peri'],
    ['Bash', 'execute', 'execute', 'peri'],
    ['Grep', 'search', 'search', 'peri'],
    ['Glob', 'search', 'search', 'peri'],
    ['WebFetch', 'fetch', 'fetch', 'peri'],
    ['read_file', 'read', 'read', 'hermes'],
    ['write_file', 'edit', 'write', 'hermes'],
    ['patch', 'edit', 'edit', 'hermes'],
    ['search_files', 'search', 'search', 'hermes'],
    ['terminal', 'execute', 'execute', 'hermes'],
    ['execute_code', 'execute', 'execute', 'hermes'],
    ['delegate_task', 'execute', 'delegate', 'hermes'],
  ])('归一化 %s → kind=%s action=%s provider=%s', (name, kind, action, provider) => {
    expect(resolveToolType(name)).toMatchObject({ kind, action, provider, matchedBy: 'provider-dictionary' })
  })

  it('wire kind 优先于工具名字典', () => {
    expect(resolveToolType('terminal', 'read')).toMatchObject({
      kind: 'read',
      action: 'read',
      matchedBy: 'wire',
    })
  })

  it('支持 MCP 工具名按 action 归一', () => {
    expect(resolveToolType('mcp__filesystem__read_file')).toMatchObject({
      kind: 'read',
      action: 'read',
      provider: 'mcp',
      matchedBy: 'provider-dictionary',
    })
    expect(resolveToolType('mcp__playwright__browser_navigate')).toMatchObject({
      kind: 'fetch',
      action: 'navigate',
      provider: 'mcp',
    })
  })

  it('未知工具回退 other，并保留证据', () => {
    expect(resolveToolType('vendor__magic_action')).toMatchObject({
      kind: 'other',
      action: 'unknown',
      matchedBy: 'fallback',
      rawName: 'vendor__magic_action',
    })
  })

  it('旧 resolveToolKind API 与新字典保持兼容', () => {
    expect(resolveToolKind('read_file')).toBe('read')
    expect(resolveToolKind('terminal')).toBe('execute')
    expect(resolveToolKind('Read', 'execute')).toBe('execute')
  })

  it('ToolRenderModel 携带统一 action 与解析证据', () => {
    const model = buildToolRenderModel({ name: 'Bash', input: { command: 'npm test' } })
    expect(model).toMatchObject({
      kind: 'execute',
      action: 'execute',
      resolution: {
        provider: 'peri',
        matchedBy: 'provider-dictionary',
      },
    })
  })

  it('工具级 displayName/summaryFields/outputLabel 覆盖 kind 默认渲染器', () => {
    registerToolRegistryEntry({
      provider: 'hermes',
      name: 'read_file',
      displayName: 'Read',
      kind: 'read',
      action: 'read',
      summaryFields: ['path'],
      outputLabel: 'matches',
    })
    const model = buildToolRenderModel({
      name: 'read_file',
      provider: 'hermes',
      input: { path: '/a.txt' },
      output: 'x\n',
    })
    expect(model).toMatchObject({
      name: 'Read',
      summary: '/a.txt',
      outputLabel: '1 matches',
    })
  })

  it('provider 上下文优先 provider-scoped registry，同名 Tool 不串', () => {
    registerToolRegistryEntry({ provider: 'custom', name: 'read_file', kind: 'edit', action: 'edit' })
    expect(resolveToolType('read_file', undefined, { provider: 'custom' })).toMatchObject({
      kind: 'edit', action: 'edit', provider: 'custom', matchedBy: 'provider-dictionary',
    })
    expect(resolveToolType('read_file', undefined, { provider: 'mcp' })).toMatchObject({
      kind: 'read', provider: 'mcp', matchedBy: 'provider-dictionary',
    })
    expect(resolveToolType('read_file', undefined, { provider: 'hermes' })).toMatchObject({
      kind: 'read', provider: 'hermes', matchedBy: 'provider-dictionary',
    })
  })

  it('provider 上下文下 wire kind 仍最高优先，provider 取上下文', () => {
    registerToolRegistryEntry({ provider: 'custom', name: 'read_file', kind: 'edit', action: 'edit' })
    expect(resolveToolType('read_file', 'execute', { provider: 'custom' })).toMatchObject({
      kind: 'execute', action: 'execute', provider: 'custom', matchedBy: 'wire',
    })
  })

  it('provider 上下文 registry 未命中时回退 alias/fallback 且 provider 保持上下文', () => {
    expect(resolveToolType('run_shell', undefined, { provider: 'custom' })).toMatchObject({
      kind: 'execute', action: 'execute', provider: 'custom', matchedBy: 'alias-dictionary',
    })
    expect(resolveToolType('vendor__magic_action', undefined, { provider: 'custom' })).toMatchObject({
      kind: 'other', action: 'unknown', provider: 'custom', matchedBy: 'fallback',
    })
  })

  it('title 内嵌参数命中 provider-dictionary 并产生 embeddedSummary', () => {
    registerToolRegistryEntry({
      provider: 'hermes',
      name: 'terminal',
      displayName: 'Terminal',
      kind: 'execute',
      action: 'execute',
      summaryFields: ['command'],
      outputLabel: 'lines',
    })
    const model = buildToolRenderModel({ name: 'terminal: npm test', provider: 'hermes', input: null })
    expect(model.resolution.matchedBy).toBe('provider-dictionary')
    expect(model.name).toBe('Terminal')
    expect(model.summary).toBe('npm test')
  })

  it('wire kind 优先但仍保留字典 displayName 与 embeddedSummary', () => {
    registerToolRegistryEntry({
      provider: 'hermes',
      name: 'terminal',
      displayName: 'Bash',
      kind: 'execute',
      action: 'execute',
      summaryFields: ['command'],
    })
    const res = resolveToolType('terminal: npm test', 'execute', { provider: 'hermes' })
    expect(res).toMatchObject({
      kind: 'execute',
      matchedBy: 'wire',
      displayName: 'Bash',
      embeddedSummary: 'npm test',
    })
  })
})

describe('兼容层收敛后的展示辅助函数', () => {
  it('resolveToolRenderer 按 kind 归一解析渲染器', () => {
    expect(resolveToolRenderer('Read').getSummary({ path: 'a.txt' })).toBe('a.txt')
    expect(resolveToolRenderer('terminal').getSummary({ command: 'ls' })).toBe('ls')
    expect(resolveToolRenderer('UnknownTool').getSummary({ note: 'hello' })).toBe('hello')
  })

  it('getToolSummary 按 kind 字典提取，字符串输入直通', () => {
    expect(getToolSummary('Bash', { command: 'npm run build' })).toBe('npm run build')
    expect(getToolSummary('read_file', { file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(getToolSummary('UnknownTool', 'plain input')).toBe('plain input')
  })

  it('resolveConnectorColor：none 透明 / follow 随状态 / fixed 回退', () => {
    const colors = { toolOk: '#a', toolRun: '#b', toolErr: '#c' }
    expect(resolveConnectorColor('none', 'ok', colors, '#f')).toBe('transparent')
    expect(resolveConnectorColor('follow', 'ok', colors, '#f')).toBe('#a')
    expect(resolveConnectorColor('follow', 'run', colors, '#f')).toBe('#b')
    expect(resolveConnectorColor('follow', 'err', colors, '#f')).toBe('#c')
    expect(resolveConnectorColor('fixed', 'err', colors, '#f')).toBe('#f')
    expect(resolveConnectorColor('follow', 'err', {}, '#f')).toBe('#f')
  })
})
