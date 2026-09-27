import { describe, expect, it } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import {
  decorateSuggestions,
  selectUserTier,
  filterCommandSuggestions,
  parseSlashCommand,
  resolveFallbackCommands,
  resolveCommandSuggestions,
} from '../commandRegistry.ts'

describe('commandRegistry', () => {
  it('解析 slash command 与参数', () => {
    expect(parseSlashCommand('/model deepseek')).toEqual({ name: '/model', args: 'deepseek', raw: '/model deepseek' })
    expect(parseSlashCommand('普通文本')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('从已激活 command set 提供 fallback suggestions', () => {
    const fallback = resolveFallbackCommands()
    expect(fallback.length).toBeGreaterThan(0)
    expect(filterCommandSuggestions('/mo', fallback)[0]?.cmd).toBe('/model')
    expect(filterCommandSuggestions('普通文本', fallback)).toEqual([])
  })

  it('归一化 agent 上报命令并支持前缀过滤', () => {
    const live = resolveCommandSuggestions([{ name: 'review', input_hint: '<path>', description: '审查文件' }])
    expect(live.find(command => command.cmd === '/review')).toEqual({ cmd: '/review', args: ' <path>', info: '审查文件' })
    expect(filterCommandSuggestions('/re', live)[0]?.info).toBe('审查文件')
  })

  // #327：命令名是英文唯一键，中文界面下必须能用母语检索。
  it('中文关键词可命中英文命令名', () => {
    const fallback = resolveFallbackCommands()
    expect(filterCommandSuggestions('/新', fallback).map(command => command.cmd)).toEqual(['/new'])
    expect(filterCommandSuggestions('/模型', fallback).map(command => command.cmd)).toEqual(['/model'])
    // 关键词按子串匹配：中文没有词边界，「会话」应命中关键词「新会话」
    expect(filterCommandSuggestions('/会话', fallback).map(command => command.cmd)).toEqual(['/new'])
  })

  it('命令名过滤大小写不敏感，且空查询保留全量', () => {
    const fallback = resolveFallbackCommands()
    expect(filterCommandSuggestions('/MO', fallback)[0]?.cmd).toBe('/model')
    expect(filterCommandSuggestions('/', fallback)).toHaveLength(fallback.length)
  })

  // agent 上报命令时输入栏只用上报项（不上报则用注册表 fallback），故检索词与分层档
  // 必须按命令名并回，否则那条分支上中文搜不到（#327）、分层也落不了地（#329）。
  it('默认层筛选只留 user 级（internal 由「全部」控件负责展开）', () => {
    const rows = [
      { cmd: '/new', args: '', info: '新会话', tier: 'user' as const },
      { cmd: '/browser.agent-click', args: '', info: '内部命令', tier: 'internal' as const },
      // 未声明档位的来源（旧载荷/手写建议项）按非 internal 处理，保持既有可见性不变
      { cmd: '/legacy', args: '', info: '未声明档位' },
    ]
    expect(selectUserTier(rows).map(row => row.cmd)).toEqual(['/new', '/legacy'])
  })

  it('把宿主检索词与可见性档按名并回建议项', () => {
    const attached = decorateSuggestions([
      { cmd: '/new', args: '', info: '新会话' },
      { cmd: '/vendor-extra', args: '', info: '插件命令' },
    ], 'user')
    expect(attached[0]?.keywords).toEqual(['新会话', '新建', '新建会话'])
    expect(attached[0]?.tier).toBe('user')
    // 未注册命令不得凭空获得检索词，但按调用方给的兜底档位呈现
    expect(attached[1]?.keywords).toBeUndefined()
    expect(attached[1]?.tier).toBe('user')
    // 宿主注册表里的 internal 命令即便被 agent 上报，也仍归 internal
    const internal = decorateSuggestions([{ cmd: '/browser.agent-click', args: '', info: 'x' }], 'user')
    expect(internal[0]?.tier).toBe('internal')
    expect(filterCommandSuggestions('/新', attached).map(command => command.cmd)).toEqual(['/new'])
  })
})
