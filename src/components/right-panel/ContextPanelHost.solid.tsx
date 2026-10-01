import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js'
import { getContextPanelRegistry, getPluginSettingOptionsRegistry, getPluginSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import { settingFieldKey, type SettingsValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { selectContextPanels, resolveContextPanelDefault } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'
import { createSolidMount } from '../../host/solidBridge.solid'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'
import type { ContextPanelHostProps, ContextPanelPluginIslandInput } from './rightPanelTypes.ts'

// 贡献体是 React 面（first-party 组件 / IsolatedPluginSurface + schema 面 + 边界 + Suspense）：
// 按 P52 D4 经 eager glob 缝加载 React 岛。
interface ContextPanelIslandModule {
  mountContextPanelPluginIsland(container: HTMLElement, get: () => ContextPanelPluginIslandInput): { rerender(): void; dispose(): void }
}

const islandModules = import.meta.glob<ContextPanelIslandModule>('./ContextPanelPluginIsland.tsx', { eager: true })
const islandModule = islandModules['./ContextPanelPluginIsland.tsx']
if (!islandModule) throw new Error('ContextPanel React 岛未进入 Vite module graph')

/** 外部 store（subscribe/getSnapshot 快照语义）→ Solid 信号（快照引用等值）。 */
function createRegistrySignal<T>(store: { subscribe(listener: () => void): () => void; getSnapshot(): T }): () => T {
  const [value, setValue] = createSignal<T>(store.getSnapshot())
  // updater 形态：T 可能是任意值（含函数），走 (prev) => next 重载避开 Solid setter
  // 对「函数值」的排除分支。
  onCleanup(store.subscribe(() => setValue(() => store.getSnapshot())))
  return value
}

const EMPTY_ADAPTER_SNAPSHOT = Object.freeze({ values: Object.freeze({}), unavailable: Object.freeze({}), revision: 0 })

export default function ContextPanelHost(props: ContextPanelHostProps) {
  const rightWidth = createZustandSignal(useRightRailStore, state => state.width)
  const registry = getContextPanelRegistry()
  const store = getPluginSettingsStore()
  const optionsRegistry = getPluginSettingOptionsRegistry()
  const snapshot = createRegistrySignal(registry)
  // 可切换的面板 = 通过 `when` 闸门的全部面板（与 Sheet 种类无关）；种类只影响「没选过时默认看谁」。
  const entries = createMemo(() => selectContextPanels(snapshot().entries, {
    workspaceKind: props.sheet.kind,
    sheetId: props.sheet.id,
    activeSessionId: props.ctx.activeSession,
  }))
  const [activeId, setActiveId] = createSignal<string>(props.activePanelId ?? '')
  createEffect(() => {
    if (props.activePanelId !== undefined) setActiveId(props.activePanelId ?? '')
  })
  const active = createMemo(() => entries().find(entry => entry.contributionId === activeId())
    ?? resolveContextPanelDefault(entries(), props.sheet.kind))

  const adapter = createMemo(() => {
    const current = active()
    return current?.value.schema
      ? current.value.valueAdapter ?? (current.ownerPluginId
        ? createPluginSettingsValueAdapter({ store, ownerPluginId: current.ownerPluginId, contributionId: current.contributionId, namespace: 'context-panel' })
        : undefined)
      : undefined
  })
  const [adapterSnapshot, setAdapterSnapshot] = createSignal(adapter()?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT)
  createEffect(() => {
    const current = adapter()
    setAdapterSnapshot(current?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT)
    if (current) {
      onCleanup(current.subscribe(() => setAdapterSnapshot(current.getSnapshot())))
    }
  })
  const optionSnapshot = createRegistrySignal(optionsRegistry)

  const sheetSnapshot = () => ({ ...props.sheet })
  const ctxSnapshot = () => ({ ...props.ctx })

  // choice/multi-choice/color 字段的 option 投影（岛内原样消费；框架无关计算留在 Solid 侧）。
  const schemaOptions = createMemo(() => {
    const current = active()
    if (!current?.value.schema || !adapter()) return {}
    return Object.fromEntries(current.value.schema.groups.flatMap(group => group.fields.map(field => {
      const key = settingFieldKey(field)
      if (field.type !== 'choice' && field.type !== 'multi-choice' && field.type !== 'color') return []
      const target = 'optionTarget' in field && field.optionTarget
        ? field.optionTarget
        : `context-panel.${encodeURIComponent(current.ownerPluginId ?? '').replaceAll('.', '%2E')}.${encodeURIComponent(current.contributionId).replaceAll('.', '%2E')}.${encodeURIComponent(key).replaceAll('.', '%2E')}`
      const base = 'options' in field ? field.options : []
      return [[key, resolvePluginSettingOptions(target, base, optionSnapshot().entries)]] as const
    })))
  })

  const onSurfaceEvent = (event: string, detail: unknown) => {
    if (event === 'host:collapse') {
      useRightRailStore.getState().setCollapsed(true)
    }
    if (event === 'host:select-session' && (typeof detail === 'string' || detail === null)) props.ctx.selectSession(detail)
    if (event === 'settings:set' && detail && typeof detail === 'object') {
      const current = adapter()
      if (current) {
        const { key, value } = detail as { key?: unknown; value?: unknown }
        if (typeof key === 'string') void current.setValue(key, value as SettingsValue)
      }
    }
    if (event === 'settings:remove' && typeof detail === 'string') {
      const current = adapter()
      if (current) void current.removeValue(detail)
    }
  }

  /** 岛输入快照（读取全部发生在 untrack 调用点，恒为当前值）。 */
  const buildIslandInput = (): ContextPanelPluginIslandInput => {
    const current = active()
    if (!current) {
      return {
        contributionId: '', ownerRuntimeInstanceId: '', renderKind: 'first-party-react',
        sheet: sheetSnapshot(), ctx: ctxSnapshot(),
        values: EMPTY_ADAPTER_SNAPSHOT.values, unavailable: EMPTY_ADAPTER_SNAPSHOT.unavailable,
        schemaOptions: {}, onSettingChange: () => {}, onSettingReset: () => {}, onRestoreUnavailable: () => {}, onSurfaceEvent,
      }
    }
    return {
      contributionId: current.contributionId,
      ownerRuntimeInstanceId: current.ownerRuntimeInstanceId,
      renderKind: current.value.renderKind,
      surfaceId: current.value.renderKind === 'isolated-surface' ? current.value.surfaceId : undefined,
      component: current.value.renderKind === 'first-party-react' ? current.value.component : undefined,
      sheet: sheetSnapshot(),
      ctx: ctxSnapshot(),
      schema: current.value.schema && adapter() ? current.value.schema : undefined,
      values: adapterSnapshot().values,
      unavailable: adapterSnapshot().unavailable,
      schemaOptions: schemaOptions(),
      onSettingChange: (key, value) => { void adapter()?.setValue(key, value) },
      onSettingReset: key => { void adapter()?.reset(key) },
      onRestoreUnavailable: key => { adapter()?.restoreUnavailable?.(key) },
      onSurfaceEvent,
    }
  }

  // 插件贡献 React 岛：岛生命周期跟随面板体 DOM（面板清空时随 Show 一起拆掉重挂），
  // 依赖（激活面板/adapter 快照/option 投影/sheet 上下文）变化 → rerender（React 自 diff）。
  let rerenderIsland: (() => void) | null = null
  createEffect(() => {
    // 追踪依赖：sheet 标识字段 + 会话 + adapter 快照 + option 投影。
    const deps = [active(), props.sheet.id, props.sheet.kind, props.sheet.title, props.ctx.activeSession, adapterSnapshot(), schemaOptions()]
    untrack(() => { rerenderIsland?.() })
    void deps
  })

  return (
    <Show when={active()}>{current => (
      // aria-label 用稳定文案（#250）：sheet.title 是建会话时刻的快照，会话切换/
      // 重命名后陈旧，实机 a11y 树出现指向过期会话的右栏名；归属上下文已由页签与
      // 下方面板 tablist 承载，这里不需要会话名。
      <aside class="context-panel" data-sheet-kind={props.sheet.kind} aria-label="右栏" style={{ '--right-width': `${rightWidth()}px` }}>
        <div class="context-panel-head">
          {/* 切换器列出**所有可显示的面板**（`when` 闸门之上的全部），不再按 Sheet 种类裁剪：
              按种类裁剪时，单面板的 Sheet 只剩一个撑满的标签，看上去是标题而不是切换器
              （用户实机报「侧栏内部没有切换侧栏种类的按钮」）。 */}
          <div class="context-panel-tabs" role="tablist" aria-label="右栏面板">
            <For each={entries()}>{entry => (
              <button
                type="button"
                role="tab"
                aria-selected={entry.contributionId === current().contributionId}
                class={`context-panel-mode ${entry.contributionId === current().contributionId ? 'active' : ''}`}
                title={entry.value.label}
                onClick={() => {
                  // 选择要落到 store（而不仅是本地 state）：它是「用户显式选过」的唯一凭据——
                  // 决定跨 Sheet 是否保持、重载后是否还记得。只写本地 state 的话，切一次 Sheet
                  // 就会被亲和默认值抢回去。
                  setActiveId(entry.contributionId)
                  useRightRailStore.getState().setActivePanel(entry.contributionId)
                }}
              >
                {entry.value.label}
              </button>
            )}</For>
          </div>
        </div>
        <div class="context-panel-body">
          <ContextPanelIslandBody
            mount={islandModule.mountContextPanelPluginIsland}
            getInput={buildIslandInput}
            onRerenderHandle={rerender => { rerenderIsland = rerender }}
          />
        </div>
      </aside>
    )}</Show>
  )
}

/** 岛宿主体：岛生命周期跟随本 DOM（挂载期建、卸载期拆），数据经 get() 每次现读。 */
function ContextPanelIslandBody(props: {
  mount: typeof islandModule.mountContextPanelPluginIsland
  getInput: () => ContextPanelPluginIslandInput
  onRerenderHandle: (rerender: (() => void) | null) => void
}) {
  let host: HTMLDivElement | undefined
  onMount(() => {
    if (!host) return
    const island = props.mount(host, props.getInput)
    props.onRerenderHandle(() => island.rerender())
    onCleanup(() => {
      props.onRerenderHandle(null)
      island.dispose()
    })
  })
  return <div ref={element => { host = element }} style={{ display: 'contents' }} />
}

/** React 薄桥（ContextPanelHost.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const renderContextPanelHost = createSolidMount(ContextPanelHost)
