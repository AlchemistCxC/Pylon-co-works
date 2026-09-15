// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import HookDiagnosticsPanel from '../HookDiagnosticsPanel.tsx'
import { getHookRuntime } from '../../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'

describe('HookDiagnosticsPanel（设置 › 插件 › Hook 诊断）', () => {
  it('渲染熔断状态、锚点注册者与最近调用 trace', async () => {
    const runtime = getHookRuntime()
    runtime.reset()
    const owner = createPluginIdentity('diag.plugin', 'run-1')
    runtime.registry.register(owner, 'message.user.beforeSend', {
      id: 'audit',
      mode: 'pipeline',
      handler: () => { throw new Error('boom') },
    })
    await runtime.invoke('message.user.beforeSend', { source: 'local:x', content: 'hi', blocks: [] }, ['diag.plugin'])

    render(<HookDiagnosticsPanel />)

    // 熔断快照：1 次失败（未达阈值，未开启）。
    expect(screen.getByText(/连续失败 1 次/)).toBeTruthy()
    // 锚点注册者：锚点名（注册表 + trace 表各出现一次）+ 插件 · handler + 模式。
    expect(screen.getAllByText('message.user.beforeSend').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/diag\.plugin · audit（pipeline）/)).toBeTruthy()
    // trace：失败结局 + 错误信息（表格单元格文本为「失败（boom）」）。
    expect(screen.getByText(/失败（boom）/)).toBeTruthy()
    expect(screen.getByTitle('boom')).toBeTruthy()
  })
})
