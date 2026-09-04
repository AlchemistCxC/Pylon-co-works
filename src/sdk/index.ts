/**
 * Pylon API 1.0 插件开发 SDK（public authoring surface）。
 *
 * 打包约束：本文件会被 esbuild 打进插件 bundle ——
 * - `export type` 全部为编译期类型，零运行时代价；
 * - 运行时值仅限常量表与纯函数 helpers，禁止 import 任何宿主运行时模块；
 * - helpers 的 DOM 输出一律使用宿主视觉语义 token（VISUAL_SEMANTIC_TOKENS），
 *   不复制宿主的透明度/阴影/动画毫秒值。
 */
import {
  parsePylonPluginManifest,
  PYLON_PLUGIN_API_MIN,
  PYLON_PLUGIN_API_LATEST,
  PYLON_PLUGIN_API_SUPPORTED,
  PYLON_PLUGIN_API_VERSION,
  PYLON_PLUGIN_MANIFEST_FILE,
  type PylonPluginManifest,
} from '../plugin-runtime/packageManifest.ts'
import type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.ts'
import type { PluginUiSurface, PluginUiEventBridge, PluginUiUnmount } from '../plugin-runtime/ui/pluginUiTypes.ts'

// ── 类型面：插件作者需要的全部宿主契约（import type，零运行时代价）──
export type { BuiltinPluginActivationContext as PluginActivationContext } from '../plugin-runtime/pluginActivationContext.ts'
export type { PackagePluginModule } from '../plugin-runtime/packagePluginRuntime.ts'
export type { PylonPluginManifest } from '../plugin-runtime/packageManifest.ts'
export type { PluginIdentity } from '../plugin-runtime/pluginIdentity.ts'
export type {
  PluginScope,
  PluginResourceDisposable,
  PluginResourceMetadata,
  PluginCleanupError,
  PluginScopeDisposeResult,
} from '../plugin-runtime/pluginScope.ts'

export type {
  CommandDefinition,
  CommandExecutionContext,
  CommandDescriptor,
  CommandFilter,
  CommandRegisterOptions,
} from '../plugin-runtime/commands/commandRegistry.ts'
export type { PluginCommandApi as CommandApi } from '../plugin-runtime/commands/pluginCommandApi.ts'
export type { PluginApplicationApi } from '../plugin-runtime/application/pluginApplicationApi.ts'
export type { PluginWorkspaceApi } from '../plugin-runtime/workspaces/pluginWorkspaceApi.ts'
export type { PluginServiceApi } from '../plugin-runtime/services/pluginServiceApi.ts'
export type { PluginSidebarApi } from '../plugin-runtime/sidebar/pluginSidebarApi.ts'
export type { PluginFileWorkbenchApi } from '../plugin-runtime/file-workbench/pluginFileWorkbenchApi.ts'
export type { PluginContextPanelApi } from '../plugin-runtime/context-panel/pluginContextPanelApi.ts'
export type { PluginFontApi } from '../plugin-runtime/fonts/pluginFontApi.ts'
export type { PluginSessionCreationApi } from '../plugin-runtime/session-creation/pluginSessionCreationApi.ts'
export type { PluginInterfaceModeApi } from '../plugin-runtime/interface-mode/pluginInterfaceModeApi.ts'
export type { PluginTitlebarApi } from '../plugin-runtime/titlebar/pluginTitlebarApi.ts'
export type { PluginStorageApi } from '../plugin-runtime/storage/pluginStorageTypes.ts'

export type {
  HookName,
  HookMode,
  HookExecution,
  HookFailurePolicy,
  HookInvocationContext,
  HookActionResult,
  HookDefinition,
  HookInvocationResult,
} from '../plugin-runtime/hooks/hookTypes.ts'
export type { PluginHookApi } from '../plugin-runtime/hooks/pluginHookApi.ts'

export type {
  PluginUiSurface,
  PluginUiEventBridge,
  PluginUiUnmount,
  PluginUiFramework,
} from '../plugin-runtime/ui/pluginUiTypes.ts'
export type { PluginUiApi } from '../plugin-runtime/ui/pluginUiApi.ts'

