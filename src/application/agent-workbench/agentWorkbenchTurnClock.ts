/**
 * TurnClock / kernel-liveness subsystem (P52 D3, #213, #217, ADR-0017, #390).
 * 生成时钟唯一主人（source 隔离，事件驱动）：回合起点 = 发送入口（乐观投影）；
 * 终态 = feed 终帧（done/error/cancelled）或 canonical 终态证据（bind/refresh 时
 * journal 已终态）；拒绝发送 = 回滚。内核在途回合标记（`livenessSource: 'kernel'`
 * 的事实来源）同样归本模块持有——活性权威恒为 kernel > clock > document。
 * 快照写入只经注入的 `updateRuntimeState` 缝，本模块不直接拼文档。
 *
 * #390 结构收敛：此前五个各自隔离的 Map（`turnClocks` / `ledgerTerminalBySource` /
 * `kernelLivenessBySource` / `kernelTurnStamps` / `clockOnlyStarts`）合并为**一条
 * per-source 记录**，且所有写入者共用同一组守卫（`kernelInFlight` 让位规则、
 * 封存新鲜度规则）。合并前的缺陷是「每个写入者自带一套手写守卫」——`reconcile` 与
 * `activeUnsettledClock` 都遵守「内核说在途则让位」，唯独 `settleFromDocument` 漏了，
 * 于是一次早于在途事实的 canonical 读能把时钟**不可逆**封存（#390 根因）。
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
  /**
   * 终帧到达：写 live 终态摘要（elapsed = 终点 - 本进程观察到的起点）。
   *
   * `turnId`（#442 Step2）：终帧 additive 回合身份——在场时身份戳结算走**精确
   * 匹配**（帧身份与最近 active 戳一致才落 settled），stamps 的「最近一次 active
   * 快照」猜测退役；缺省（旧内核终帧不携带）维持猜测作回退轨。
   */
  terminal(targetSource: string, reason: 'done' | 'cancelled' | 'error', at: number, failure?: PromptFailureMetadata, turnId?: number): void
  /** 发送被拒绝：活动回合回滚（后续帧不得复活指示器）。 */
  rollback(targetSource: string): void
  /**
   * bind/refresh 发现 journal 已终态：封存时钟但不写摘要。
   *
   * #390：`readStartedAt` 是本次 canonical 读的**发起时刻**。时钟若在该时刻之后仍
   * 观测到帧，说明这条读早于更新的在途事实，没有资格判定收敛——不得封存。
   */
  settleFromDocument(targetSource: string, hasTerminal: boolean, readStartedAt?: number): void
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

interface ClockEntry {
  generationStart: number
  lastTokenAt: number
  terminal: boolean
  /**
   * live 摘要是否已写出。首终态 wins；但**封存若发生在写出之前**（#390 误封恢复），
   * 后续真终帧仍可补写一次——否则误封会让本回合的耗时永远停留在上一轮的 displayOnly 值。
   */
  summaryWritten: boolean
}

/** 一个 source 的全部回合事实（#390：原五个 Map 合并到这里）。 */
interface SourceTurnRecord {
  /** 本进程回合时钟（含已封存条目）。 */
  clock?: ClockEntry
  /** 最近一次 canonical 重载读到的 #99 账本终态。 */
  ledgerTerminal?: GenerationLedgerTerminalReason
  /**
   * #217/ADR-0017 内核在途回合标记。语义严格为「本进程已派发 prompt、尚未收到终态」。
   * **条目只由 refresh（真实内核快照）创建**；本地生命周期只 Fresh化已存在的条目，
   * 不得制造内核权威（旧内核宿主必须永久保持 `'clock'` 权威）。
   */
  kernel?: { inFlight: boolean }
  /**
   * 内核回合身份戳（`${generation}:${turnId}`，取自快照 `turn.key`）。终帧不携带
   * turnId，但它收敛的就是「最近一次 active 快照」里的那个回合——把该身份记为
   * settled，此后带**同一身份**的 `turnInFlight=true` 快照即可判定为早于终态的 stale。
   */
  stamps?: { active?: string; settled?: string }
  /** 空态创建路径（会话已 select、尚未 bind）只启动了回合时钟、没有文档投影。 */
  clockOnlyStart?: string
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
  const records = new Map<string, SourceTurnRecord>()

