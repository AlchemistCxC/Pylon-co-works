/**
 * TurnClock / kernel-liveness subsystem (P52 D3, #213, #217, ADR-0017).
 * 生成时钟唯一主人（source 隔离，事件驱动）：回合起点 = 发送入口（乐观投影）；
 * 终态 = feed 终帧（done/error/cancelled）或 canonical 终态证据（bind/refresh 时
 * journal 已终态）；拒绝发送 = 回滚。内核在途回合标记（`livenessSource: 'kernel'`
 * 的事实来源）同样归本模块持有——活性权威恒为 kernel > clock > document。
 * 快照写入只经注入的 `updateRuntimeState` 缝，本模块不直接拼文档。
 */
import { resolveKernelLiveness, type GenerationLedgerTerminalReason } from '../../domains/workbench/generationLedgerSummary.ts'
import type { PromptFailureMetadata } from '../../infrastructure/acp/chatContracts.ts'
import type { createWorkbenchRuntime } from '../../domains/workbench/workbenchRuntime.ts'

export type WorkbenchRuntime = ReturnType<typeof createWorkbenchRuntime>
export type RuntimeStatePatch = Parameters<WorkbenchRuntime['update']>[0]

export interface AgentWorkbenchTurnClockDeps {
  runtime: WorkbenchRuntime
  updateRuntimeState: (patch: RuntimeStatePatch) => void
  /** 当前绑定的 source——终态摘要与落静只作用于本绑定的 source。 */
  getSource: () => string | undefined
}

export interface AgentWorkbenchTurnClock {
  /** 回合起点（发送入口 / live echo 采纳）。新回合起点必须清空账本终态。 */
  start(targetSource: string, at: number): void
  /** 每条 live envelope 刷新活性；返回 undefined = 无活动回合（不写 patch）。 */
  touch(targetSource: string, at: number): number | undefined
  /** 终帧到达：写 live 终态摘要（elapsed = 终点 - 本进程观察到的起点）。 */
  terminal(targetSource: string, reason: 'done' | 'cancelled' | 'error', at: number, failure?: PromptFailureMetadata): void
  /** 发送被拒绝：活动回合回滚（后续帧不得复活指示器）。 */
  rollback(targetSource: string): void
  /** bind/refresh 发现 journal 已终态：封存时钟但不写摘要。 */
  settleFromDocument(targetSource: string, hasTerminal: boolean): void
  /** bind/refresh 后把活动时钟写回快照（覆盖投影间隙的 Date.now() 回退）。 */
  reconcile(targetSource: string): void
  /** #213：本 source 是否有一个未终结的回合时钟（权威活性的值）。 */
  isGenerating(targetSource: string): boolean
  /** #217：本 source 的有效活性权威——内核表态优先（kernel > clock > document）。 */
  effectiveLiveness(targetSource: string): { source: 'kernel' | 'clock'; generating: boolean }
  /** #213：`reconcile` 的对偶——权威活性说「无在途回合」时明确把快照推回静止。 */
  settleRuntimeLiveness(targetSource: string): void
  /** 空态创建路径的「仅时钟起点」记账（发送被拒时据此精确撤销）。 */
  markClockOnlyStart(targetSource: string, clientMessageId: string): void
  peekClockOnlyStart(targetSource: string): string | undefined
  hasClockOnlyStart(targetSource: string): boolean
  clearClockOnlyStart(targetSource: string): void
  /** #217：发送入口 = 派发意图——仅 Fresh化**已存在**的内核条目，不得制造权威。 */
  freshenKernelInFlight(targetSource: string): void
  /** 本 source 是否已有内核表态（有表态时 live 采纳启发式停用）。 */
  kernelAuthoritative(targetSource: string): boolean
  /** 本 source 是否存在回合时钟条目（含已终态）。 */
  hasClock(targetSource: string): boolean
  /** #217：内核在途回合事实随冷挂载快照入库（条目只由此创建）。 */
  observeKernelSnapshot(targetSource: string, ledgerTurn: unknown): void
  /** #217：账本终态是内核自己的收敛陈述——无条件落静并清除身份戳。 */
  settleKernelFromLedger(targetSource: string): void
  archiveLedgerTerminal(targetSource: string, reason: GenerationLedgerTerminalReason): void
  ledgerTerminalOf(targetSource: string): GenerationLedgerTerminalReason | undefined
  /** bind 重置读时钟：仅当条目活动且内核未表态「不在途」时返回。 */
  activeUnsettledClock(targetSource: string): { generationStart: number; lastTokenAt: number } | undefined
  clearAll(): void
}

