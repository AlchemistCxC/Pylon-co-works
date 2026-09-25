import type { AgentDetectionDiagnostic } from '../../domains/agent/agentDetector.ts'
import { explainErrorCode } from '../../errorCodeExplanations.ts'

/**
 * #116 子项 10：Agent 探测诊断的**呈现口径**。
 *
 * 后端 `AgentDetectionDiagnostic` 是给机器看的：`code` 是内部码（`version_probe_*`），
 * `message` 里嵌着内核原文（`%1 不是有效的 Win32 应用程序。 (os error 193)`）与
 * 绝对路径。原先面板把它们原样插值进 UI，中文界面上出现整段系统级英文与错误码。
 *
 * 本模块只做呈现映射，**不改探测算法**（那是 Rust 域，见 issue 边界）：
 * - 用户可见：`哪条探测 · 哪个候选 · 本地化原因`；
 * - 内部码与系统级原文经 `raw` 交给运行日志 / Runtime sheet，UI 不再出现。
 */

/** 探测阶段 → 可读名。未知阶段一律落到泛称，避免内部 stage id 泄漏。 */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  version_probe: '版本探测',
}
const STAGE_FALLBACK = '运行时探测'

/**
 * 内部诊断码 → 本地化失败原因。
 *
 * 解释取自全站单源码表 `src/errorCodeExplanations.ts`（#325）——此前这里是该词表的
 * 手抄副本，两处各自漂移无人看守。表里没有的码走泛称，绝不把内部码摆到 UI 上。
 */
const REASON_FALLBACK = '探测失败（完整原因见运行日志）'
const reasonFor = (code: string) => explainErrorCode(code)?.summary ?? REASON_FALLBACK

/** 后端 message 里的候选路径（`无法执行 <exe> 版本探针: …`）。 */
const CANDIDATE_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\s:：]+/

/** 候选路径取不到时退回探测器的短名（`builtin.detector.hermes` → `hermes`）。 */
function detectorShortName(detectorId: string | undefined): string | undefined {
  if (!detectorId) return undefined
  const segments = detectorId.split('.')
  return segments[segments.length - 1] || undefined
}

export interface DetectionDiagnosticPresentation {
  /** 用户可见一行：`版本探测 · C:\…\hermes · 系统拒绝执行该程序（不是有效的可执行文件）`。 */
  readonly text: string
  /** 原文（含内部码与系统级细节），只进日志 / Runtime sheet，不进 UI。 */
  readonly raw: string
}

export function presentDetectionDiagnostic(
  diagnostic: AgentDetectionDiagnostic,
): DetectionDiagnosticPresentation {
  const stage = STAGE_LABELS[diagnostic.stage] ?? STAGE_FALLBACK
  const candidate = CANDIDATE_PATTERN.exec(diagnostic.message)?.[0]
    ?? detectorShortName(diagnostic.detectorId)
  const reason = reasonFor(diagnostic.code)
  const detail = diagnostic.retryable ? `${reason}（可重试）` : reason
  return {
    text: [stage, candidate, detail].filter((part): part is string => Boolean(part)).join(' · '),
    raw: `${diagnostic.code}（${diagnostic.stage}${diagnostic.detectorId ? ` · ${diagnostic.detectorId}` : ''}）：${diagnostic.message}`,
  }
}
