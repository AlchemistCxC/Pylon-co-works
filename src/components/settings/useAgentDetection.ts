import { useEffect, useMemo, useRef, useState } from 'react'
import { appClients } from '../../app/appClients.ts'
import { reportRuntimeDiagnostic, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { presentDetectionDiagnostic } from './agentDetectionDiagnostics.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { selectAcpRuntimeDetectorIds, type AgentDetectionDiagnostic, type AgentRuntimeCandidate, type AgentRuntimeDetectorMetadata, type AgentProviderPreflight } from '../../domains/agent/agentDetector.ts'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'

/**
 * useAgentDetection — 探测流状态机（A-V4 拆分自 AgentRuntimePanel，逻辑逐字随迁；
 * 报告原建议 reducer 化——探测是「跑一轮→全量替换结果」的单一事务，八个散落
 * useState 在此收拢为一个内聚单元，语义等同）。挂载即扫描一次，后续由
 * 「重新探测」显式触发（force 绕过后端 TTL 缓存，#325）。
 */
export function useAgentDetection(options: {
  reportPanelError: (operation: string, error: unknown, agentId?: string) => unknown
  resolvePanelError: (operation: string, agentId?: string) => void
  setFeedback: (message: string | null) => void
}) {
  const { reportPanelError, resolvePanelError, setFeedback } = options
  const [candidates, setCandidates] = useState<AgentRuntimeCandidate[]>([])
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  const [detectionDiagnostics, setDetectionDiagnostics] = useState<AgentDetectionDiagnostic[]>([])
  const [detectionElapsedMs, setDetectionElapsedMs] = useState(0)
  const [detectionPreflight, setDetectionPreflight] = useState<AgentProviderPreflight[]>([])
  const [detectionTruncated, setDetectionTruncated] = useState(false)
  const [detectionCompleted, setDetectionCompleted] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const mountedRef = useRef(true)

  /** `force` = 绕过后端三态 TTL 缓存重跑探测（用户点「重新探测」时必须为真，否则可能只是
   *  读缓存——上一版就是这样点了没反应的，#325）。 */
  const detectRuntimes = async (force = false) => {
    if (detecting) return
    setDetecting(true)
    setDetectionCompleted(false)
    try {
      const agentClient = appClients.agent()
      const registered = getPluginServiceRegistry().list<AgentRuntimeDetectorMetadata>('agent-detector')
      const detectors = registered.length > 0 ? registered : builtinAgentCatalog.detectors()
      const report = await agentClient.detectAgentRuntimes(selectAcpRuntimeDetectorIds(detectors), force)
      if (!mountedRef.current) return
      setCandidates(report.candidates)
      setSelectedCandidateId(current => report.candidates.some(candidate => candidate.candidateId === current)
        ? current
        : report.candidates.find(candidate => !candidate.alreadyImportedAgentId)?.candidateId ?? report.candidates[0]?.candidateId ?? null)
      setDetectionDiagnostics(report.diagnostics)
      // #116 子项 10：诊断原文（内部码 + 系统级错误串）不再进 UI，改报进运行日志
      // / Runtime sheet，保持可检索。先结清上一轮的诊断条目（本轮可能已消失），
      // 再按 code+detector 的稳定 key 覆盖式上报，避免刷新一次堆一批。
      resolveRuntimeErrors(entry => entry.key.startsWith('agent-detection:'))
      for (const diagnostic of report.diagnostics) {
        reportRuntimeDiagnostic('探测本机 Agent', new Error(presentDetectionDiagnostic(diagnostic).raw), undefined, {
          key: `agent-detection:${diagnostic.code}:${diagnostic.detectorId ?? 'all'}`,
          scope: { kind: 'app', id: 'agent-detection' },
          source: 'settings.agent-runtime',
        })
      }
      setDetectionPreflight(report.preflight)
      setDetectionElapsedMs(report.elapsedMs)
      setDetectionTruncated(report.truncated)
      setDetectionCompleted(true)
      resolvePanelError('探测本机 Agent')
    } catch (error) {
      if (!mountedRef.current) return
      reportPanelError('探测本机 Agent', error)
      setFeedback('探测失败，详情见右下角错误中心')
    } finally { if (mountedRef.current) setDetecting(false) }
  }

  useEffect(() => {
    mountedRef.current = true
    void detectRuntimes()
    // 首次进入 Agent 配置即扫描一次；后续扫描仍由“重新探测”显式触发。
    return () => { mountedRef.current = false }
  }, [])

  /**
   * #325：把探测诊断按候选归因到具体 Agent——诊断带 `candidateId`，候选带
   * `alreadyImportedAgentId`，两者在候选上合流。此前卡片只能显示「未激活」，真实
   * 失败原因（`version_probe_spawn_failed` os error 193 等）只进控制台。
   */
  const probeFailureByAgentId = useMemo(() => {
    const byCandidateId = new Map<string, AgentDetectionDiagnostic>()
    const byExecutable = new Map<string, AgentDetectionDiagnostic>()
    for (const diagnostic of detectionDiagnostics) {
      // 预算耗尽是对**全局预算**的陈述，不是这个可执行文件的事实——把它画到卡片上会让一个
      // 可能完全正常的 Agent 显示「探测失败」。它仍留在「发现的运行时」块里（#325 审查）。
      if (diagnostic.code === 'detection_budget_exhausted') continue
      if (diagnostic.candidateId) byCandidateId.set(diagnostic.candidateId, diagnostic)
      if (diagnostic.executable) byExecutable.set(diagnostic.executable.toLowerCase(), diagnostic)
    }
    const byAgentId = new Map<string, AgentDetectionDiagnostic>()
    for (const candidate of candidates) {
      const agentId = candidate.alreadyImportedAgentId
      if (!agentId) continue
      // 身份折叠会把同一 Agent 的多种可执行形式合成一个候选，失败那个形式的 candidateId
      // 可能已不在报告里——此时按可执行文件路径回退匹配（Windows 路径大小写不敏感）。
      const diagnostic = byCandidateId.get(candidate.candidateId)
        ?? byExecutable.get(candidate.executable.toLowerCase())
      if (diagnostic && !byAgentId.has(agentId)) byAgentId.set(agentId, diagnostic)
    }
    return byAgentId
  }, [candidates, detectionDiagnostics])

  return {
    candidates, selectedCandidateId, setSelectedCandidateId,
    detectionDiagnostics, detectionElapsedMs, detectionPreflight, detectionTruncated, detectionCompleted,
    detecting, detectRuntimes, probeFailureByAgentId,
  }
}
