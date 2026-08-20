import { describe, expect, it } from 'vitest'
import { selectThemeCssSnapshot } from '../../../domains/theme/themeCssSnapshot.ts'
import { resolveSkinCssVariables, resolveSkinDataAttributes, resolveSkinLayers } from '../skinResolver.ts'

const LAYOUT = { sidebarCollapsed: false, sidebarWidth: 250, sidebarEnabled: true }

describe('Skin Resolver（S5-B）', () => {
  it('按低→高优先级合并：default → global → workspace → agent → session', () => {
    const resolved = resolveSkinLayers([
      { kind: 'default', tokens: {} },
      { kind: 'committed', target: { scope: 'global' }, skinId: 'skin-global', tokens: { accent: '#111111', globalFont: 'mono' } },
      { kind: 'preview', target: { scope: 'workspace', workspaceId: 'ws1' }, previewId: 'preview-ws', tokens: { accent: '#222222' } },
      { kind: 'preview', target: { scope: 'agent', agentId: 'a1' }, previewId: 'preview-a', tokens: { accent: '#333333' } },
      { kind: 'preview', target: { scope: 'session', sessionId: 's1' }, previewId: 'preview-s', tokens: { accent: '#444444' } },
    ], { layout: LAYOUT })

    expect(resolved.tokens.accent).toBe('#444444')
    expect(resolved.tokens.globalFont).toBe('mono')
  })

  it('undefined 视为未覆盖，空字符串是显式覆盖', () => {
    const resolved = resolveSkinLayers([
      { kind: 'default', tokens: { userName: '默认名' } },
      { kind: 'preview', target: { scope: 'global' }, previewId: 'p1', tokens: { userName: undefined, accent: '' } },
    ])

    expect(resolved.tokens.userName).toBe('默认名')
    expect(resolved.tokens.accent).toBe('')
  })

  it('CSS 变量快照与 selectThemeCssSnapshot 同源一致', () => {
    const tokens = { accent: '#123456', globalBgImage: '', chatBg: '' }
    const resolved = resolveSkinLayers([
      { kind: 'default', tokens: {} },
      { kind: 'preview', target: { scope: 'global' }, previewId: 'p1', tokens },
    ], { layout: LAYOUT })

    const expected = selectThemeCssSnapshot({ ...resolved.tokens } as Record<string, unknown>, LAYOUT)
    expect(resolved.cssVariables).toEqual(expected)
    expect(resolveSkinCssVariables({ ...resolved.tokens } as Record<string, unknown>, LAYOUT)).toEqual(expected)
  })

  it('data attributes 由 resolved tokens 派生并有 default 值', () => {
    const defaults = resolveSkinDataAttributes({})
    expect(defaults['data-ui-scheme']).toBe('light')
    expect(defaults['data-msg-style']).toBe('terminal')
    expect(defaults['data-message-layout']).toBe('classic')

    const overridden = resolveSkinDataAttributes({ uiScheme: 'dark', messageLayout: 'claude', ccVariant: 'glass' })
    expect(overridden['data-ui-scheme']).toBe('dark')
    expect(overridden['data-message-layout']).toBe('claude')
    expect(overridden['data-cc-variant']).toBe('glass')
  })

  it('不修改输入 layer 对象', () => {
    const tokens = { accent: '#123456' }
    const input = { kind: 'preview', target: { scope: 'global' }, previewId: 'p1', tokens } as const

    resolveSkinLayers([input])

    expect(tokens).toEqual({ accent: '#123456' })
    expect(input.tokens).toBe(tokens)
  })

  it('来源链按层记录贡献字段', () => {
    const resolved = resolveSkinLayers([
      { kind: 'default', tokens: { accent: '#111111' } },
      { kind: 'preview', target: { scope: 'global' }, previewId: 'p1', tokens: { accent: '#222222', userName: 'k' } },
    ])

    expect(resolved.sources).toEqual([
      { kind: 'default', fields: ['accent'] },
      { kind: 'preview', target: { scope: 'global' }, previewId: 'p1', fields: ['accent', 'userName'] },
    ])
  })

  it('scoped css 取最高层提供的值', () => {
    const resolved = resolveSkinLayers([
      { kind: 'default', tokens: {}, css: 'default-css' },
      { kind: 'preview', target: { scope: 'global' }, previewId: 'p1', tokens: {}, css: 'preview-css' },
    ])

    expect(resolved.css).toBe('preview-css')
  })
})
