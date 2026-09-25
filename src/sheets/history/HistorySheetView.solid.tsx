import { createEffect, createMemo, createSignal, onCleanup, For, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
import { tauriInvokeTransport } from '../../infrastructure/acp/tauriTransport.ts'
import { save } from '@tauri-apps/plugin-dialog'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import { useIdentityStore } from '../../identityStore'
import { createSessionClient } from '../../infrastructure/acp/sessionClient'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../../application/transactions/openOwnedSessionTransaction'
import { useReplayPostureStore } from '../../components/chat/replayPostureStore'
import { pagePersistedSessions, validateExportPath } from '../../domains/history/persistedHistory.ts'
import { type PersistedSessionSummary } from '../../domains/overview/persistedSessions.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * HistorySheetView — 存档会话列表 + 导出（W4-01）+ 回放入口（W4-02，#279 第 1 梯队
 * Solid 化实体）。
 *
 * list_persisted_sessions 分页/排序（复用 overview normalize）；导出经 save 对话框
 * 取绝对路径 → export_session（预检路径绝对；目标文件已存在错误明确展示，后端权威）。
 * W4-02（姿态二拍板）：行「回放」复用 Overview resumeSession 机制（找/建 identity 行）
 * → 进入只读姿态 → 开 agent sheet；消息 load 由 ChatView 挂载后 lifecycle 承担
 * （load_persisted_session，listener 先于 load），姿态下无输入面直至点击继续。
 * 行为与 React 版逐行同构：错误上报 key/scope、OWNER-02 归属解析、I01-W4 owner-aware 打开。
 *
 * 样式绞杀（P93）：utility 类串原样携带；`history-sheet/history-sidebar(-total)/
 * history-row` 类名保留为 workspace adaptive.css（modern-gui 模式覆写）的锚点。
 */
// #116 子项 2：同 Search——缺 flex-1 时按内容宽度收缩（实测 394×988）。
const SHEET = 'history-sheet flex flex-1 min-w-0 overflow-hidden text-text font-[family-name:var(--font)]'
// #154：左列几何归布局层的 .sidebar（见 SearchSheetView.solid 同处说明）；本类只管内容样式。
const SIDEBAR = 'sidebar history-sidebar flex flex-col py-[var(--ui-space-5)] px-3 bg-[color-mix(in_srgb,var(--bg-panel)_72%,transparent)]'
const SIDEBAR_HEAD = 'grid gap-2 mx-2 mb-4 pb-4 border-b border-border'
const SIDEBAR_HEAD_SPAN = 'text-accent font-bold text-[10px] leading-[1] font-[family-name:var(--mono)] tracking-[.14em]'
const SIDEBAR_HEAD_STRONG = 'text-[15px]'
const SIDEBAR_TOTAL = 'history-sidebar-total flex items-center gap-2 mb-3 p-3 text-text-dim border border-border text-[11px]'
const SIDEBAR_TOTAL_SVG = 'text-accent'
const SIDEBAR_TOTAL_STRONG = 'text-text font-bold text-[14px] font-[family-name:var(--mono)]'
const NAV = 'grid gap-[3px]'
const NAV_BTN_INVARIANT = 'flex items-center gap-2 min-h-[var(--ui-control-compact)] px-3 text-left cursor-pointer font-[family-name:var(--font)] text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const NAV_BTN = `${NAV_BTN_INVARIANT} border border-transparent border-l-[3px] border-l-transparent bg-transparent text-text-dim enabled:hover:text-text enabled:hover:border-border enabled:hover:border-l-accent enabled:hover:bg-bg-hover`
const NAV_BTN_ACTIVE = `${NAV_BTN_INVARIANT} border border-border border-l-[3px] border-l-accent bg-[color-mix(in_srgb,var(--accent)_10%,var(--bg-active))] text-text font-[650] enabled:hover:bg-bg-hover`
const NAV_BTN_DISABLED_EXTRA = 'opacity-40 cursor-not-allowed'
const SIDEBAR_FOOT = 'mt-auto pt-4 px-3 pb-0 border-t border-border text-text-dim font-[family-name:var(--mono)] text-[10px]'
const MAIN = 'flex-1 min-w-0 max-w-[1120px] py-[var(--ui-space-6)] px-[clamp(var(--ui-space-5),4vw,var(--ui-space-7))] overflow-y-auto max-[720px]:py-[var(--ui-space-5)] max-[720px]:px-4'
const KICKER = 'font-mono text-[11px] font-[650] tracking-[.12em] text-accent'
const MAIN_TITLE = 'mt-1 mb-5 text-text text-[24px] font-bold tracking-[-.025em]'
const TREE_ERROR = 'm-1 mb-4 p-2 border rounded-[var(--ui-radius-sm)] text-[12px] text-[var(--state-danger)] bg-[var(--state-danger-surface)] border-[color-mix(in_srgb,var(--state-danger)_34%,var(--stroke-default))]'
const HINT = 'text-[12px] text-text-dim'
const PAGER_HINT = 'min-w-[56px] px-2 text-text-dim font-mono text-[11px] leading-[var(--ui-control-compact)] text-center'
const RESULT_LIST = 'grid gap-2 m-0 p-0 list-none'
const RESULT_ITEM = 'border border-border rounded-none bg-bg-panel transition-[border-color,background-color] duration-[120ms] hover:border-border-focus hover:bg-bg-hover'
const ROW = 'history-row flex flex-wrap items-center gap-3 min-h-[var(--ui-control-emphasis)] px-3 py-2'
const ROW_PATH = 'flex-1 min-w-0 overflow-hidden text-text text-[13px] font-semibold truncate max-[720px]:basis-[calc(100%-var(--ui-space-3))] max-[720px]:whitespace-normal max-[720px]:[overflow-wrap:anywhere]'
const ROW_TEXT = 'shrink-0 max-w-[40%] text-text-dim font-mono text-[11px] whitespace-nowrap max-[720px]:mr-auto'
const ROW_BTN_NEUTRAL = 'min-w-[56px] h-[var(--ui-control-compact)] px-3 border border-border rounded-none text-text-dim bg-bg-input cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-border-focus enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const ROW_BTN_ACCENT = 'min-w-[56px] h-[var(--ui-control-compact)] px-3 rounded-none cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] border border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] text-accent bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] enabled:hover:border-border-focus enabled:hover:text-text enabled:hover:bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const PAGER_BTN = 'min-w-[56px] h-[var(--ui-control-compact)] px-3 border border-border rounded-none text-text-dim bg-bg-input cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-border-focus enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

