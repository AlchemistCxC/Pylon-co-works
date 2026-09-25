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
  // Agent 启动与连接
  'agent_executable_missing',
  'agent_spawn_failed',
  'agent_initialize_failed',
  'agent_connection_timeout',
  'agent_crashed',
  'agent_runtime_unavailable',
  'no_active_agent',
  'agent_detection_refresh_cancelled',
  // Agent 探测（pylon-core 诊断码）
  'version_probe_spawn_failed',
  'version_probe_timeout',
  'version_probe_wait_failed',
  'version_probe_non_zero',
  'version_probe_empty',
  'detection_budget_exhausted',
  'unknown_detector_id',
  'candidate_limit_reached',
  'adapter_version_below_declared_minimum',
  // 会话与存储
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
  // 保留策略
  'invalid_retention_policy',
  'retention_unavailable',
  'retention_revision_conflict',
  'retention_stale_preview',
  // 用户数据
  'user_data_revision_conflict',
  'user_data_unavailable',
  'user_data_corrupt',
  'user_data_not_found',
  'invalid_owner_key',
  // 配置
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
  // ACP 传输
  'acp_error',
  'connect_error',
  'connection_closed',
  'transport_error',
  'write_timeout',
  'rpc_timeout',
  'rpc_error',
  // 其它宿主域
  'serialize_error',
  'io_error',
  'protocol_error',
  'workspace_error',
  'prism_error',
  'git_error',
  'command_error',
  // 前端语义码
  'provider.error',
  'turn.failed',
  'wire.unknown',
  'renderer.mount.failed',
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

  it('已知码按原样取回', () => {
    expect(explainErrorCode('config_revision_conflict')?.summary).toBe(
      ERROR_CODE_EXPLANATIONS.config_revision_conflict.summary,
    )
    expect(explainErrorCode('version_probe_spawn_failed')?.summary).toContain('系统拒绝执行该程序')
  })
})
