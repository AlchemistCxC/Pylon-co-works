import { afterEach, describe, expect, it } from 'vitest'
import '../../plugin-runtime/pluginCompositionRoot.ts'
import {
  CORE_COMMAND_SET_PLUGIN_ID,
  type CommandSetDescriptor,
} from '../../contracts/agentCommandSet'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity'
import { getCommandRegistry } from '../../plugin-runtime/runtimeServices'
import {
  buildAgentCommandPrompt,
  injectAgentCommandPrompt,
  resolveCommandSetDescriptors,
  resolveCommandSetSuggestions,
  resolvePluginCommands,
} from '../commandSetResolver'

const temporaryDisposables: Array<{ dispose(): void | Promise<void> }> = []
let sequence = 0

afterEach(async () => {
  for (const disposable of temporaryDisposables.splice(0).reverse()) await disposable.dispose()
})

function installCoreTestCommands(id: string, commands: readonly CommandSetDescriptor[]): void {
  const identity = createPluginIdentity(id, `test-${++sequence}`)
  for (const command of commands) {
    temporaryDisposables.push(getCommandRegistry().register(identity, {
      ...command,
      id: command.name,
    }, {
      contributionId: `${id}.${command.name}.${sequence}`,
      priority: 500,
    }))
  }
}

describe('commandSetResolver（v2 Command Registry）', () => {
  it('内置命令集来自 core 插件，确定性按 priority/name 排序', () => {
    const commands = resolvePluginCommands([CORE_COMMAND_SET_PLUGIN_ID])
    expect(commands.map(command => command.name)).toEqual([
      'model', 'compact', 'new', 'export', 'clear', 'mode',
    ])
    expect(commands[0].agentPromptSnippet).toContain('/model')
    // Skin 命令由 builtin.skin 单独持有，不影响 core 命令集排序与数量
    expect(resolvePluginCommands().filter(command => command.name.startsWith('skin.'))).toHaveLength(11)
  })

  it('enabledPluginIds 过滤贡献（旧数据缺省 = 全部 active）', () => {
    expect(resolvePluginCommands([CORE_COMMAND_SET_PLUGIN_ID]).map(command => command.name))
      .toHaveLength(6)
    expect(resolvePluginCommands(['missing.plugin'])).toEqual([])
  })

  it('人机侧建议合并 agent 上报命令：同 name agent 覆盖展示字段，保留 prompt 片段', () => {
    const suggestions = resolveCommandSetSuggestions([{
      name: 'model',
      input_hint: '<runtime-hint>',
      description: '运行时描述',
    }])
    const model = suggestions.find(item => item.cmd === '/model')
    expect(model).toEqual({ cmd: '/model', args: ' <runtime-hint>', info: '运行时描述' })
    expect(resolveCommandSetDescriptors([{ name: 'model' }]).find(item => item.name === 'model')
      ?.agentPromptSnippet).toContain('/model')

    const extra = resolveCommandSetSuggestions([{ name: 'vendor_extra', description: '新命令' }])
    expect(extra.find(item => item.cmd === '/vendor_extra')).toEqual({
      cmd: '/vendor_extra', args: '', info: '新命令',
    })
  })

  it('同名命令跨插件去重（Registry 顺序靠前的贡献优先，确定性）', () => {
    installCoreTestCommands('test.dup', [{ name: 'model', description: '后到覆盖被拒绝', priority: 1 }])
    const commands = resolvePluginCommands()
    expect(commands.filter(command => command.name === 'model')).toHaveLength(1)
    expect(commands.find(command => command.name === 'model')?.description).toBe('切换模型')
  })

  it('prompt 注入确定性 + 预算截断', () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      name: `bulk${index}`,
      description: `批量命令 ${index}`,
      agentPromptSnippet: `/bulk${index}：${'x'.repeat(40)}`,
      priority: index,
    }))
    installCoreTestCommands('test.many', many)
    const prompt = buildAgentCommandPrompt({ enabledPluginIds: ['test.many'] })
    expect(prompt.startsWith('可用 CLI 命令：')).toBe(true)
    expect(prompt).toContain('按优先级截断')
    expect(prompt.length).toBeLessThanOrEqual(1400)

    const injected = injectAgentCommandPrompt({
      sessionPrompt: '用户提示词',
      commandSetPlugins: [CORE_COMMAND_SET_PLUGIN_ID],
    })
    expect(injected.startsWith('用户提示词\n\n可用 CLI 命令：')).toBe(true)
  })

  it('空命令集注入返回用户原提示词（不回退 core，也不覆盖）', () => {
    expect(injectAgentCommandPrompt({ sessionPrompt: 'base', commandSetPlugins: ['missing.plugin'] })).toBe('base')
  })
})
