import type { WorkbenchCommandPort, WorkbenchCommandResult } from '../../renderers/solid-workbench/workbenchHostPort.ts'

export interface RendererSuiteCommandGate {
  readonly isActive: () => boolean
  activate(): void
  deactivate(): void
  bind(delegate: WorkbenchCommandPort): WorkbenchCommandPort
}

const COMMANDS = [
  'prompt', 'send', 'cancel', 'attach', 'setModel', 'setMode', 'createSession', 'compact', 'exportSession', 'clearSession',
  'setConfigOption', 'toolAction', 'respondInteraction', 'openResource', 'revealResource', 'copy', 'retry', 'recover',
] as const satisfies readonly (keyof WorkbenchCommandPort)[]

// 穷尽性守卫（编译期）：端口新增方法而白名单没跟 → MissingCommands 不再是 never，下一行 `true` 赋给 `never` 编译失败。
// `as const` 不可省——带注解的数组会把元素类型放宽成 keyof WorkbenchCommandPort，守卫会静默失效。
type MissingCommands = Exclude<keyof WorkbenchCommandPort, (typeof COMMANDS)[number]>
const _commandsAreExhaustive: MissingCommands extends never ? true : never = true
void _commandsAreExhaustive

export function createRendererSuiteCommandGate(): RendererSuiteCommandGate {
  let active = false
  const inactive = async (): Promise<WorkbenchCommandResult<unknown>> => ({
    ok: false,
    error: { code: 'renderer_not_active', message: 'Renderer Suite 尚未激活', recoverability: 'fallback' },
  })
  return {
    isActive: () => active,
    activate: () => { active = true },
    deactivate: () => { active = false },
    bind(delegate) {
      const port = {} as WorkbenchCommandPort
      for (const command of COMMANDS) {
        port[command] = ((...args: readonly unknown[]) => {
          if (!active) return inactive()
          return (delegate[command] as (...values: readonly unknown[]) => Promise<unknown>)(...args)
        }) as never
      }
      return port
    },
  }
}