interface TurnClockEntry {
  generationStart: number
  lastTokenAt: number
  terminal: boolean
}

/** 从冷挂载快照读回合身份戳（缺 key/字段非数值 ⇒ undefined，不猜）。 */
function kernelTurnStampOf(snapshot: unknown): string | undefined {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const turn = (snapshot as { turn?: { key?: unknown } | null }).turn
  const key = turn !== null && typeof turn === 'object' ? (turn as { key?: unknown }).key : undefined
  if (key === null || typeof key !== 'object') return undefined
  const generation = (key as { generation?: unknown }).generation
  const turnId = (key as { turnId?: unknown }).turnId
  return typeof generation === 'number' && typeof turnId === 'number'
    ? `${generation}:${turnId}`
    : undefined
}

export function createAgentWorkbenchTurnClock(deps: AgentWorkbenchTurnClockDeps): AgentWorkbenchTurnClock {
  const { runtime, updateRuntimeState, getSource } = deps
  const turnClocks = new Map<string, TurnClockEntry>()
  /**
   * 最近一次 canonical 重载读到的 #99 账本终态，按 source 隔离。
   *
   * 单独存而不是只用作 refresh 的入参：`refresh` 对同 source 会去重（`refreshInFlight`），
   * 一次早于终态收敛发起的重载可能与携带账本的那次同窗，入参会被去重丢掉。按 source
   * 保留最近观测到的终态即可让在途的那次重载用上它。
   *
   * **新回合起点必须清空**（见 `start`）：否则上一回合的终态会被当成本回合的
   * 证据，把在途的新回合判成已收敛。
   */
  const ledgerTerminalBySource = new Map<string, GenerationLedgerTerminalReason>()

  /**
   * #217/ADR-0017：内核在途回合标记，按 source 隔离（`livenessSource: 'kernel'` 的
   * 事实来源）。语义严格为「本进程已派发 prompt、尚未收到终态」。
   *
   * **条目只由 refresh（真实内核快照）创建**：`resolveKernelLiveness` 有表态才入表。
   * 本地生命周期（发送入口/终帧/回滚）只**更新已存在的条目**——它们是内核事实的
   * 及时Fresh化（派发后内核必然置位、终帧即内核收敛证据），但不得**制造**内核权威：
   * 旧内核（快照永无 `turnInFlight` 字段）的宿主必须永久保持 `'clock'` 权威，#213 的
   * 采纳启发式不能被一个前端自造的表态关闭（ADR 兼容矩阵：新前端 + 旧内核）。
   *
   * refresh 写入的新鲜度守卫：观测 false 而该 source 存在活动本地时钟时不覆盖
   * （load 链与发送竞态时本地生命周期更新；内核若真已收敛，终帧随后到达自会落静）；
   * 观测 true 而本地时钟已封存时同理不覆盖（终帧比早于它合成的快照更新——否则
   * late 快照会在终态之后复活生成态，正是 ADR 风险条款点名的故障类）。
   *
   * 无内核表态（旧内核/快照缺字段）的 source 不入表 ⇒ 活性回退 `'clock'` 权威；
   * 两条 applyLive 采纳启发式只在**有内核表态**时停用（ADR-0017 收敛推断）。
   */
  const kernelLivenessBySource = new Map<string, boolean>()

  /**
   * #217：内核回合身份戳（`${generation}:${turnId}`，取自快照 `turn.key`）。终帧
   * 不携带 turnId，但它收敛的就是「最近一次 active 快照」里的那个回合——把该身份
   * 记为 settled，此后带**同一身份**的 `turnInFlight=true` 快照即可判定为早于终态
   * 的 stale（无本地时钟的他窗回合在终帧后没有时钟可作旁证，这是唯一的判别依据）；
   * 不同身份 = 新回合，照常采纳。
   */
  const kernelTurnStamps = new Map<string, { active?: string; settled?: string }>()

  /** 空态创建路径（会话已 select、尚未 bind）在发送入口只启动了回合时钟、没有文档投影：
   *  source → 该 source 上"仅时钟起点"的 clientMessageId。发送被拒时据此精确撤销，
   *  不误伤同 source 上由外部客户端 echo 启动的回合（issue #68 配套）。 */
  const clockOnlyStarts = new Map<string, string>()

  const clock: AgentWorkbenchTurnClock = {
    start(targetSource, at) {
      turnClocks.set(targetSource, { generationStart: at, lastTokenAt: at, terminal: false })
      ledgerTerminalBySource.delete(targetSource)
    },

    touch(targetSource, at) {
      const entry = turnClocks.get(targetSource)
      if (!entry || entry.terminal) return undefined
      entry.lastTokenAt = Math.max(entry.lastTokenAt, at)
      return entry.lastTokenAt
    },

    terminal(targetSource, reason, at, failure) {
      const entry = turnClocks.get(targetSource)
      if (!entry || entry.terminal) {
        // #217：无时钟（本 source 的回合由他窗派发）或已封存——终帧仍是内核已收敛的
        // 权威证据，但只 Fresh化**已存在**的内核条目并落静快照。终帧双轨投递
        // （Channel + 广播）与本窗未绑定的 source 都会走到这里：内核条目不存在
        // （纯时钟/旧内核宿主）时保持既有 no-op 语义；settleRuntimeLiveness 自身
        // 只作用于当前绑定的 source（防跨 source 误伤）。
        if (kernelLivenessBySource.has(targetSource)) {
          kernelLivenessBySource.set(targetSource, false)
          const stamps = kernelTurnStamps.get(targetSource)
          if (stamps?.active !== undefined) kernelTurnStamps.set(targetSource, { settled: stamps.active })
          clock.settleRuntimeLiveness(targetSource)
        }
        return
      }
      entry.terminal = true
      // 回合已有终态："仅时钟起点"的记账已完成使命。
      clockOnlyStarts.delete(targetSource)
      // #217：终帧 = 内核已收敛（后端终态先于终帧发布）——内核活性事实同步落静
      // （仅更新已有条目；无内核表态的宿主不得被制造出内核权威）。
      if (kernelLivenessBySource.has(targetSource)) {
        kernelLivenessBySource.set(targetSource, false)
        const stamps = kernelTurnStamps.get(targetSource)
        if (stamps?.active !== undefined) kernelTurnStamps.set(targetSource, { settled: stamps.active })
      }
      if (getSource() !== targetSource) return
      updateRuntimeState({
        summary: {
          elapsedMs: Math.max(0, at - entry.generationStart),
          tokenCount: runtime.getSnapshot().tokenCount,
          completedFrame: '',
          reason,
          ...(failure ? { failure } : {}),
          durationSource: 'live-monotonic',
          durationAvailable: true,
        },
      })
    },

    rollback(targetSource) {
      const entry = turnClocks.get(targetSource)
      if (!entry || entry.terminal) return
      turnClocks.delete(targetSource)
      // #217：派发从未发生（或被拒）——内核在途事实同样为否（仅更新已有条目）。
      if (kernelLivenessBySource.has(targetSource)) kernelLivenessBySource.set(targetSource, false)
    },

    settleFromDocument(targetSource, hasTerminal) {
      if (!hasTerminal) return
      const entry = turnClocks.get(targetSource)
      if (!entry || entry.terminal) return
      entry.terminal = true
    },

    reconcile(targetSource) {
      const entry = turnClocks.get(targetSource)
      if (!entry || entry.terminal) return
      // #217：内核已就本 source 表态「不在途」时，时钟不得复活生成态（权威让位）。
      if (kernelLivenessBySource.get(targetSource) === false) return
      updateRuntimeState({
        generating: true,
        generationStart: entry.generationStart,
        lastTokenAt: entry.lastTokenAt,
        summary: null,
      })
    },

    isGenerating(targetSource) {
      const entry = turnClocks.get(targetSource)
      return entry !== undefined && !entry.terminal
    },

    effectiveLiveness(targetSource) {
      const kernelFact = kernelLivenessBySource.get(targetSource)
      if (kernelFact !== undefined) return { source: 'kernel', generating: kernelFact }
      return { source: 'clock', generating: clock.isGenerating(targetSource) }
    },

    settleRuntimeLiveness(targetSource) {
      // #217：本函数的第二、三步作用于**当前绑定 source** 的全局快照——targetSource
      // 非绑定 source 时必须早退，否则任意他 source 的终帧会把正在生成的会话压熄
      // （终帧投递不过滤绑定 source，且双轨设计上重复投递）。
      if (targetSource !== getSource()) return
      // #217：活性判定走有效权威（kernel > clock）——内核说在途时不得落静。
      if (clock.effectiveLiveness(targetSource).generating) return
      if (!runtime.getSnapshot().generating) return
      updateRuntimeState({
        generating: false,
        generationStart: 0,
        lastTokenAt: undefined,
        generationPhase: undefined,
        generationActivity: undefined,
        thinkingStart: undefined,
      })
    },

    markClockOnlyStart(targetSource, clientMessageId) {
      clockOnlyStarts.set(targetSource, clientMessageId)
    },

    peekClockOnlyStart(targetSource) {
      return clockOnlyStarts.get(targetSource)
    },

    hasClockOnlyStart(targetSource) {
      return clockOnlyStarts.has(targetSource)
    },

    clearClockOnlyStart(targetSource) {
      clockOnlyStarts.delete(targetSource)
    },

    freshenKernelInFlight(targetSource) {
      if (kernelLivenessBySource.has(targetSource)) kernelLivenessBySource.set(targetSource, true)
    },

    kernelAuthoritative(targetSource) {
      return kernelLivenessBySource.has(targetSource)
    },

    hasClock(targetSource) {
      return turnClocks.get(targetSource) !== undefined
    },

    observeKernelSnapshot(targetSource, ledgerTurn) {
      // #217：内核在途事实随快照入库（条目只由此创建——内核真实表态）。双向新鲜度
      // 守卫：快照的时点可能早于本地生命周期——
      //  · false 而本地时钟活动：不覆盖（load/发送竞态下本地更新；内核真收敛则终帧
      //    随后到达自会落静）；
      //  · true 而本地时钟已封存：不覆盖（终帧比该快照新；采纳会让 late 快照在终态
      //    之后复活生成态——merge 层还会顺带清掉 terminalFence，ADR 风险条款的故障类）。
      const kernelFact = resolveKernelLiveness(ledgerTurn)
      if (kernelFact !== undefined) {
        const clockEntry = turnClocks.get(targetSource)
        // 守卫一（时钟旁证）：无本地时钟 ⇒ 快照是唯一事实，采纳；时钟活动 ⇒ 只认
        // true（false 必是竞态旧值）；时钟已封存 ⇒ 只认 false（true 必是早于终态的
        // 旧快照）。
        const clockAllows = clockEntry === undefined
          ? true
          : clockEntry.terminal ? !kernelFact : kernelFact
        // 守卫二（回合身份）：true 快照的身份与已记 settled 的身份相同 ⇒ 它是早于
        // 终态的同一回合（终帧不携带 turnId，身份戳是唯一判别依据）；不同/缺身份
        // 视为新回合，照常采纳。
        const stamp = kernelTurnStampOf(ledgerTurn)
        const stamps = kernelTurnStamps.get(targetSource)
        const stampAllows = !(kernelFact
          && stamps?.settled !== undefined
          && stamp !== undefined
          && stamp === stamps.settled)
        if (clockAllows && stampAllows) {
          kernelLivenessBySource.set(targetSource, kernelFact)
          if (kernelFact) {
            kernelTurnStamps.set(targetSource, stamp !== undefined ? { active: stamp } : {})
          } else {
            // 内核自己确认了「不在途」：settled 标记完成使命。
            kernelTurnStamps.delete(targetSource)
          }
        }
      }
    },

    settleKernelFromLedger(targetSource) {
      kernelLivenessBySource.set(targetSource, false)
      kernelTurnStamps.delete(targetSource)
    },

    archiveLedgerTerminal(targetSource, reason) {
      ledgerTerminalBySource.set(targetSource, reason)
    },

    ledgerTerminalOf(targetSource) {
      return ledgerTerminalBySource.get(targetSource)
    },

    activeUnsettledClock(targetSource) {
      const entry = turnClocks.get(targetSource)
      if (!entry || entry.terminal) return undefined
      // #217：内核已表态「不在途」时，活动时钟不得顶起生成态（权威让位）。
      if (kernelLivenessBySource.get(targetSource) === false) return undefined
      return { generationStart: entry.generationStart, lastTokenAt: entry.lastTokenAt }
    },

    clearAll() {
      turnClocks.clear()
      ledgerTerminalBySource.clear()
      kernelLivenessBySource.clear()
      kernelTurnStamps.clear()
      clockOnlyStarts.clear()
    },
  }
  return clock
}
