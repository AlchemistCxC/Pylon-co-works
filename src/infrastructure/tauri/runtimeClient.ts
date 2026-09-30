/**
 * runtimeClient — 运行时诊断域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * get/set_approval_mode / startup_diagnostics / list_runtime_logs / clear_runtime_logs
 * 的 command/payload 收口。
 */
import { ClientTransport } from '../acp/agentClient'
import { normalizeRuntimeLogList, normalizeStartupDiagnostics } from './runtimeLogContracts'

export function createRuntimeClient(transport: ClientTransport) {
  return {
    getApprovalMode: (): Promise<unknown> => transport.invoke('get_approval_mode'),
    setApprovalMode: (mode: string): Promise<unknown> => transport.invoke('set_approval_mode', { mode }),
    /**
     * #448 PR4：审批模式持久层探询（user_data_load 的 approval-mode 行）。
     * null = 后端从未存过（首次启动）→ 前端 localStorage 进入「首次种子」分支；
     * 非 null = 后端权威在场（启动时 permission::restore_persisted_approval_mode
     * 已回填内存态），payload.mode 即当前权威值。
     */
    loadApprovalModePersisted: (): Promise<unknown> => transport.invoke('user_data_load', { key: 'approval-mode' }),
    startupDiagnostics: (): Promise<unknown> => transport.invoke('startup_diagnostics').then(normalizeStartupDiagnostics),
    listRuntimeLogs: (): Promise<unknown> => transport.invoke('list_runtime_logs').then(normalizeRuntimeLogList),
    clearRuntimeLogs: (): Promise<unknown> => transport.invoke('clear_runtime_logs'),
    /** B2：RuntimeSheet 挂载/卸载驱动后端 live 推送闸门。 */
    setRuntimeLogLive: (enabled: boolean): Promise<unknown> => transport.invoke('set_runtime_log_live', { enabled }),
    /** A-V2\uFF1AAppData \u2192 \u4FBF\u643A\u76EE\u5F55\u4E00\u6B21\u6027\u8FC1\u79FB\uFF08Overview \u5B58\u50A8\u8FC1\u79FB\u5165\u53E3\uFF09\u3002 */
    migrateAppdataToPortable: (): Promise<unknown> => transport.invoke('migrate_appdata_to_portable'),
  }
}

export type RuntimeClient = ReturnType<typeof createRuntimeClient>
