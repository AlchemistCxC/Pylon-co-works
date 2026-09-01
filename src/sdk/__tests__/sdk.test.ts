// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  createPluginLogger,
  createSettingsSurface,
  definePlugin,
  PYLON_PLUGIN_API_VERSION,
  validatePluginManifest,
  type PluginUiEventBridge,
} from '../index.ts'

const manifest = {
  schema: 1 as const,
  id: 'feature.sdk-example',
  name: 'SDK example',
  version: '1.0.0',
  api: PYLON_PLUGIN_API_VERSION,
  kind: 'feature' as const,
  web: { entry: './dist/index.js' },
  dependencies: {},
  hotSwap: { mode: 'parallel' as const },
}

describe('Pylon API 1.0 SDK', () => {
  it('defines the package lifecycle without old contribution or trust declarations', async () => {
    const activate = vi.fn()
    const module = definePlugin({ activate })
    await module.activate({} as never)
    expect(activate).toHaveBeenCalledOnce()
    expect(Object.isFrozen(module)).toBe(true)
  })

  it('rejects an invalid lifecycle member', () => {
    expect(() => definePlugin({ activate: 'nope' } as never)).toThrow(/activate/)
    expect(() => definePlugin({ activate: () => undefined, deactivate: 'nope' } as never)).toThrow(/deactivate/)
  })

  it('validates only the API 1.0 manifest schema', () => {
    expect(validatePluginManifest(manifest)).toEqual(manifest)
    expect(() => validatePluginManifest({
      id: 'old.sdk', api: '0.1.0', trust: 'dev', capabilities: [], contributes: [],
    })).toThrow(/trust.*API 1\.0/)
  })

  it('api 按 allowlist 接受 1.0/1.1，拒绝未知更高版本', () => {
    const base = { ...manifest }
    expect(validatePluginManifest({ ...base, api: '1.1' }).api).toBe('1.1')
    expect(() => validatePluginManifest({ ...base, api: '1.2' })).toThrow(/api 仅支持 1\.0\/1\.1/)
  })

  it('creates a plugin logger with the id prefix', () => {
    const log = createPluginLogger('starter.hello')
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    log.info('hello', 1)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('[starter.hello]'), expect.any(String), 'hello', 1)
    info.mockRestore()
  })
})

describe('createSettingsSurface protocol', () => {
  type Listener = (detail: unknown) => void
  function harness() {
    const listeners = new Map<string, Set<Listener>>()
    const emitted: Array<{ event: string; detail: unknown }> = []
    const bridge: PluginUiEventBridge = {
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set())
        listeners.get(event)!.add(listener)
        return () => listeners.get(event)?.delete(listener)
      },
      emit(event, detail) { emitted.push({ event, detail }) },
    } as PluginUiEventBridge
    const container = document.createElement('div')
    return { bridge, emitted, listeners, container }
  }

  it('renders declared fields from host:input and submits settings:set', async () => {
    const definition = {
      description: '示例设置',
      fields: [
        { type: 'text' as const, key: 'greetingName', label: '问候名' },
        { type: 'toggle' as const, key: 'decorate', label: '装饰' },
        { type: 'select' as const, key: 'tone', label: '语气', options: [{ value: 'plain', label: '朴素' }, { value: 'warm', label: '热情' }] },
        { type: 'number' as const, key: 'retries', label: '重试', min: 0, max: 5 },
      ],
    }
    const { bridge, emitted, listeners, container } = harness()
    const surface = createSettingsSurface({ ...definition, id: 'starter.page' })
    const unmount = await surface.mount(container, bridge)

    // host:input 带值回流 → 字段渲染
    listeners.get('host:input')!.forEach(fn => fn({ pluginId: 'p', pageId: 'page', values: { greetingName: '阿明', decorate: true, tone: 'warm', retries: 2 } }))
    expect(container.querySelectorAll('.plugin-sdk-settings__field').length).toBe(4)
    const text = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(text.value).toBe('阿明')
    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)

    // text change → settings:set
    text.value = '世界'
    text.dispatchEvent(new Event('change'))
    expect(emitted.at(-1)).toEqual({ event: 'settings:set', detail: { key: 'greetingName', value: '世界' } })

    // toggle change → settings:set（jsdom 对游离元素不派发点击合成事件，手动触发 change）
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    expect(emitted.at(-1)).toEqual({ event: 'settings:set', detail: { key: 'decorate', value: false } })

    // select change → settings:set
    const select = container.querySelector('select') as HTMLSelectElement
    select.value = 'plain'
    select.dispatchEvent(new Event('change'))
    expect(emitted.at(-1)).toEqual({ event: 'settings:set', detail: { key: 'tone', value: 'plain' } })

    if (typeof unmount === 'function') unmount()
    expect(container.children.length).toBe(0)
  })

  it('ignores malformed host:input and renders an empty form without values', () => {
    const { bridge, listeners, container } = harness()
    const surface = createSettingsSurface({ id: 'malformed.page', fields: [{ type: 'toggle', key: 'on', label: '开' }] })
    const unmount = surface.mount(container, bridge)
    listeners.get('host:input')!.forEach(fn => fn(null))
    listeners.get('host:input')!.forEach(fn => fn({ values: 'not-an-object' }))
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(1)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)
    if (typeof unmount === 'function') unmount()
  })
})
