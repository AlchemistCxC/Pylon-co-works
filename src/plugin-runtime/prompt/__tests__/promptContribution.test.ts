/**
 * #201：sessionPrompt 注入系统插件化。
 * - 注册表：校验（id/target/text/order/maxBytes）、owner 启用过滤、order 稳定排序；
 * - 组装：identity/session/命令清单/扩展段分层顺序、扩展段预算截断（不静默）、
 *   无扩展段时与旧拼装语义等价（回归护栏，经 product 插件引导确定命令清单）。
 */
import { describe, expect, it } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { PromptContributionRegistry } from '../promptContributionRegistry.ts'
import { validatePromptContribution, PROMPT_CONTRIBUTION_DEFAULT_MAX_BYTES } from '../promptContributionTypes.ts'
import { assembleSessionPrompt } from '../../../host/commandSetResolver.ts'
import { getPromptContributionRegistry } from '../../runtimeServices.ts'

import type { PluginIdentity } from '../../pluginIdentity.ts'

const OWNER: PluginIdentity = {
  pluginId: 'plugin.test',
  version: '1.0.0',
  packageInstanceId: 'pkg-1',
  runtimeInstanceId: 'rt-1',
  instanceId: 'rt-1',
  key: 'rt-1',
}

describe('#201 PromptContributionRegistry', () => {
  it('校验非法贡献（空 id / 非法 target / 越界 maxBytes）', () => {
    expect(() => validatePromptContribution({ id: ' ', target: 'session-prompt', text: 'x', order: 100 })).toThrow()
    expect(() => validatePromptContribution({ id: 'a', target: 'system' as never, text: 'x', order: 100 })).toThrow()
    expect(() => validatePromptContribution({ id: 'a', target: 'session-prompt', text: 'x', order: 100, maxBytes: 0 })).toThrow()
    expect(() => validatePromptContribution({ id: 'a', target: 'session-prompt', text: 'x', order: 100, maxBytes: 99999 })).toThrow()
    expect(validatePromptContribution({ id: 'a', target: 'session-prompt', text: 'x', order: 100 }).maxBytes)
      .toBe(PROMPT_CONTRIBUTION_DEFAULT_MAX_BYTES)
  })

  it('resolveTarget 按 order 稳定排序、跳过空文本、按 owner 启用过滤', () => {
    const registry = new PromptContributionRegistry()
    registry.register(OWNER, { id: 'skills', target: 'session-prompt', text: '技能：无', order: 200 })
    registry.register(OWNER, { id: 'mcp', target: 'session-prompt', text: 'MCP：无', order: 150 })
    registry.register(OWNER, { id: 'empty', target: 'session-prompt', text: '', order: 120 })
    const other = { ...OWNER, pluginId: 'plugin.other' }
    registry.register(other, { id: 'disabled-one', target: 'session-prompt', text: '不该出现', order: 90 })
    expect(registry.resolveTarget('session-prompt', ['plugin.test']).map(item => item.id))
      .toEqual(['mcp', 'skills'])
    expect(registry.resolveTarget('session-prompt').map(item => item.id))
      .toEqual(['disabled-one', 'mcp', 'skills'])
  })
})

describe('#201 assembleSessionPrompt（经全局注册表）', () => {
  it('无扩展段时与旧拼装语义等价（persona + sessionPrompt + 命令清单）', () => {
    // enabledPluginIds 缺省 = core 命令集（与旧 buildSendMessagePayload 缺省语义一致）。
    const assembled = assembleSessionPrompt({ persona: '你是 Riccati', sessionPrompt: '用中文回答' })
    expect(assembled.startsWith('你是 Riccati\n\n用中文回答\n\n可用 CLI 命令：')).toBe(true)
    expect(assembled).toContain('/model')
  })

  it('扩展段按 order 追加在命令清单之后，预算截断留痕', () => {
    const disposable = getPromptContributionRegistry().register(
      { ...OWNER, pluginId: 'plugin.skills' },
      { id: 'skill-manifest', target: 'session-prompt', text: '可用技能：阅读代码、跑测试', order: 100, maxBytes: 8 },
    )
    try {
      const assembled = assembleSessionPrompt({ persona: 'P' })
      const commandBlockIndex = assembled.indexOf('可用 CLI 命令：')
      const skillIndex = assembled.indexOf('可用技能')
      expect(skillIndex).toBeGreaterThan(commandBlockIndex)
      expect(assembled).toContain('超预算截断')
    } finally {
      void disposable.dispose()
    }
    // 注销后不再注入。
    expect(assembleSessionPrompt({ persona: 'P' })).not.toContain('可用技能')
  })
})
