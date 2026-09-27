import { describe, expect, it } from 'vitest'
import { presentDetectionDiagnostic } from '../agentDetectionDiagnostics.ts'
import { explainErrorCode } from '../../../app/errorCodeExplanations.ts'
import type { AgentDetectionDiagnostic } from '../../../domains/agent/agentDetector.ts'

/**
 * #116 子项 10：Agent 探测诊断的呈现口径。
 * 实测原文示例来自运行中实例（Agent 设置页「发现与管理」）。
 */

const REAL_SPAWN_FAILURE: AgentDetectionDiagnostic = {
  code: 'version_probe_spawn_failed',
  stage: 'version_probe',
  detectorId: 'builtin.detector.hermes',
  message: '无法执行 C:\\Users\\AlchemistCxC\\.local\\bin\\hermes 版本探针: %1 不是有效的 Win32 应用程序。 (os error 193)',
  retryable: true,
}

describe('presentDetectionDiagnostic（#116 子项 10）', () => {
  it('用户可见文本不含内部码与系统级原文，只留探测 / 候选 / 本地化原因', () => {
    const { text } = presentDetectionDiagnostic(REAL_SPAWN_FAILURE)
    expect(text).toContain('版本探测')
    expect(text).toContain('C:\\Users\\AlchemistCxC\\.local\\bin\\hermes')
    expect(text).toContain('无法执行该程序')
    expect(text).not.toMatch(/version_probe/)
    expect(text).not.toMatch(/os error|%1|Win32/)
  })

  it('原文完整保留在 raw（交给运行日志 / Runtime sheet）', () => {
    const { raw } = presentDetectionDiagnostic(REAL_SPAWN_FAILURE)
    expect(raw).toContain('version_probe_spawn_failed')
    expect(raw).toContain('os error 193')
    expect(raw).toContain('builtin.detector.hermes')
  })

  // #325：候选路径优先取结构化字段（`executable`），不再依赖 message 文本格式。
  it('候选路径优先取结构化 executable，message 改文案也不受影响', () => {
    const { text } = presentDetectionDiagnostic({
      code: 'version_probe_spawn_failed',
      stage: 'version_probe',
      detectorId: 'builtin.detector.hermes',
      candidateId: 'hermes:abc',
      executable: 'D:\\tools\\hermes-acp.exe',
      message: '（未来的后端文案，不含路径）',
      retryable: false,
    })
    expect(text).toContain('D:\\tools\\hermes-acp.exe')
  })

  it('可重试的诊断在可见文本里标注可重试，不可重试的不标注', () => {
    expect(presentDetectionDiagnostic(REAL_SPAWN_FAILURE).text).toContain('（可重试）')
    expect(presentDetectionDiagnostic({ ...REAL_SPAWN_FAILURE, retryable: false }).text).not.toContain('（可重试）')
  })

  it('候选路径取不到时退回探测器短名，未登记阶段退回泛称（不泄漏 stage id）', () => {
    const { text } = presentDetectionDiagnostic({
      code: 'version_probe_timeout',
      stage: 'future_stage_v2',
      detectorId: 'builtin.detector.peri',
      message: '版本探针超时',
      retryable: true,
    })
    expect(text).toContain('运行时探测')
    expect(text).not.toContain('future_stage_v2')
    expect(text).toContain('peri')
    // 解释文案归全站单源码表（#325）：这里断言「用的就是那一份」，而不是抄一遍字面量。
    expect(text).toContain(explainErrorCode('version_probe_timeout')!.summary)
  })

  it('未登记诊断码走泛称而不是把 code 摆到 UI 上', () => {
    const { text } = presentDetectionDiagnostic({
      code: 'brand_new_failure',
      stage: 'version_probe',
      message: 'something happened',
      retryable: false,
    })
    expect(text).toContain('探测失败（完整原因见运行日志）')
    expect(text).not.toContain('brand_new_failure')
  })
})
