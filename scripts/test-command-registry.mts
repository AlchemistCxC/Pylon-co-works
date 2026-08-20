import { strict as assert } from 'node:assert'
import '../src/plugin-runtime/pluginCompositionRoot.ts'
import {
  FALLBACK_COMMANDS,
  filterCommandSuggestions,
  parseSlashCommand,
  resolveCommandSuggestions,
} from '../src/components/chat/commandRegistry.ts'

assert.equal(parseSlashCommand('/model deepseek').name, '/model')
assert.equal(parseSlashCommand('/model deepseek').args, 'deepseek')
assert.equal(parseSlashCommand('普通文本'), null)
assert.equal(parseSlashCommand('/'), null)

const fallback = resolveCommandSuggestions([])
assert.equal(fallback.length, FALLBACK_COMMANDS.length)
assert.equal(filterCommandSuggestions('/mo', fallback)[0]?.cmd, '/model')
assert.equal(filterCommandSuggestions('普通文本', fallback).length, 0)

const live = resolveCommandSuggestions([{ name: 'review', input_hint: '<path>', description: '审查文件' }])
assert.deepEqual(live.find(command => command.cmd === '/review'), { cmd: '/review', args: ' <path>', info: '审查文件' })
assert.equal(filterCommandSuggestions('/re', live)[0]?.info, '审查文件')

console.log('command registry 回归测试通过')