export type { WorkspaceTypeDefinition } from '../workspace-sheets/workspaceTypes.ts'
export type {
  CodeHighlighterDefinition,
  RendererApi,
} from '../plugin-runtime/renderers/rendererRegistry.ts'
export type {
  PluginPresentationApi,
} from '../plugin-runtime/presentation/pluginPresentationApi.ts'
export type { PresentationProfileContribution } from '../plugin-runtime/presentation/presentationProfileTypes.ts'
export type {
  PluginSettingsPageContribution,
  PluginSettingOptionsContribution,
  PluginSettingValue,
} from '../plugin-runtime/settings/pluginSettingsTypes.ts'
export type { PluginSettingsApi } from '../plugin-runtime/settings/pluginSettingsApi.ts'
/** Framework-neutral settings schema/adapter contract for plugin pages and
 * context panels. Renderer-prefixed names remain available as compatibility
 * aliases from the same module. */
export type {
  SettingsSchema,
  SettingsField,
  SettingsValue,
  SettingsValueAdapter,
  RendererSettingsSchema,
  RenderSettingField,
  RendererSettingValue,
  RendererSettingOption,
  RendererSettingsPlacement,
} from '../plugin-runtime/renderers/rendererSettingsTypes.ts'
export type { SettingsTarget } from '../plugin-runtime/settings/settingsTargetGrammar.ts'
export {
  validateSettingsTarget,
  stringifySettingsTarget,
  parseSettingsTarget,
} from '../plugin-runtime/settings/settingsTargetGrammar.ts'
export type {
  FontContribution,
  FontRole,
} from '../plugin-runtime/fonts/fontContributionTypes.ts'
export type { PluginSessionsApi, PluginTurnsApi } from '../plugin-runtime/sessionData/pluginSessionDataApi.ts'
export type {
  SessionCreationContribution,
  SessionCreationCompiler,
  SessionCreationArtifactHandler,
} from '../plugin-runtime/session-creation/sessionCreationTypes.ts'
export type { PluginProcessApi, PluginProcessHandle } from '../plugin-runtime/process/processTypes.ts'
export type { PluginServiceContribution, PluginServiceKind } from '../plugin-runtime/services/pluginServiceRegistry.ts'
export type { AgentSidebarContribution } from '../plugin-runtime/sidebar/sidebarTypes.ts'
export type { ContextPanelContribution } from '../plugin-runtime/context-panel/contextPanelTypes.ts'
export type { FileWorkbenchContribution } from '../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

