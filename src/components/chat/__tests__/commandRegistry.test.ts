import { describe, expect, it } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import {
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
})