  const recordOf = (source: string): SourceTurnRecord => {
    const existing = records.get(source)
    if (existing !== undefined) return existing
    const created: SourceTurnRecord = {}
    records.set(source, created)
    return created
  }

  /** 字段全空即回收，避免长会话里残留空记录。 */
  const prune = (source: string): void => {
    const record = records.get(source)
    if (record === undefined) return
    if (record.clock === undefined && record.ledgerTerminal === undefined && record.kernel === undefined
      && record.stamps === undefined && record.clockOnlyStart === undefined) {
      records.delete(source)
    }
  }

  /** 内核权威是否明确表态「在途」。这是所有活性写入者共享的让位规则。 */
  const kernelInFlight = (record: SourceTurnRecord | undefined): boolean =>
    record?.kernel?.inFlight === true

  /**
   * 终态/回滚路径上的内核事实同步：只 Fresh 已有条目（不得制造内核权威——ADR 兼容
   * 矩阵：新前端 + 旧内核必须永久保持 `'clock'` 权威）；终帧额外推进身份戳，
   * 回滚（派发从未发生）不动身份戳。
   *
   * `turnId`（#442 Step2）：终帧携带的回合身份。在场时按身份**精确匹配**——active
   * 戳的 turnId 段与帧身份一致才落 settled（猜测退役）；不一致说明帧收敛的回合
   * 不是最近一次 active 快照（罕见竞态），不动身份戳（宁可留给内核下一条 false
   * 快照收敛，也不把错误的回合记成 settled）；无 active 戳维持既有清理。
   */
  const markKernelSettled = (record: SourceTurnRecord, withStamp: boolean, turnId?: number): void => {
    if (record.kernel === undefined) return
    record.kernel = { inFlight: false }
    if (!withStamp) return
    const active = record.stamps?.active
    if (turnId !== undefined) {
      if (active !== undefined && active.endsWith(`:${turnId}`)) record.stamps = { settled: active }
      return
    }
    if (active !== undefined) record.stamps = { settled: active }
    else delete record.stamps
  }

  /** #217：有效活性权威——内核表态优先（kernel > clock）。 */
  const effectiveLivenessOf = (targetSource: string): { source: 'kernel' | 'clock'; generating: boolean } => {
    const record = records.get(targetSource)
    if (record?.kernel !== undefined) return { source: 'kernel', generating: record.kernel.inFlight }
    const entry = record?.clock
    return { source: 'clock', generating: entry !== undefined && !entry.terminal }
  }

  const settleRuntimeLiveness = (targetSource: string): void => {
    // #217：本函数的第二、三步作用于**当前绑定 source** 的全局快照——targetSource
    // 非绑定 source 时必须早退，否则任意他 source 的终帧会把正在生成的会话压熄
    // （终帧投递不过滤绑定 source，且双轨设计上重复投递）。
    if (targetSource !== getSource()) return
    // #217：活性判定走有效权威（kernel > clock）——内核说在途时不得落静。
    if (effectiveLivenessOf(targetSource).generating) return
    if (!runtime.getSnapshot().generating) return
    updateRuntimeState({
      generating: false,
      generationStart: 0,
      lastTokenAt: undefined,
      generationPhase: undefined,
      generationActivity: undefined,
      thinkingStart: undefined,
    })
  }

