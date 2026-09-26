import { describe, expect, it } from 'vitest'
import { ERROR_CODE_EXPLANATIONS, explainErrorCode } from '../errorCodeExplanations.ts'

/**
 * 码表稳定性看守（#325，参照 `pylon-acp/src/error.rs` 的 `wire_codes_are_stable_and_machine_readable`
 * 与 `src/obs06/__tests__/deleteErrorForensics.test.ts` 的封闭词表先例）。
 *
 * 这张表是错误码解释的**单源**：改动要么是有意扩充（那就同步改本用例的期望集），
 * 要么是误改（这里红灯）。解释文案本身不逐字钉（会随语气调整），只钉「每个码都有解释、
 * 解释不是空串、状态词集合精确」。
 */
const EXPECTED_CODES = [
  'agent_executable_missing',
  'agent_spawn_failed',
  'agent_initialize_failed',
  'agent_connection_timeout',
  'agent_crashed',
  'agent_runtime_unavailable',
  'no_active_agent',
  'agent_spawn_io_failed',
  'writer_failed',
  'stdout_closed',
  'pending_lock_poisoned',
  'overloaded',
  'version_probe_spawn_failed',
  'version_probe_timeout',
  'version_probe_wait_failed',
  'version_probe_non_zero',
  'version_probe_empty',
  'detection_budget_exhausted',
  'unknown_detector_id',
  'candidate_limit_reached',
  'adapter_version_below_declared_minimum',
  'session_not_found',
  'session_binding_unavailable',
  'session_deleted',
  'event_session_deleted',
  'event_revision_conflict',
  'event_repo_corrupt',
  'event_repo_constraint',
  'event_repo_conflict',
  'event_db_unavailable',
  'event_invalid',
  'message_repo_corrupt',
  'message_repo_constraint',
  'message_repo_conflict',
  'message_db_unavailable',
  'replay_truncated',
  'replay_load_in_progress',
  'replay_timeout',
  'replay_lag',
  'replay_transport_error',
  'database_future_schema',
  'database_schema_invalid',
  'database_integrity_failed',
  'invalid_retention_policy',
  'retention_unavailable',
  'retention_revision_conflict',
  'retention_stale_preview',
  'user_data_revision_conflict',
  'user_data_unavailable',
  'user_data_corrupt',
  'user_data_not_found',
  'invalid_owner_key',
  'config_error',
  'config_read_error',
  'config_parse_error',
  'config_invalid_agent',
  'config_read_only',
  'config_write_error',
  'config_revision_conflict',
  'config_revision_required',
  'config_backup_error',
  'config_lock_busy',
  'config_active_agent_protected',
  'config_not_applied',
  'acp_error',
  'connect_error',
  'connection_closed',
  'transport_error',
  'write_timeout',
  'rpc_timeout',
  'rpc_error',
  'serialize_error',
  'io_error',
  'protocol_error',
  'workspace_error',
  'prism_error',
  'git_error',
  'command_error',
  'provider.error',
  'turn.failed',
  'wire.unknown',
  'renderer.slot.mount.failed',
  'renderer.slot.runtime.failed',
  'application_mount_failed',
  'gateway_adapter_unavailable',
  'gateway_config_lock_poisoned',
  'gateway_delivery_failed',
  'gateway_instance_not_connected',
  'gateway_instance_not_found',
  'gateway_invalid_config',
  'adapter_unavailable',
  'route_in_use',
  'invalid_transition',
  'instance_not_found',
  'instance_store_corrupt',
  'instance_store_io',
  'instance_store_write_failed',
  'credential_missing',
  'credential_corrupt',
  'credential_io',
  'credential_key_unavailable',
  'credential_store_error',
  'plugin_not_found',
  'plugin_invalid_id',
  'plugin_manifest_invalid',
  'plugin_io',
  'plugin_resource_invalid',
  'plugin_source_invalid',
  'plugin_state_conflict',
  'plugin_transaction_failed',
] as const

