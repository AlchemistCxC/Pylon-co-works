/**
 * example.solid-renderer 的真实实现入口。
 *
 * 本文件是 dist/entry.js 的唯一来源：`bun run build:example-plugin`
 * （scripts/build-example-plugin.mjs）用 esbuild 把这里打成
 * dist/entry.js，再由 pylon-plugin.json 的 web.entry 指向它。
 *
 * 纪律（见本包 README）：
 * - 只使用公开的 renderer / presentation API 与宿主注入的 context；
 * - 不 import 宿主内部模块（宿主 registry / store / journal / Tauri invoke）；
 * - solid-js 由宿提供，构建时置 external，不打进 bundle。
 */
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

const PLUGIN_ID = 'example.solid-renderer'
const SUITE_ID = `${PLUGIN_ID}.suite`

/** 与 src/renderers/exampleSlots.ts 的冻结清单同源，避免两处漂移。 */
import { EXAMPLE_SLOT_KINDS } from './renderers/exampleSlots.ts'

const [NOTE_KIND, FALLBACK_KIND] = EXAMPLE_SLOT_KINDS

const settings = {
  schemaVersion: 1,
  groups: [{
    id: 'appearance',
    label: 'Example Suite 外观',
    fields: [
      { key: 'density', label: '密度', type: 'choice', presentation: 'segmented', options: [{ value: 'compact', label: '紧凑' }, { value: 'roomy', label: '宽松' }], default: 'compact' },
      { key: 'accent', label: '强调色', type: 'color', presentation: 'palette+picker', default: '#67e8f9' },
      { key: 'scale', label: '字号缩放', type: 'number', presentation: 'slider+input', min: 0.8, max: 1.4, step: 0.1, default: 1 },
      { key: 'enabled', label: '启用 Suite 装饰', type: 'boolean', presentation: 'toggle', default: true },
      { key: 'label', label: '标签', type: 'text', presentation: 'input', default: 'Example Solid' },
    ],
  }],
}

function surface(id: string) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  return {
    rendererId: id,
    kind: 'solid',
    mount(container: HTMLElement, snapshot: { payload?: unknown }) {
      const node = document.createElement('div')
      node.dataset.exampleSolidSlot = id
      node.textContent = String(snapshot.payload ?? '')
      container.append(node)
      return node
    },
    update(handle: HTMLElement, snapshot: { payload?: unknown }) { handle.textContent = String(snapshot.payload ?? '') },
    destroy(handle: HTMLElement) { handle.remove() },
    on(event: string, listener: (payload: unknown) => void) {
      const group = listeners.get(event) ?? new Set()
      group.add(listener)
      listeners.set(event, group)
      return () => group.delete(listener)
    },
  }
}

const slot = (id: string, kinds: readonly string[], fallback = false) => ({
  id,
  label: `Example ${id}`,
  targetSuites: [SUITE_ID],
  kinds,
  priority: fallback ? 100 : 10,
  fallback,
  settings: fallback ? undefined : { schemaVersion: 1, groups: [{ id: 'slot', label: 'Slot', fields: [{ key: 'mode', label: '模式', type: 'choice', presentation: 'radio', options: [{ value: 'semantic', label: '语义' }, { value: 'raw', label: '原始' }], default: 'semantic' }] }] },
  canRender: () => true,
  createSurface: (input: { kind: string }) => surface(input.kind === FALLBACK_KIND ? id : `${id}.${input.kind}`),
})

const factory = {
  async prepare(context: { suiteId: string }) {
    return {
      mount(container: HTMLElement, input: { sheetId: string }, _host: unknown) {
        const [currentInput, setCurrentInput] = createSignal(input)
        const view = () => {
          const node = document.createElement('div')
          node.dataset.exampleSolidSuite = SUITE_ID
          node.textContent = `Example Solid Suite · ${context.suiteId} · ${currentInput().sheetId}`
          return node
        }
        const dispose = render(view, container)
        const listeners = new Map<string, Set<(payload: unknown) => void>>()
        let destroyed = false
        const emit = (event: string, payload: unknown) => { for (const listener of listeners.get(event) ?? []) listener(payload) }
        queueMicrotask(() => { if (!destroyed) emit('ready', { suiteId: SUITE_ID }) })
        return {
          update(next: { sheetId: string }) { if (!destroyed) setCurrentInput(next) },
          pause() {},
          resume() {},
          destroy() { destroyed = true; dispose(); container.replaceChildren(); listeners.clear() },
          on(event: string, listener: (payload: unknown) => void) {
            if (event === 'ready' && !destroyed) queueMicrotask(() => listener({ suiteId: SUITE_ID }))
            const group = listeners.get(event) ?? new Set()
            group.add(listener)
            listeners.set(event, group)
            return () => group.delete(listener)
          },
        }
      },
    }
  },
}

export function activate(context: any): void {
  context.renderer.registerRenderKind({
    id: `${PLUGIN_ID}.note`,
    category: 'content',
    fallbackKind: FALLBACK_KIND,
    priority: 500,
    fixture: { text: 'example' },
    defaultTokens: { density: 'compact' },
    settingsSchemaVersion: 1,
    validateInput: (input: unknown) => Boolean(input && typeof input === 'object'),
  })
  context.renderer.registerSuite({
    id: SUITE_ID,
    label: 'Example Solid Suite',
    description: '可安装、可热更新的第三方 Solid Workbench 范例。',
    apiVersion: 1,
    runtime: { framework: 'solid', version: '1.9' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    requiredKinds: [NOTE_KIND],
    optionalKinds: [FALLBACK_KIND],
    settings,
    factory,
  })
  context.renderer.registerSlot(slot(`${PLUGIN_ID}.base`, [NOTE_KIND]))
  context.renderer.registerSlot(slot(`${PLUGIN_ID}.fallback`, [FALLBACK_KIND], true))
  context.presentation.registerProfile({
    id: `${PLUGIN_ID}.profile`,
    label: 'Example Solid',
    description: '第三方 Suite 的表现令牌示例。',
    family: 'custom',
    interfaceMode: 'modern-gui',
    tokens: { msgStyle: 'bubble', inputVariant: 'composer', assistantDot: true },
  })
}