  /** 写 live 终态摘要（首个 live 摘要 wins；误封后由真终帧补写一次）。 */
  const writeLiveSummary = (
    clock: ClockEntry,
    reason: 'done' | 'cancelled' | 'error',
    at: number,
    failure?: PromptFailureMetadata,
  ): void => {
    clock.summaryWritten = true
    updateRuntimeState({
      summary: {
        elapsedMs: Math.max(0, at - clock.generationStart),
        tokenCount: runtime.getSnapshot().tokenCount,
        completedFrame: '',
        reason,
        ...(failure ? { failure } : {}),
        durationSource: 'live-monotonic',
        durationAvailable: true,
      },
    })
  }

  const clock: AgentWorkbenchTurnClock = {
    start(targetSource, at) {
      const record = recordOf(targetSource)
      record.clock = { generationStart: at, lastTokenAt: at, terminal: false, summaryWritten: false }
      // 新回合起点必须清空上一回合的账本终态：否则它会被当成本回合的收敛证据。
      record.ledgerTerminal = undefined
    },

    touch(targetSource, at) {
      const entry = records.get(targetSource)?.clock
      if (!entry || entry.terminal) return undefined
      entry.lastTokenAt = Math.max(entry.lastTokenAt, at)
      return entry.lastTokenAt
    },

    terminal(targetSource, reason, at, failure, turnId) {
      const record = records.get(targetSource)
      const entry = record?.clock
      const sealed = entry === undefined || entry.terminal
      if (!sealed) {
        entry.terminal = true
        // 回合已有终态："仅时钟起点"的记账已完成使命。
        if (record) record.clockOnlyStart = undefined
      }
      // #217：终帧 = 内核已收敛（后端终态先于终帧发布）——内核活性事实同步落静
      // （仅更新已有条目；无内核表态的宿主不得被制造出内核权威）。
      if (record) markKernelSettled(record, true, turnId)
      if (getSource() === targetSource && entry !== undefined) {
        // 已封存但从未写过 live 摘要 ⇒ #390 误封恢复：真终帧是比 displayOnly 兜底
        // 更强的事实，补写一次（`start` 会重置 summaryWritten，故不会跨回合误补）。
        if (!sealed) writeLiveSummary(entry, reason, at, failure)
        else if (!entry.summaryWritten && entry.generationStart > 0) {
          const current = runtime.getSnapshot().summary
          if (current === null || current.displayOnly === true) writeLiveSummary(entry, reason, at, failure)
        }
      }
      settleRuntimeLiveness(targetSource)
      prune(targetSource)
    },

    rollback(targetSource) {
      const record = records.get(targetSource)
      const entry = record?.clock
      if (!record || !entry || entry.terminal) return
      record.clock = undefined
      // #217：派发从未发生（或被拒）——内核在途事实同样为否（仅更新已有条目）。
      markKernelSettled(record, false)
      prune(targetSource)
    },

    settleFromDocument(targetSource, hasTerminal, readStartedAt) {
      if (!hasTerminal) return
      const record = records.get(targetSource)
      const entry = record?.clock
      if (!entry || entry.terminal) return
      // #390①：内核权威明确表态「在途」时不得封存——与 `reconcile` /
      // `activeUnsettledClock` 的让位规则同源；此前本函数是唯一漏掉它的写入者。
      if (kernelInFlight(record)) return
      // #390②：新鲜度——本次读发起之后时钟仍观测到帧，说明读早于在途事实，无资格判收敛。
      if (readStartedAt !== undefined && entry.lastTokenAt > readStartedAt) return
      entry.terminal = true
    },

    reconcile(targetSource) {
      const record = records.get(targetSource)
      const entry = record?.clock
      if (!entry || entry.terminal) return
      // #217：内核已就本 source 表态「不在途」时，时钟不得复活生成态（权威让位）。
      if (record?.kernel?.inFlight === false) return
      updateRuntimeState({
        generating: true,
        generationStart: entry.generationStart,
        lastTokenAt: entry.lastTokenAt,
        summary: null,
      })
    },

    isGenerating(targetSource) {
      const entry = records.get(targetSource)?.clock
      return entry !== undefined && !entry.terminal
    },

    effectiveLiveness(targetSource) {
      return effectiveLivenessOf(targetSource)
    },

    settleRuntimeLiveness,

    markClockOnlyStart(targetSource, clientMessageId) {
      recordOf(targetSource).clockOnlyStart = clientMessageId
    },

    peekClockOnlyStart(targetSource) {
      return records.get(targetSource)?.clockOnlyStart
    },

    hasClockOnlyStart(targetSource) {
      return records.get(targetSource)?.clockOnlyStart !== undefined
    },

    clearClockOnlyStart(targetSource) {
      const record = records.get(targetSource)
      if (record === undefined) return
      record.clockOnlyStart = undefined
      prune(targetSource)
    },

    freshenKernelInFlight(targetSource) {
      const record = records.get(targetSource)
      if (record?.kernel !== undefined) record.kernel = { inFlight: true }
    },

    kernelAuthoritative(targetSource) {
      return records.get(targetSource)?.kernel !== undefined
    },

    hasClock(targetSource) {
      return records.get(targetSource)?.clock !== undefined
    },

    observeKernelSnapshot(targetSource, ledgerTurn) {
      // #217：内核在途事实随快照入库（条目只由此创建——内核真实表态）。双向新鲜度
      // 守卫：快照的时点可能早于本地生命周期——
      //  · false 而本地时钟活动：不覆盖（load/发送竞态下本地更新；内核真收敛则终帧
      //    随后到达自会落静）；
      //  · true 而本地时钟已封存：不覆盖（终帧比该快照新；采纳会让 late 快照在终态
      //    之后复活生成态——merge 层还会顺带清掉 terminalFence，ADR 风险条款的故障类）。
      const kernelFact = resolveKernelLiveness(ledgerTurn)
      if (kernelFact === undefined) return
      const record = recordOf(targetSource)
      const entry = record.clock
      // 守卫一（时钟旁证）：无本地时钟 ⇒ 快照是唯一事实，采纳；时钟活动 ⇒ 只认
      // true（false 必是竞态旧值）；时钟已封存 ⇒ 只认 false（true 必是早于终态的旧快照）。
      const clockAllows = entry === undefined
        ? true
        : entry.terminal ? !kernelFact : kernelFact
      // 守卫二（回合身份）：true 快照的身份与已记 settled 的身份相同 ⇒ 它是早于
      // 终态的同一回合（终帧不携带 turnId，身份戳是唯一判别依据）；不同/缺身份
      // 视为新回合，照常采纳。
      const stamp = kernelTurnStampOf(ledgerTurn)
      const settled = record.stamps?.settled
      const stampAllows = !(kernelFact && settled !== undefined && stamp !== undefined && stamp === settled)
      if (!clockAllows || !stampAllows) return
      record.kernel = { inFlight: kernelFact }
      if (kernelFact) record.stamps = stamp !== undefined ? { active: stamp } : {}
      // 内核自己确认了「不在途」：settled 标记完成使命。
      else delete record.stamps
    },

    settleKernelFromLedger(targetSource) {
      recordOf(targetSource).kernel = { inFlight: false }
      const record = records.get(targetSource)
      if (record !== undefined) delete record.stamps
      prune(targetSource)
    },

    archiveLedgerTerminal(targetSource, reason) {
      recordOf(targetSource).ledgerTerminal = reason
    },

    ledgerTerminalOf(targetSource) {
      return records.get(targetSource)?.ledgerTerminal
    },

    activeUnsettledClock(targetSource) {
      const record = records.get(targetSource)
      const entry = record?.clock
      if (!entry || entry.terminal) return undefined
      // #217：内核已表态「不在途」时，活动时钟不得顶起生成态（权威让位）。
      if (record?.kernel?.inFlight === false) return undefined
      return { generationStart: entry.generationStart, lastTokenAt: entry.lastTokenAt }
    },

    clearAll() {
      records.clear()
    },
  }
  return clock
}
