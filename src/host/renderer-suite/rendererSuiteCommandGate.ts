import type { WorkbenchCommandPort, WorkbenchCommandResult } from '../../renderers/solid-workbench/workbenchHostPort.ts'

export interface RendererSuiteCommandGate {
  readonly isActive: () => boolean
  activate(): void
  deactivate(): void
  bind(delegate: WorkbenchCommandPort): WorkbenchCommandPort
}

const COMMANDS: readonly (keyof WorkbenchCommandPort)[] = [
  'prompt', 'send', 'cancel', 'attach', 'setModel', 'setMode', 'createSession', 'compact', 'exportSession', 'clearSession',
  'toolAction', 'respondInteraction', 'openResource', 'revealResource', 'copy', 'retry', 'recover',
]

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
