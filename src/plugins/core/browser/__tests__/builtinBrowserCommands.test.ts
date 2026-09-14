import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { createBuiltinBrowserCommandDefinitions } from '../builtinBrowserCommands.ts'

const invokeMock = vi.mocked(invoke)

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function findCommand(id: string) {
  const definition = createBuiltinBrowserCommandDefinitions().find(command => command.id === id)
  expect(definition, `命令 ${id} 应已注册`).toBeDefined()
  return definition!
}

describe('builtin browser agent 命令族（issue #82）', () => {
  it('agent 工具面全部注册，观察类 read / 写操作 execute', () => {
    const definitions = createBuiltinBrowserCommandDefinitions()
    const ids = new Set(definitions.map(command => command.id))
    for (const id of [
      'browser.agent-ensure', 'browser.agent-navigate', 'browser.agent-snapshot', 'browser.agent-screenshot',
      'browser.agent-wait', 'browser.agent-read-network', 'browser.agent-save-page', 'browser.agent-scroll',
      'browser.agent-tab-list', 'browser.agent-tab-new', 'browser.agent-tab-select', 'browser.agent-tab-close',
      'browser.agent-click', 'browser.agent-type', 'browser.agent-press', 'browser.agent-download',
      'browser.agent-emulate', 'browser.agent-history',
    ]) {
      expect(ids.has(id), id).toBe(true)
    }
    expect(findCommand('browser.agent-snapshot').permission).toBe('read')
    expect(findCommand('browser.agent-navigate').permission).toBe('execute')
    expect(findCommand('browser.agent-click').permission).toBe('execute')
  })

  it('browser.agent-click 把 MCP 的 ref 映射为 Rust 的 reference 参数', async () => {
    invokeMock.mockResolvedValue({ ok: true, driver: 'cdp' })
    const click = findCommand('browser.agent-click')
    const result = await click.execute!({ commandId: 'browser.agent-click', args: { ref: 'e12', sessionKey: 's1' } }) as { ok: boolean }
    expect(result.ok).toBe(true)
    const [, args] = invokeMock.mock.calls.at(-1)!
    expect(args).toMatchObject({ reference: 'e12', sessionKey: 's1' })
  })

  it('策略拒绝信封转换为 [code] message 异常', async () => {
    invokeMock.mockResolvedValue({ ok: false, code: 'readonly_restricted', message: '当前为只读档' })
    const press = findCommand('browser.agent-press')
    await expect(press.execute!({ commandId: 'browser.agent-press', args: { key: 'Enter' } })).rejects
      .toThrow('[readonly_restricted] 当前为只读档')
  })

  it('browser.agent-click 缺少 ref/selector 时直接报错，不发起调用', () => {
    invokeMock.mockClear()
    const click = findCommand('browser.agent-click')
    expect(() => click.execute!({ commandId: 'browser.agent-click', args: {} })).toThrow('至少提供一个')
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