// ── 运行时值 ──
export { VISUAL_SEMANTIC_TOKENS, VISUAL_SEMANTIC_ROLE_TOKENS } from '../domains/theme/visualSemantics.ts'
export {
  PYLON_PLUGIN_API_MIN,
  /** @deprecated 语义是最低接受版本，改用 PYLON_PLUGIN_API_MIN */
  PYLON_PLUGIN_API_VERSION,
  PYLON_PLUGIN_API_LATEST,
  PYLON_PLUGIN_API_SUPPORTED,
  PYLON_PLUGIN_MANIFEST_FILE,
}
export { PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from '../plugin-runtime/storage/pluginStorageContract.ts'

/** Gives plugin entry modules a checked, inference-friendly lifecycle definition. */
export function definePlugin(module: PackagePluginModule): PackagePluginModule {
  if (!module || typeof module.activate !== 'function') {
    throw new Error('API 1.0 插件入口必须导出 activate')
  }
  for (const name of ['prepare', 'suspend', 'resume', 'deactivate'] as const) {
    if (module[name] !== undefined && typeof module[name] !== 'function') {
      throw new Error(`插件生命周期 ${name} 必须是函数`)
    }
  }
  return Object.freeze({ ...module })
}

/** Parses and validates the package's pylon-plugin.json API 1.0 manifest. */
export function validatePluginManifest(value: unknown): PylonPluginManifest {
  return parsePylonPluginManifest(value)
}

// ── 日志 helper ──
export interface PluginLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** 统一 `[pluginId]` 前缀的 console 封装（琥珀色标签，宿主控制台可读性一致）。 */
export function createPluginLogger(pluginId: string): PluginLogger {
  const prefix = `%c[${pluginId}]`
  const style = 'color:#e2a24a;font-weight:700'
  return {
    info: (...args) => console.info(prefix, style, ...args),
    warn: (...args) => console.warn(prefix, style, ...args),
    error: (...args) => console.error(prefix, style, ...args),
  }
}

// ── 设置页 Surface helper ──
export type SettingsSurfaceField =
  | { type: 'text'; key: string; label: string; hint?: string; placeholder?: string; multiline?: boolean }
  | { type: 'toggle'; key: string; label: string; hint?: string }
  | { type: 'number'; key: string; label: string; hint?: string; min?: number; max?: number; step?: number }
  | { type: 'select'; key: string; label: string; hint?: string; options: readonly { value: string; label: string }[] }

export type SettingsSurfaceValues = Readonly<Record<string, unknown>>

export interface SettingsSurfaceDefinition {
  /** surface id（须与 settings.registerPage 的 surfaceId 一致）。 */
  id: string
  /** 控件清单（渲染顺序即声明顺序）。 */
  fields: readonly SettingsSurfaceField[]
  /** 顶部说明（可选）。 */
  description?: string
  /** 任一字段提交后回调（含乐观本地值；宿主持久化回流会再次触发 host:input）。 */
  onChange?: (key: string, value: unknown, values: SettingsSurfaceValues) => void
}

/**
 * 把 §6.10 设置页协议（host:input 进 / settings:set·settings:remove 出）封装成
 * 声明式字段清单，输出可直接交给 `context.settings.registerPage` 的隔离
 * PluginUiSurface。纯 DOM 渲染，不依赖任何框架；样式消费宿主语义 token。
 */
export function createSettingsSurface(definition: SettingsSurfaceDefinition): PluginUiSurface {
  return {
    id: definition.id,
    mount(container: HTMLElement, bridge: PluginUiEventBridge): PluginUiUnmount {
      let values: Record<string, unknown> = {}
      let disposed = false

      const submit = (key: string, value: unknown) => {
        values = { ...values, [key]: value }
        bridge.emit('settings:set', { key, value })
        definition.onChange?.(key, value, values)
      }

      const controlFor = (field: SettingsSurfaceField): HTMLElement => {
        const current = values[field.key]
        if (field.type === 'toggle') {
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.checked = current === true
          box.addEventListener('change', () => submit(field.key, box.checked))
          return box
        }
        if (field.type === 'select') {
          const select = document.createElement('select')
          for (const option of field.options) {
            const el = document.createElement('option')
            el.value = option.value
            el.textContent = option.label
            select.append(el)
          }
          select.value = typeof current === 'string' ? current : (field.options[0]?.value ?? '')
          select.addEventListener('change', () => submit(field.key, select.value))
          return select
        }
        if (field.type === 'number') {
          const num = document.createElement('input')
          num.type = 'number'
          if (typeof current === 'number') num.value = String(current)
          if (field.min !== undefined) num.min = String(field.min)
          if (field.max !== undefined) num.max = String(field.max)
          if (field.step !== undefined) num.step = String(field.step)
          num.addEventListener('change', () => {
            const parsed = Number(num.value)
            if (Number.isFinite(parsed)) submit(field.key, parsed)
          })
          return num
        }
        const text = document.createElement(field.multiline ? 'textarea' : 'input')
        if (text instanceof HTMLInputElement) text.type = 'text'
        if (field.placeholder) text.placeholder = field.placeholder
        text.value = typeof current === 'string' ? current : ''
        // text 在 change（blur/Enter）提交；input 只做本地预览
        text.addEventListener('input', () => { values = { ...values, [field.key]: text.value } })
        text.addEventListener('change', () => submit(field.key, text.value))
        return text
      }

      const render = () => {
        if (disposed) return
        container.replaceChildren()
        const root = document.createElement('div')
        root.className = 'plugin-sdk-settings'
        if (definition.description) {
          const head = document.createElement('p')
          head.className = 'plugin-sdk-settings__description'
          head.textContent = definition.description
          root.append(head)
        }
        for (const field of definition.fields) {
          const label = document.createElement('label')
          label.className = 'plugin-sdk-settings__field'
          const name = document.createElement('span')
          name.className = 'plugin-sdk-settings__label'
          name.textContent = field.label
          const control = controlFor(field)
          label.append(name, control)
          if (field.hint) {
            const hint = document.createElement('span')
            hint.className = 'plugin-sdk-settings__hint'
            hint.textContent = field.hint
            label.append(hint)
          }
          root.append(label)
        }
        container.append(root)
      }

      const offInput = bridge.on('host:input', (detail: unknown) => {
        const input = detail as { values?: Record<string, unknown> } | null
        if (input && input.values && typeof input.values === 'object') {
          values = { ...input.values }
          render()
        }
      })
      render()

      return () => {
        disposed = true
        offInput()
        container.replaceChildren()
      }
    },
  }
}