describe('errorCodeExplanations（#325 码表单源）', () => {
  it('码集合精确稳定：扩充要显式改期望集，误改这里红灯', () => {
    expect(Object.keys(ERROR_CODE_EXPLANATIONS).sort()).toEqual([...EXPECTED_CODES].sort())
  })

  it('每个码都有非空解释，hint 若存在也必须非空', () => {
    for (const [code, explanation] of Object.entries(ERROR_CODE_EXPLANATIONS)) {
      expect(explanation.summary.trim(), `${code} 缺解释`).not.toBe('')
      if (explanation.hint !== undefined) expect(explanation.hint.trim(), `${code} 的 hint 是空串`).not.toBe('')
    }
  })

  it('解释不泄漏内部标识符本身（用户不再看到一串码的解释成「另一个码」）', () => {
    for (const [code, explanation] of Object.entries(ERROR_CODE_EXPLANATIONS)) {
      expect(explanation.summary).not.toContain(code)
    }
  })

  it('未知码返回 null，界面保留原文而不是编造解释', () => {
    expect(explainErrorCode('brand_new_failure')).toBeNull()
    expect(explainErrorCode(undefined)).toBeNull()
    expect(explainErrorCode(null)).toBeNull()
    expect(explainErrorCode('')).toBeNull()
  })

  it('已知码取回的就是表里那条解释（字面量钉一条，防措辞被无声改掉）', () => {
    expect(explainErrorCode('config_revision_conflict')?.summary).toBe('配置文件已被别处改动，本次保存基于旧版本')
    expect(explainErrorCode('version_probe_spawn_failed')?.summary).toContain('无法执行该程序')
    expect(explainErrorCode('provider.error')?.summary).toBe(ERROR_CODE_EXPLANATIONS['provider.error'].summary)
  })
})

describe('errorCodeExplanations（#338 恢复动作同源派生）', () => {
  const KINDS = ['open-agent-settings', 'select-agent-executable', 'open-runtime-log'] as const

  it('标注的 recovery 值必须属于合法 kind 集合', () => {
    for (const [code, explanation] of Object.entries(ERROR_CODE_EXPLANATIONS)) {
      if (explanation.recovery !== undefined) {
        expect(KINDS, `${code} 的 recovery 不是合法 kind`).toContain(explanation.recovery)
      }
    }
  })

  it('关键码 → kind 映射钉死（错配回归即红灯）', () => {
    // 可执行文件不存在 → 选择可执行文件
    expect(ERROR_CODE_EXPLANATIONS['agent_executable_missing'].recovery).toBe('select-agent-executable')
    expect(ERROR_CODE_EXPLANATIONS['version_probe_spawn_failed'].recovery).toBe('select-agent-executable')
    // 配置只读/写失败与配置域 → 打开 Agent 设置
    for (const code of ['config_read_only', 'config_write_error', 'config_parse_error', 'no_active_agent']) {
      expect(ERROR_CODE_EXPLANATIONS[code].recovery, code).toBe('open-agent-settings')
    }
    // 传输/初始化失败 → 查看运行日志（显式入表，不依赖兜底）
    for (const code of ['agent_spawn_failed', 'agent_initialize_failed', 'agent_connection_timeout', 'transport_error', 'connect_error']) {
      expect(ERROR_CODE_EXPLANATIONS[code].recovery, code).toBe('open-runtime-log')
    }
  })

  it('recoveryForCode：查表命中即表值，查表无果（含无码）兜底查看运行日志', async () => {
    const { recoveryForCode } = await import('../runtimeError.ts')
    expect(recoveryForCode('agent_executable_missing', 'peri-1')).toEqual({ kind: 'select-agent-executable', agentId: 'peri-1' })
    expect(recoveryForCode('config_read_only')).toEqual({ kind: 'open-agent-settings' })
    expect(recoveryForCode('user_data_unavailable')).toEqual({ kind: 'open-runtime-log' })
    expect(recoveryForCode(undefined)).toEqual({ kind: 'open-runtime-log' })
    expect(recoveryForCode('brand_new_failure')).toEqual({ kind: 'open-runtime-log' })
  })
})
