/**
 * runtimeClient — 运行时诊断域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * set_approval_mode / startup_diagnostics / list_runtime_logs / clear_runtime_logs
 * 的 command/payload 收口。
 */
import { ClientTransport } from '../acp/agentClient'
import { normalizeRuntimeLogList, normalizeStartupDiagnostics } from './runtimeLogContracts'

export function createRuntimeClient(transport: ClientTransport) {
  return {
    setApprovalMode: (mode: string): Promise<unknown> => transport.invoke('set_approval_mode', { mode }),
    startupDiagnostics: (): Promise<unknown> => transport.invoke('startup_diagnostics').then(normalizeStartupDiagnostics),
    listRuntimeLogs: (): Promise<unknown> => transport.invoke('list_runtime_logs').then(normalizeRuntimeLogList),
    clearRuntimeLogs: (): Promise<unknown> => transport.invoke('clear_runtime_logs'),
    /** B2：RuntimeSheet 挂载/卸载驱动后端 live 推送闸门。 */
    setRuntimeLogLive: (enabled: boolean): Promise<unknown> => transport.invoke('set_runtime_log_live', { enabled }),
  }
}

export type RuntimeClient = ReturnType<typeof createRuntimeClient>
