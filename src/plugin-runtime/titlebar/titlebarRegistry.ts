import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { AsyncDisposable, RegisterOptions } from '../registry/types.ts'
import type { TitlebarContribution, TitlebarSlot } from './titlebarTypes.ts'

/** 槽位封闭词表：拼错一个槽会让贡献安静地永不渲染，注册期就拒绝。 */
const TITLEBAR_SLOTS: readonly TitlebarSlot[] = ['left-rail', 'workspace', 'center', 'app-actions', 'app-menu']

/**
 * 注册期校验（fail-closed，任一不满足即拒绝注册）。
 *
 * 与左栏注册表同一条纪律：「点了没处去」「槽位拼错」这类死路在注册期拦下，不留到用户点击时
 * 才发现没反应。`app-menu` 与 `command` 是一对**互相绑定**的取值——只有菜单项是数据化的，
 * 也只有菜单项能执行命令。
 */
function validateContribution(contribution: TitlebarContribution): TitlebarContribution {
  // 契约里的 slot↔renderKind 配对由类型表达，但注册方是**插件运行时里的 JS**，类型不设防；
  // 这里按字符串读一次，配对错了就拒绝。
  const slot = (contribution as { slot?: unknown }).slot
  const renderKind = (contribution as { renderKind?: unknown }).renderKind
  const commandId = (contribution as { commandId?: unknown }).commandId
  if (!contribution.id || contribution.id !== contribution.id.trim()) {
    throw new Error('Titlebar contribution id 必须是非空且无首尾空格的字符串')
  }
  if (typeof contribution.label !== 'string' || !contribution.label.trim()) {
    throw new Error(`Titlebar contribution label 不能为空：${contribution.id}`)
  }
  if (typeof slot !== 'string' || !TITLEBAR_SLOTS.includes(slot as TitlebarSlot)) {
    throw new Error(`Titlebar contribution slot 非法（只能是 ${TITLEBAR_SLOTS.join(' / ')}）：${contribution.id}`)
  }
  if (slot === 'app-menu') {
    if (renderKind !== 'command') {
      throw new Error(`Titlebar slot=app-menu 必须配 renderKind='command'：${contribution.id}`)
    }
    if (typeof commandId !== 'string' || !commandId.trim()) {
      throw new Error(`Titlebar 菜单项 commandId 不能为空（点了没处去是死路）：${contribution.id}`)
    }
  } else if (renderKind === 'command') {
    throw new Error(`renderKind='command' 只用于 slot='app-menu'：${contribution.id}`)
  }
  if (contribution.renderKind === 'first-party-react' && typeof contribution.component !== 'function' && typeof contribution.component !== 'object') {
    throw new Error(`Titlebar first-party component 非法：${contribution.id}`)
  }
  if (contribution.renderKind === 'isolated-surface' && !contribution.surfaceId.trim()) {
    throw new Error(`Titlebar isolated surfaceId 不能为空：${contribution.id}`)
  }
  return Object.freeze({ ...contribution })
}

/** Reactive registry for application-shell titlebar contributions. */
export class TitlebarRegistry extends ReactiveRegistryStore<TitlebarContribution> {
  override register(owner: PluginIdentity, value: TitlebarContribution, options: RegisterOptions): AsyncDisposable {
    return super.register(owner, validateContribution(value), options)
  }
}
