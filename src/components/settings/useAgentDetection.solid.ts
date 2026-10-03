import { createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { reportRuntimeDiagnostic, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import { presentDetectionDiagnostic } from './agentDetectionDiagnostics.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { selectAcpRuntimeDetectorIds, type AgentDetectionDiagnostic, type AgentRuntimeCandidate, type AgentRuntimeDetectorMetadata, type AgentProviderPreflight } from '../../domains/agent/agentDetector.ts'
import { builtinAgentCatalog } from '../../domains/agent/agentCatalog.ts'

/**
 * createAgentDetection（原 useAgentDetection）— 设置页探测流程；
 * 单飞与 generation 隔离取消/卸载后的迟到结果。挂载即扫描一次，后续由
 * 「重新探测」显式触发（force 绕过后端 TTL 缓存，#325）。
 *
 * #515 W1：React hook → Solid 形态（消费者 AgentRuntimePanel.solid 直连；须在响应式
 * owner 内调用）。改写点：useRef 可变值 → 组件体普通变量（Solid 组件体只跑一次）；
 * 卸载失效钩子由 onCleanup 承担；useMemo → createMemo。
 */
export function createAgentDetection(options: {
  reportPanelError: (operation: string, error: unknown, agentId?: string) => unknown
  resolvePanelError: (operation: string, agentId?: string) => void
  setFeedback: (message: string | null) => void
}) {
  const { reportPanelError, resolvePanelError, setFeedback } = options
  const [candidates, setCandidates] = createSignal<AgentRuntimeCandidate[]>([])
  const [selectedCandidateId, setSelectedCandidateId] = createSignal<string | null>(null)
  const [detectionDiagnostics, setDetectionDiagnostics] = createSignal<AgentDetectionDiagnostic[]>([])
  const [detectionElapsedMs, setDetectionElapsedMs] = createSignal(0)
  const [detectionPreflight, setDetectionPreflight] = createSignal<AgentProviderPreflight[]>([])
  const [detectionTruncated, setDetectionTruncated] = createSignal(false)
  const [detectionCompleted, setDetectionCompleted] = createSignal(false)
  const [detecting, setDetecting] = createSignal(false)
  // 组件体只跑一次：mounted/generation/in-flight 用普通可变变量（原 useRef）。
  let mounted = true
  let generation = 0
  let inFlight = false
  let cancellation: Promise<unknown> | null = null

  /** `force` = 绕过后端三态 TTL 缓存重跑探测（用户点「重新探测」时必须为真，否则可能只是
   *  读缓存——上一版就是这样点了没反应的，#325）。 */
  const detectRuntimes = async (force = false) => {
    if (inFlight) return
    inFlight = true
    const currentGeneration = ++generation
    const isCurrent = () => mounted && generation === currentGeneration
    setDetecting(true)
    setDetectionCompleted(false)
    try {
      // Finish cancelling the previous backend scan before starting another one.
      // Otherwise a late cancel IPC can cancel the newly requested scan.
      await cancellation
      if (!isCurrent()) return
      const agentClient = appClients.agent()
      const registered = getPluginServiceRegistry().list<AgentRuntimeDetectorMetadata>('agent-detector')
      const detectors = registered.length > 0 ? registered : builtinAgentCatalog.detectors()
      const report = await agentClient.detectAgentRuntimes(selectAcpRuntimeDetectorIds(detectors), force)
      if (!isCurrent()) return
      setCandidates(report.candidates)
      setSelectedCandidateId(current => report.candidates.some(candidate => candidate.candidateId === current)
        ? current
        : report.candidates.find(candidate => !candidate.alreadyImportedAgentId && candidate.startability === 'verified')?.candidateId
          ?? report.candidates.find(candidate => !candidate.alreadyImportedAgentId)?.candidateId ?? report.candidates[0]?.candidateId ?? null)
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
      if (!isCurrent()) return
      reportPanelError('探测本机 Agent', error)
      setFeedback('探测失败，详情见右下角错误中心')
    } finally { if (isCurrent()) { inFlight = false; setDetecting(false) } }
  }

  const cancelDetection = () => {
    if (!inFlight) return
    generation++
    inFlight = false
    setDetecting(false)
    setFeedback('探测已取消。可以重新探测或手动添加。')
    cancellation = appClients.agent().cancelDetectionRefresh().catch(error => reportPanelError('取消 Agent 探测', error))
  }

  // 首次进入 Agent 配置即扫描一次；后续扫描仍由“重新探测”显式触发。
  onMount(() => { void detectRuntimes() })
  // 卸载使全部在途结果失效（isCurrent 闭包读 mounted/generation）。
  onCleanup(() => { mounted = false; generation++; inFlight = false })

  /**
   * #325：把探测诊断按候选归因到具体 Agent——诊断带 `candidateId`，候选带
   * `alreadyImportedAgentId`，两者在候选上合流。此前卡片只能显示「未激活」，真实
   * 失败原因（`version_probe_spawn_failed` os error 193 等）只进控制台。
   */
  const probeFailureByAgentId = createMemo(() => {
    const byCandidateId = new Map<string, AgentDetectionDiagnostic>()
    const byExecutable = new Map<string, AgentDetectionDiagnostic>()
    for (const diagnostic of detectionDiagnostics()) {
      // 预算耗尽是对**全局预算**的陈述，不是这个可执行文件的事实——把它画到卡片上会让一个
      // 可能完全正常的 Agent 显示「探测失败」。它仍留在「发现的运行时」块里（#325 审查）。
      // A version timeout/unsupported flag is not an ACP launch failure.
      if (diagnostic.code !== 'version_probe_spawn_failed') continue
      if (diagnostic.candidateId) byCandidateId.set(diagnostic.candidateId, diagnostic)
      if (diagnostic.executable) byExecutable.set(diagnostic.executable.toLowerCase(), diagnostic)
    }
    const byAgentId = new Map<string, AgentDetectionDiagnostic>()
    for (const candidate of candidates()) {
      const agentId = candidate.alreadyImportedAgentId
      if (!agentId) continue
      // 身份折叠会把同一 Agent 的多种可执行形式合成一个候选，失败那个形式的 candidateId
      // 可能已不在报告里——此时按可执行文件路径回退匹配（Windows 路径大小写不敏感）。
      const diagnostic = byCandidateId.get(candidate.candidateId)
        ?? byExecutable.get(candidate.executable.toLowerCase())
      if (diagnostic && !byAgentId.has(agentId)) byAgentId.set(agentId, diagnostic)
    }
    return byAgentId
  })

  return {
    candidates, selectedCandidateId, setSelectedCandidateId,
    detectionDiagnostics, detectionElapsedMs, detectionPreflight, detectionTruncated, detectionCompleted,
    detecting, detectRuntimes, cancelDetection, probeFailureByAgentId,
  }
}
