/**
 * cwd 分区插件扩展点（工作区级插件）。
 *
 * - cwd.hook：工作区级生命周期 hook。cwd 配置可勾选启用哪些 hook 插件；
 *   会话在 cwd 下创建时继承 hookPluginIds 快照，运行时按现有 agent.hook 管线执行。
 * - cwd.panel：cwd 设置面板扩展。插件可贡献设置区块元数据，cwd 设置 UI 按贡献渲染。
 */
import type { HookContext, HookPhase, HookResult } from './agentHook.ts'

/** cwd.hook 贡献 impl：复用 agent.hook 的 phase 语义（工作区级插件同构）。 */
export interface CwdHookProvider {
  readonly providerId: string
  readonly label: string
  readonly phases: readonly HookPhase[]
  readonly description?: string
  run(context: HookContext): HookResult | Promise<HookResult>
}

/** cwd.panel 贡献 impl：cwd 设置面板里的一个只读区块（第一版元数据型）。 */
export interface CwdPanelProvider {
  readonly providerId: string
  readonly label: string
  readonly panelKind: 'config' | 'status' | 'actions'
}
