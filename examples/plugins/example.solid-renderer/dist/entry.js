import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'

const PLUGIN_ID = 'example.solid-renderer'
const SUITE_ID = `${PLUGIN_ID}.suite`

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

function surface(id) {
  const listeners = new Map()
  return {
    rendererId: id,
    kind: 'solid',
    mount(container, snapshot) {
      const node = document.createElement('div')
      node.dataset.exampleSolidSlot = id
      node.textContent = String(snapshot.payload ?? '')
      container.append(node)
      return node
    },
    update(handle, snapshot) { handle.textContent = String(snapshot.payload ?? '') },
    destroy(handle) { handle.remove() },
    on(event, listener) {
      const group = listeners.get(event) ?? new Set()
      group.add(listener)
      listeners.set(event, group)
      return () => group.delete(listener)
    },
  }
}

const slot = (id, kinds, fallback = false) => ({
  id,
  label: `Example ${id}`,
  targetSuites: [SUITE_ID],
  kinds,
  priority: fallback ? 100 : 10,
  fallback,
  settings: fallback ? undefined : { schemaVersion: 1, groups: [{ id: 'slot', label: 'Slot', fields: [{ key: 'mode', label: '模式', type: 'choice', presentation: 'radio', options: [{ value: 'semantic', label: '语义' }, { value: 'raw', label: '原始' }], default: 'semantic' }] }] },
  canRender: () => true,
  createSurface: input => surface(input.kind === 'content.unknown' ? id : `${id}.${input.kind}`),
})

const factory = {
  async prepare(context) {
    return {
      mount(container, input, host) {
        const [currentInput, setCurrentInput] = createSignal(input)
        const view = () => {
          const node = document.createElement('div')
          node.dataset.exampleSolidSuite = SUITE_ID
          node.textContent = `Example Solid Suite · ${context.suiteId} · ${currentInput().sheetId}`
          return node
        }
        const dispose = render(view, container)
        const listeners = new Map()
        let destroyed = false
        const emit = (event, payload) => { for (const listener of listeners.get(event) ?? []) listener(payload) }
        queueMicrotask(() => { if (!destroyed) emit('ready', { suiteId: SUITE_ID }) })
        return {
          update(next) { if (!destroyed) setCurrentInput(next) },
          pause() {},
          resume() {},
          destroy() { destroyed = true; dispose(); container.replaceChildren(); listeners.clear() },
          on(event, listener) {
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

export function activate(context) {
  context.renderer.registerRenderKind({
    id: `${PLUGIN_ID}.note`,
    category: 'content',
    fallbackKind: 'content.unknown',
    priority: 500,
    fixture: { text: 'example' },
    defaultTokens: { density: 'compact' },
    settingsSchemaVersion: 1,
    validateInput: input => Boolean(input && typeof input === 'object'),
  })
  context.renderer.registerSuite({
    id: SUITE_ID,
    label: 'Example Solid Suite',
    description: '可安装、可热更新的第三方 Solid Workbench 范例。',
    apiVersion: 1,
    runtime: { framework: 'solid', version: '1.9' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    requiredKinds: [`${PLUGIN_ID}.note`],
    optionalKinds: ['content.unknown'],
    settings,
    factory,
  })
  context.renderer.registerSlot(slot(`${PLUGIN_ID}.base`, [`${PLUGIN_ID}.note`]))
  context.renderer.registerSlot(slot(`${PLUGIN_ID}.fallback`, ['content.unknown'], true))
  context.presentation.registerProfile({
    id: `${PLUGIN_ID}.profile`,
    label: 'Example Solid',
    description: '第三方 Suite 的表现令牌示例。',
    family: 'custom',
    interfaceMode: 'modern-gui',
    tokens: { msgStyle: 'bubble', inputVariant: 'composer', assistantDot: true },
  })
}