export interface HistorySheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

export default function HistorySheetView(props: HistorySheetViewProps) {
  const [raw, setRaw] = createSignal<unknown>(null)
  const [page, setPage] = createSignal(1)
  const [exportError, setExportError] = createSignal('')
  const [replayError, setReplayError] = createSignal('')

  createEffect(() => {
    const sheetId = props.sheet.id
    let disposed = false
    const client = createSessionClient({ invoke: tauriInvokeTransport })
    client.listPersistedSessions().then(value => {
      if (!disposed) {
        setRaw(value)
        resolveRuntimeErrors({ key: `history:${sheetId}:list` })
      }
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取存档会话', error, undefined, {
        key: `history:${sheetId}:list`,
        scope: { kind: 'sheet', id: sheetId },
        source: 'history.sheet',
        recovery: { kind: 'open-runtime-log', sheetId },
      })
    })
    onCleanup(() => { disposed = true })
  })

  const paged = createMemo(() => pagePersistedSessions(raw(), page()))
  const sidebarPages = createMemo(() => {
    const current = paged()
    const start = Math.max(1, Math.min(current.page - 3, current.pages - 6))
    return Array.from({ length: Math.min(7, current.pages) }, (_, index) => start + index)
  })

  const exportSession = async (periId: string) => {
    setExportError('')
    setReplayError('')
    // OWNER-02：export owner agentId 从 Session owner 解析（identityStore 按 periId 定位），
    // 绝不取 activeAgent；未定位到 owner 时明确报错（不静默 fallback 串线）。
    const owner = useIdentityStore.getState().sessions.find(s => s.periId === periId)
    if (!owner) { setExportError('无法确定会话归属 Agent，请先在会话中打开再导出'); return }
    let outputPath: string | null
    try {
      outputPath = await save({ defaultPath: `session-${periId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    } catch (error) {
      reportRuntimeError('打开导出保存对话框', error, undefined, {
        key: `history:${props.sheet.id}:export-dialog`,
        scope: { kind: 'sheet', id: props.sheet.id },
        source: 'history.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: props.sheet.id },
      })
      return
    }
    if (!outputPath) return
    const validation = validateExportPath(outputPath)
    if (validation) { setExportError(validation); return }
    try {
      const client = createSessionClient({ invoke: tauriInvokeTransport })
      await client.exportSession({ agentId: owner.agentId, periId, format: 'markdown', outputPath })
      resolveRuntimeErrors({ key: `history:${props.sheet.id}:export:${periId}` })
    } catch (error) {
      setExportError('')
      reportRuntimeError('导出会话', error, undefined, {
        key: `history:${props.sheet.id}:export:${periId}`,
        scope: { kind: 'sheet', id: props.sheet.id },
        source: 'history.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: props.sheet.id },
      })
    }
  }

  // W4-02（姿态二）：复用 Overview 的找/建 identity 行机制（resumePersistedSessionTransaction，
  // FE-AUD-010），进入只读姿态后开 agent sheet；load 由 ChatView 挂载后的 lifecycle 承担
  const openReplay = async (entry: PersistedSessionSummary) => {
    setExportError('')
    setReplayError('')
    if (!entry.periId) return
    // I01-W4：owner-aware 打开——owner 无法确定（存档无归属）时 blocked，不静默归 active Agent
    const result = await openOwnedSessionTransaction(
      { source: entry.source, periId: entry.periId, title: entry.title, updatedAt: entry.updatedAt },
      {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: useIdentityStore.getState().activeAgent,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: createStandardSwitchAgent(id => useIdentityStore.getState().agents.find(a => a.id === id)?.name),
        selectSession: id => props.ctx.selectSession(id),
        openAgentSheet: ({ title, agentId }) => props.ctx.openSheet({ kind: 'agent', title, agentId }),
      },
    )
    if (!result.ok) {
      // Owner-switch transport failures are already recorded in the central
      // tray by createStandardSwitchAgent. Keep a quiet contextual status;
      // ownership/validation facts remain assertive and actionable here.
      if (result.kind === 'transport') setReplayError('回放失败，详情见右下角错误中心')
      else setExportError(result.message)
      return
    }
    useReplayPostureStore.getState().enter(result.value)
  }

  return (
    <div class={SHEET}>
      <aside class={SIDEBAR} aria-label="存档导航">
          <div class={SIDEBAR_HEAD}><span class={SIDEBAR_HEAD_SPAN}>HISTORY</span><strong class={SIDEBAR_HEAD_STRONG}>存档导航</strong></div>
          <div class={SIDEBAR_TOTAL}><LucideIcon name="Archive" size={16} class={SIDEBAR_TOTAL_SVG} /><span><strong class={SIDEBAR_TOTAL_STRONG}>{paged().total}</strong> 个存档</span></div>
          <Show when={paged().pages > 1}>
            <nav class={NAV} aria-label="存档分页">
              <button type="button" class={`${NAV_BTN} ${NAV_BTN_DISABLED_EXTRA}`} disabled={paged().page === 1} onClick={() => setPage(1)} aria-label="第一页"><LucideIcon name="ChevronFirst" size={15} /><span>第一页</span></button>
              <For each={sidebarPages()}>{pageNumber => <button type="button" class={pageNumber === paged().page ? NAV_BTN_ACTIVE : NAV_BTN} aria-current={pageNumber === paged().page ? 'page' : undefined} onClick={() => setPage(pageNumber)}><span>第 {pageNumber} 页</span></button>}</For>
              <button type="button" class={`${NAV_BTN} ${NAV_BTN_DISABLED_EXTRA}`} disabled={paged().page === paged().pages} onClick={() => setPage(paged().pages)} aria-label="最后一页"><LucideIcon name="ChevronLast" size={15} /><span>最后一页</span></button>
            </nav>
          </Show>
          <div class={SIDEBAR_FOOT}>第 {paged().page} / {paged().pages} 页</div>
        </aside>
      <main class={MAIN}>
        <div class={KICKER}>HISTORY</div>
        <h2 class={MAIN_TITLE}>存档会话（{paged().total}）</h2>
        <Show when={exportError()}>
          <div class={TREE_ERROR} role="alert">{exportError()}{exportError().includes('归属不明') && <button type="button" onClick={() => props.ctx.openProfileEdit()}>打开 Agent 设置</button>}</div>
        </Show>
        <Show when={replayError()}><p class={`${HINT} history-error-reference`} role="status">{replayError()}</p></Show>
        <ul class={RESULT_LIST}>
          <For each={paged().entries}>{entry => (
            <li class={RESULT_ITEM}>
              <div class={ROW}>
                <span class={ROW_PATH}>{entry.title || entry.source || entry.id}</span>
                <span class={ROW_TEXT}>{new Date(entry.updatedAt).toLocaleString()}</span>
                <button type="button" class={ROW_BTN_ACCENT} disabled={!entry.periId} title={entry.periId ? '只读回放，点击继续转 live' : '该存档无 periId，无法回放'} onClick={() => void openReplay(entry)}>回放</button>
                <button type="button" class={ROW_BTN_NEUTRAL} onClick={() => void exportSession(entry.periId || entry.id)}>导出</button>
              </div>
            </li>
          )}</For>
        </ul>
        <Show when={paged().pages > 1}>
          <div class="mt-4 flex items-center gap-2">
            <button type="button" class={PAGER_BTN} disabled={paged().page <= 1} onClick={() => setPage(page() - 1)}>上一页</button>
            <span class={PAGER_HINT}>{paged().page}/{paged().pages}</span>
            <button type="button" class={PAGER_BTN} disabled={paged().page >= paged().pages} onClick={() => setPage(page() + 1)}>下一页</button>
          </div>
        </Show>
      </main>
    </div>
  )
}

/** React 薄桥（HistorySheetView.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export function renderHistorySheetView(container: HTMLElement, props: HistorySheetViewProps): () => void {
  return render(() => <HistorySheetView sheet={props.sheet} ctx={props.ctx} />, container)
}
