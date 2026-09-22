import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import { formatUsagePercent, formatUsageTokens } from '../../../tokenFormat.ts'
import { CC_WIDGET_IDS, WIDGET_PROPERTY_FIELDS, isWidgetVisible, ALWAYS_VISIBLE_STATUS_WIDGET_IDS, EMPTY_STATE_HIDDEN_WIDGET_IDS, CC_FLOATING_WIDGET_IDS, CC_WIDGET_LABELS, ccWidgetLanding, coerceInputLanding, resolveCcWidgetGroup, type CcPropertyCommand, type CcWidgetId, type WidgetPropertyField } from '../../../domains/cc/widgetDefinitions.ts'
import { CC_REGISTERED_SLOT_IDS, type CcLayoutWidgetId, type CcWidgetPlacement } from '../../../ccLayoutState.ts'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../../../ccHeightState.ts'
import type { UsageSnapshot } from '../../../domains/workbench/session/sessionSurface.ts'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import { SolidInputBar } from './InputBar.solid.tsx'
import { SolidCcSendButton, SolidModeWidget, SolidModelWidget, SolidReasoningWidget } from './WorkbenchWidgets.solid.tsx'
import { resolveModeOptionEntries } from './workbenchOptionCatalog.ts'
import { useIdentityStore } from '../../../identityStore.ts'
import { useWorkspaceEntityStore } from '../../../workspaceEntityStore.ts'
import type { WorkbenchAttachment } from '../../../domains/workbench/workbenchCommandFacade.ts'
import { toCssBackgroundImage } from '../../../backgroundImage.ts'
import { getCcWidgetRegistry } from '../../../plugin-runtime/runtimeServices.ts'
import { errorMessage } from '../../../infrastructure/tauri/errorPayload.ts'
import { parseTranslateOffset, resolveAllowedOffset, shouldBypassCollisionConstraint, type CcOffsetPair, type CcRectLike } from './ccPlacementCollision.ts'

/**
 * ★★ #238 刀3：**槽位层已拆** —— 不再有「先分槽、再在槽里排序」两段式。
 * 位置由定义表每行的 `layout` 声明，渲染按**落脚处**（`ccWidgetLanding` = `(y.anchor, y.side)`）自动成组。
 *
 * 两个落脚处**从表里取**（不写死字符串）：输入栏那一处与信息控件那一处。
 * ⚠ 容器结构不能随意改：`.cc-input-slot` 这个类名被两处 JS 用来量宽度
 * （本文件 `onMount` 算 `--cc-input-text-inset-x`、`InputBar.solid.tsx` 取父容器），
 * 改了会让输入框文字内缩**静默变成 0**。
 */
const INPUT_LANDING = ccWidgetLanding('input')
const INFO_LANDING = ccWidgetLanding('model')
/**
 * 编辑态可编辑控件 = 内置轨 ∪ 注册轨中**占槽位**的控件（刀4 的「内置轨 ∪ 注册轨」）——
 * 两者都由定义表（`domains/cc/widgetDefinitions.ts`）派生，共 6 条。
 * 「基础」`cc-surface` 不参与排布、无 order/offset/显隐，故不进工具栏（其值在设置页编辑）。
 */
const CC_EDIT_TOOLBAR_IDS: readonly CcLayoutWidgetId[] = [...CC_WIDGET_IDS, ...CC_REGISTERED_SLOT_IDS]

// 04b：空态极简 —— 空态工作区选择器隐藏保留（用户 2026-09-19 拍板「先隐藏」）。
// 置 true 即恢复显示；选择器实现（EmptyWorkspaceControl）与它用到的命令全部保留。
const SHOW_EMPTY_WORKSPACE_CONTROL = false

export function SolidControlCenter() {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  // ccSurfaceOpacity is stored as a 0–1 ratio. Keep accepting legacy
  // snapshots that carried the old 0–100 value so previews/renderers do not
  // briefly emit values such as 7200% while an older theme is being loaded.
  const surfaceOpacityPercent = () => {
    const value = appearance().ccSurfaceOpacity
    return value > 1 ? value : value * 100
  }
  const inputSurfaceOpacityPercent = () => {
    const value = appearance().inputSurfaceOpacity
    return value > 1 ? value : value * 100
  }
  const inputBorderOpacityPercent = () => {
    const value = appearance().inputBorderOpacity
    return value > 1 ? value : value * 100
  }
  const inputHighlightOpacityPercent = () => {
    const value = appearance().inputHighlightOpacity
    return value > 1 ? value : value * 100
  }
  const runtime = () => workbench.runtimeSnapshot()
  const input = () => workbench.input()
  const [selected, setSelected] = createSignal<CcLayoutWidgetId>()
  const [workspaceId, setWorkspaceId] = createSignal('')
  /** Workspace carried by Sidebar's create-session intent. The event is
   * intentionally cached because Sidebar clears the active session in the
   * same tick after dispatching it. */
  const [preferredWorkspaceId, setPreferredWorkspaceId] = createSignal('')
  const [workspaceSelectionTouched, setWorkspaceSelectionTouched] = createSignal(false)
  const [modelId, setModelId] = createSignal('')
  const [reasoningLevel, setReasoningLevel] = createSignal('medium')
  const [mode, setMode] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)
  const [submitError, setSubmitError] = createSignal('')
  const [workspaceDraft, setWorkspaceDraft] = createSignal<{ name: string; path: string }>()
  const [sessionEntering, setSessionEntering] = createSignal(false)
  let previousSessionId: string | null = input().sessionId
  let sessionEnteringTimer: ReturnType<typeof setTimeout> | undefined
  let workspaceSelect: HTMLSelectElement | undefined
  let workspaceSyncRevision = 0
  const emptyWorkspaces = () => input().availableWorkspaces ?? []
  const modeOptions = () => resolveModeOptionEntries(runtime(), mode()).map(item => item.id)
  const profileModel = () => runtime().activeModel || useIdentityStore.getState().profiles.find(item => item.id === useIdentityStore.getState().activeProfileId)?.model || ''
  const emptyVisual = () => !input().sessionId || sessionEntering()
  // The body surface is now represented by the cc-widget registration channel.
  // Keep the existing host-rendered background implementation and CSS intact;
  // this lookup is the minimal P2 consumer seam and remains HMR-safe because
  // the registry snapshot is read at render time.
  const ccSurfaceRegistered = () => getCcWidgetRegistry().getSnapshot().entries.some(
    entry => entry.value.id === 'cc-surface',
  )
  const ccSendButtonRegistered = () => getCcWidgetRegistry().getSnapshot().entries.some(
    entry => entry.value.id === 'cc-send-button',
  )
  let controlCenterElement: HTMLDivElement | undefined
  const sendButtonMode = () => {
    // 04b：空态隐藏发送按钮 —— 与其余控件共用 hiddenWidgetIds() 这一个入口。
    // 注册轨的发送按钮不经 isWidgetVisible（没有 !edit 短路），故编辑态豁免在此显式保留（丁）。
    if (hiddenWidgetIds().includes('cc-send-button') && !appearance().ccEditMode) return undefined
    return appearance().inputSubmitButtonMode === 'external' ? 'external' : appearance().inputSubmitButtonMode === 'inline' ? 'inline' : undefined
  }
  createEffect(() => {
    if (modelId() || !profileModel()) return
    setModelId(profileModel())
  })
  createEffect(() => {
    if (mode() || !runtime().activeMode) return
    setMode(runtime().activeMode || modeOptions()[0] || 'default')
  })
  createEffect(() => {
    const options = emptyWorkspaces()
    const current = workspaceId()
    const preferred = preferredWorkspaceId()
    const valid = (id: string) => Boolean(id) && options.some(item => item.id === id)

    // A workspace intent from the sidebar has priority over the generic
    // "most recently active" heuristic, but only for this empty-state entry.
    if (valid(preferred)) {
      if (current !== preferred) setWorkspaceId(preferred)
      return
    }
    if (current && valid(current)) return

    // Chat mode may still opt into a workspace. Never erase a user choice just
    // because the mode is chat; only repair a stale id or choose an initial
    // value when the user has not touched the selector.
    if (workspaceSelectionTouched()) {
      if (current && !valid(current)) setWorkspaceId('')
      return
    }

    const recent = options.length
      ? options.reduce((a, b) => (b.lastActiveAt ?? 0) > (a.lastActiveAt ?? 0) ? b : a)
      : undefined
    const hasExplicitActivity = options.some(item => item.lastActiveAt !== undefined && item.lastActiveAt !== null)
    const next = options.length === 1
      ? options[0]!.id
      : hasExplicitActivity ? recent?.id ?? '' : ''
    if (current !== next) setWorkspaceId(next)
  })
  // Reconcile the native select after its <option> children have been
  // reconciled. Browsers reset select.value to the empty option when a keyed
  // option list is replaced, even though the Solid signal did not change.
  // Keeping this as a DOM-boundary repair preserves the signal as the source
  // of truth without stealing a user's explicit selection.
  createEffect(() => {
    const desired = workspaceId()
    const options = emptyWorkspaces()
    const revision = ++workspaceSyncRevision
    queueMicrotask(() => {
      if (revision !== workspaceSyncRevision) return
      const select = workspaceSelect
      if (!select) return
      const valid = desired === '' || options.some(item => item.id === desired)
      if (valid && select.value !== desired) select.value = desired
    })
  })
  createEffect(() => {
    const current = input().sessionId
    if (!previousSessionId && current) {
      setSessionEntering(true)
      if (sessionEnteringTimer) clearTimeout(sessionEnteringTimer)
      sessionEnteringTimer = setTimeout(() => {
        sessionEnteringTimer = undefined
        setSessionEntering(false)
      }, 360)
    }
    previousSessionId = current
  })
  onCleanup(() => {
    if (sessionEnteringTimer) clearTimeout(sessionEnteringTimer)
  })
  const pickFolder = () => window.dispatchEvent(new CustomEvent('pylon:pick-workspace-folder'))
  onMount(() => {
    const onFolderPicked = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (path) setWorkspaceDraft({ name: path.split(/[\\/]/).filter(Boolean).at(-1) || '新工作区', path })
    }
    // Sidebar 的「新会话」意图携带工作区 id；空态工作区控件是宿主渲染元素
    // （刀4 后 `workspace` 控件已不在名单里，见 emptyWorkspaceControl）。
    const onNewSession = (event: Event) => {
      const workspace = (event as CustomEvent<{ workspaceId?: unknown }>).detail?.workspaceId
      const id = typeof workspace === 'string' ? workspace.trim() : ''
      setPreferredWorkspaceId(id)
      setWorkspaceSelectionTouched(false)
      setWorkspaceId(id)
      setWorkspaceDraft()
      setSubmitError('')
    }
    window.addEventListener('pylon:workspace-folder-picked', onFolderPicked)
    window.addEventListener('pylon:new-session', onNewSession)
    onCleanup(() => {
      window.removeEventListener('pylon:workspace-folder-picked', onFolderPicked)
      window.removeEventListener('pylon:new-session', onNewSession)
    })
  })
  const createWorkspace = async () => {
    const draft = workspaceDraft(); if (!draft?.name.trim() || !draft.path) return
    try {
      const workspace = await useWorkspaceEntityStore.getState().createWorkspace(draft.name.trim(), draft.path)
      setWorkspaceId(workspace.id)
      setPreferredWorkspaceId(workspace.id)
      setWorkspaceSelectionTouched(true)
      setWorkspaceDraft()
      setSubmitError('')
    }
    catch (error) { setSubmitError(errorMessage(error, '创建工作区失败')) }
  }
  const createEmptySession = async (text: string, attachments: readonly WorkbenchAttachment[]) => {
    // 旧模型在这里按「左栏是否处于工作页签」拦截未选工作区的提交（`请先选择工作区`）。
    // 左栏已不再分互斥视图：不选工作区即创建一个无 cwd 会话，是合法意图，故守卫删除。
    if (submitting()) return false
    setSubmitting(true); setSubmitError('')
    try {
      const created = await workbench.commands.createSession({
        ...(workspaceId() ? { workspaceId: workspaceId() } : {}),
        ...(modelId().trim() ? { model: modelId().trim() } : {}),
        reasoningLevel: reasoningLevel(),
        mode: mode() || modeOptions()[0] || 'default',
        initialPrompt: { text, attachments },
      })
      if (!created.sessionId) throw new Error('会话创建未返回有效标识')
      if (created.initialPromptOutcome) {
        const restoreInitialPrompt = (error: string) => {
          const ui = workbench.sessionUi.capture(created.sessionId)
          // A user may already have started the next message while the first
          // prompt was running. Only restore the failed prompt into an empty
          // composer; never overwrite newer input.
          ui.update('draft', '', current => current.trim() ? current : text)
          ui.update<readonly WorkbenchAttachment[]>('attachments', [], current => current.length > 0 ? current : attachments)
          ui.set('input-error', error)
        }
        void created.initialPromptOutcome.then(result => {
          if (result.status === 'rejected') restoreInitialPrompt(result.error || '首条请求发送失败')
        }, error => restoreInitialPrompt(errorMessage(error, '首条请求发送失败')))
      }
      return true
    } catch (error) {
      setSubmitError(errorMessage(error, '会话创建失败')); return false
    } finally { setSubmitting(false) }
  }
  const emptyComposer = createMemo(() => !input().sessionId ? {
    onSubmit: createEmptySession,
    submitting,
    after: <Show when={submitError()}>{message => <div class="solid-agent-empty-error" role="alert">{message()}</div>}</Show>,
  } : undefined)
  let stopDragging: (() => void) | undefined
  onCleanup(() => stopDragging?.())
  createEffect(() => {
    if (appearance().ccEditMode) return
    setSelected(undefined)
    stopDragging?.()
  })
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !appearance().ccEditMode) return
      if (selected()) setSelected(undefined)
      else {
        stopDragging?.()
        workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    onCleanup(() => window.removeEventListener('keydown', onKeyDown))
  })
  const readonly = () => input().replayReadonly === true || (input().preview === true && Boolean(input().sessionId))
  const hiddenWidgetIds = () => !emptyVisual()
    ? appearance().ccHidden
    : [...new Set([...appearance().ccHidden, ...EMPTY_STATE_HIDDEN_WIDGET_IDS])]
  const visibilityContext = () => ({
    hidden: hiddenWidgetIds(),
    inputMode: appearance().inputMode,
    submitButtonMode: appearance().inputSubmitButtonMode,
    editMode: appearance().ccEditMode,
    // ★ #238 刀5B：`conditions`（运行期状态检测）要读的两个事实 —— 必须与高度计数同源。
    hasSession: Boolean(input().sessionId),
    hintMode: appearance().cliHintMode,
  })
  // The registered cc-send-button owns the send block (F1=A)：槽位/显隐/缩放统一记在
  // `cc-send-button` 这个 id 上，legacy `send` 已随刀4 迁走。
  const visibleIds = createMemo(() => CC_WIDGET_IDS.filter(id => isWidgetVisible(id, visibilityContext())))
  const minHeight = () => resolveCcMinHeight({
    inputMode: appearance().inputMode,
    footerLayout: appearance().footerLayout,
    hintMode: appearance().cliHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: hiddenWidgetIds(),
      inputMode: appearance().inputMode,
      submitButtonMode: appearance().inputSubmitButtonMode,
      hintMode: appearance().cliHintMode,
      hasSession: Boolean(input().sessionId),
    }),
    cliOverflowMode: appearance().cliOverflowMode,
  })
  // 状态行门户：常态显示控件（见 ALWAYS_VISIBLE_STATUS_WIDGET_IDS = `inActiveSession: 'show'` 的状态控件）
  // 在活跃会话里也放行；其它信息控件仍受"活跃会话收起"约束。输入栏从不经过这个门户。
  const passesStatusGate = (id: CcWidgetId) =>
    id === 'input' || showStatusSlots() || ALWAYS_VISIBLE_STATUS_WIDGET_IDS.includes(id)
  // ★ 按**落脚处**成组（#238 刀3）：同一 `(y.anchor, y.side)` 的元件归入同一个容器，组内按 order 排。
  //   进组前过一遍**输入栏落脚处独占守卫**（原「input 槽只准放输入栏」的替代）：
  //   非输入栏若被错标到输入栏容器，退回信息落脚处 —— 宁可换位置，不凭空消失。
  const landingOf = (id: CcWidgetId) => coerceInputLanding(id, ccWidgetLanding(id))
  const idsForLanding = (landing: string | undefined) => visibleIds()
    .filter(id => landingOf(id) === landing)
    .filter(id => passesStatusGate(id))
    .sort((left, right) => appearance().ccLayout.placements[left].order - appearance().ccLayout.placements[right].order)

  /**
   * 空态工作区控件（刀4）：原 `workspace` 控件已从名单移除，但它承载的空态
   * 「选择 / 新建工作区」是新会话链路的入口（含 cwd 绑定），故改为**宿主渲染元素**：
   * 不占槽位、不进 ccLayout、不进编辑工具栏、不参与显隐与缩放。
   */
  const EmptyWorkspaceControl = () => <Show when={emptyVisual()}>
    <div class="cc-empty-workspace-control">
      <label class="cc-empty-workspace-select">
        <span aria-hidden="true">▣</span>
        <select
          ref={node => { workspaceSelect = node }}
          aria-label="新会话工作区"
          disabled={submitting() || emptyWorkspaces().length === 0}
          value={workspaceId()}
          onInput={event => {
            const value = event.currentTarget.value
            setWorkspaceSelectionTouched(true)
            setPreferredWorkspaceId(value)
            setWorkspaceId(value)
          }}
          onChange={event => {
            const value = event.currentTarget.value
            setWorkspaceSelectionTouched(true)
            setPreferredWorkspaceId(value)
            setWorkspaceId(value)
          }}
        >
                <option value="" selected={workspaceId() === ''}>不使用工作区</option>
          <For each={emptyWorkspaces()}>{item => <option value={item.id} selected={item.id === workspaceId()}>{item.label} · {item.path}</option>}</For>
        </select>
      </label>
      <button type="button" class="cc-empty-workspace-create" disabled={submitting()} onClick={pickFolder} aria-label="新建工作区">＋</button>
      <Show when={workspaceDraft()}>{draft => <div class="cc-empty-workspace-popover">
        <input aria-label="新工作区名称" disabled={submitting()} value={draft().name} onInput={event => setWorkspaceDraft({ ...draft(), name: event.currentTarget.value })} />
        <code title={draft().path}>{draft().path}</code>
        <button type="button" disabled={submitting()} onClick={() => void createWorkspace()}>创建</button>
      </div>}</Show>
    </div>
  </Show>

  const renderBody = (id: CcWidgetId): JSX.Element | null => {
    switch (id) {
      case 'input':
        return <SolidInputBar disabled={readonly()} predictionProvider={workbench.predictionProvider} empty={emptyComposer} />
      case 'tokens': {
        // S11 用量控件：按钮型外观、不可点击（无 onClick / 无菜单 / 无 aria-haspopup）。
        // 外观沿用 model 控件的外观字段 —— 本控件不新增属性字段（S11 拍板「光秃秃」），
        // 但必须与 model/reasoning/mode 是同一族按钮，否则会退化成裸文字。
        const usage = () => runtime().document?.session.usage
        const limit = () => usage()?.contextLimit
        const pillStyle = () => ({
          height: `${appearance().modelHeight ?? 28}px`,
          'border-radius': `${appearance().modelRadius ?? 0}px`,
          'font-size': `calc(${appearance().modelFontSize ?? 12}px * ${appearance().ccScale.tokens ?? 100} / 100)`,
          background: appearance().modelBgColor === 'black' ? '#000' : '#fff',
          color: appearance().modelTextColor === 'white' ? '#fff' : '#000',
        })
        return <span class="cc-usage-pill" style={pillStyle()}>
          <span class="cc-usage-count">{formatUsageTokens(usageTokenCount(usage(), runtime().tokenCount))}/{limit() && limit()! > 0 ? formatUsageTokens(limit()!) : '—'}</span>
          <span class="cc-usage-percent">{formatUsagePercent(contextRatio(usage(), runtime().tokenCount))}</span>
        </span>
      }
      case 'model':
        return <SolidModelWidget
          draftValue={emptyVisual() ? modelId : undefined}
          onDraftChange={emptyVisual() ? setModelId : undefined}
          forceDropdown={emptyVisual()}
        />
      case 'reasoning':
        return <SolidReasoningWidget draftValue={emptyVisual() ? reasoningLevel : undefined} onDraftChange={emptyVisual() ? setReasoningLevel : undefined} />
      case 'mode':
        return <SolidModeWidget
          draftValue={emptyVisual() ? mode : undefined}
          onDraftChange={emptyVisual() ? setMode : undefined}
          forceDropdown={emptyVisual()}
        />
      case 'cc-command-hint':
        // ★ #238 刀5B：命令行提示从「裸渲染」升格为表里的普通行内元件（本分支就是它的渲染实现）。
        //   运行期条件（有会话 / 命令行模式 / 详细档不为 hidden）**不在这里判** ——
        //   它们写在定义表的 `conditions` 里，由 `isWidgetVisible` 统一裁决
        //   ⇒ 渲染与高度计数共用一个谓词，不可见时自然不计数。
        return <div class="cc-command-hint" aria-label="输入快捷键提示">
          <span class="cc-command-hint-key">/: 命令</span>
          <span class="cc-hint-secondary"><i>|</i> Shift+Enter: 换行</span>
          {appearance().cliHintMode === 'full' && <span class="cc-hint-tertiary"><i>|</i> Shift+Tab: 模式</span>}
        </div>
    }
  }

  const renderWidget = (id: CcWidgetId) => {
    const placement = () => appearance().ccLayout.placements[id]
    const body = renderBody(id)
    if (body === null) return null
    return <div
      class={`cc-widget${id === 'input' ? '' : ' cc-natural'}${appearance().ccEditMode ? ' cc-edit' : ''}${appearance().ccHidden.includes(id) ? ' cc-hidden' : ''}${selected() === id ? ' cc-selected' : ''}`}
      data-widget-id={id}
      data-widget-anchor={resolveCcWidgetGroup(id)?.layout?.y.anchor}
      style={placementStyle(placement())}
      onPointerDown={event => beginDrag(event, id)}
    >{body}</div>
  }

  const beginDrag = (event: PointerEvent, id: CcLayoutWidgetId) => {
    if (!appearance().ccEditMode) return
    event.preventDefault()
    event.stopPropagation()
    setSelected(id)
    stopDragging?.()
    const startX = event.clientX
    const startY = event.clientY
    const pointerId = event.pointerId
    const start = appearance().ccLayout.placements[id]
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      // ★ #238 刀4：**走带守卫的入口**（原先这里是直连 dispatch，会绕过占区不叠加约束）。
      updatePlacement(id, {
        offsetX: start.offsetX + next.clientX - startX,
        offsetY: start.offsetY + next.clientY - startY,
      })
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (stopDragging === stop) stopDragging = undefined
    }
    stopDragging = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  /**
   * ★★ #238 刀4「占区不叠加」——**两条通路共用**的守卫（拖拽与属性面板都走 `updatePlacement`）。
   *
   * 为什么必须共用一个入口：改偏移原本有两条通路，拖拽那条曾经**直连 dispatch**、
   * 绕过了面板用的 `updatePlacement` ⇒ 只挂一条等于留个后门（在面板里把「水平微调」
   * 直接输成重叠值一样能叠上去）。
   *
   * 放行条件（三者按序短路）：
   * 1. **非编辑态** —— 直接放行 ⇒ 常态界面不跑任何几何（像素与性能零变化）；
   * 2. **悬浮件**（`CC_FLOATING_WIDGET_IDS`，现只有发送按钮）—— 它本来就要压在输入栏上；
   * 3. **只改 `order`** —— 改顺序是用户明确意图，不进本约束。
   */
  const measureWidgetBox = (id: string): { rect: CcRectLike; offset: CcOffsetPair } | undefined => {
    const element = controlCenterElement?.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)
    if (!element) return undefined
    const box = element.getBoundingClientRect()
    return {
      rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      // ★ 与 `rect` 同源（同一 DOM 快照）：偏移从元素自己的 inline transform 读回，
      //   **不**从 store 读 —— Solid 的事件里 DOM 更新可能还没落地，混用会算错一帧。
      offset: parseTranslateOffset(element.style.transform),
    }
  }
  const allowedPlacement = (id: CcLayoutWidgetId, partial: Partial<CcWidgetPlacement>): Partial<CcWidgetPlacement> => {
    if (shouldBypassCollisionConstraint({
      editMode: appearance().ccEditMode === true,
      id,
      floatingIds: CC_FLOATING_WIDGET_IDS,
      touchesOffset: partial.offsetX !== undefined || partial.offsetY !== undefined,
    })) return partial
    const self = measureWidgetBox(id)
    if (!self) return partial
    const current = appearance().ccLayout.placements[id]
    const candidate = {
      offsetX: partial.offsetX ?? current.offsetX,
      offsetY: partial.offsetY ?? current.offsetY,
    }
    // 障碍集 = 其他可拖元件里**不在悬浮名单**的（悬浮件既不当障碍也不受约束）。
    // ★ 每次调用**重新测量**：拖动中可能换行回流（flex-wrap），缓存会失效且症状隐蔽。
    const obstacles = CC_EDIT_TOOLBAR_IDS
      .filter(other => other !== id && !CC_FLOATING_WIDGET_IDS.includes(other))
      .map(other => measureWidgetBox(other)?.rect)
      .filter((rect): rect is CcRectLike => rect !== undefined)
    const allowed = resolveAllowedOffset({
      applied: self.offset,
      baseRect: self.rect,
      candidate,
      // 上一次被接受的位置 = 元素此刻渲染出来的位置（状态由 DOM 承载，无需另记）
      previous: self.offset,
      obstacles,
    })
    return { ...partial, offsetX: allowed.offsetX, offsetY: allowed.offsetY }
  }
  const updatePlacement = (id: CcLayoutWidgetId, placement: Partial<CcWidgetPlacement>) => {
    workbench.appearance.dispatch({ type: 'update-cc-placement', id, placement: allowedPlacement(id, placement) })
  }
  const beginHeightDrag = (event: PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const pointerId = event.pointerId
    const startHeight = appearance().ccHeight
    stopDragging?.()
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      workbench.appearance.dispatch({ type: 'set-cc-height', height: startHeight + startY - next.clientY })
    }
    const stop = (next?: PointerEvent) => {
      if (next && next.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (stopDragging === stop) stopDragging = undefined
    }
    stopDragging = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const setProperty = (command: CcPropertyCommand) => workbench.appearance.dispatch(command)
  // 注册轨控件（`cc-send-button`）没有 WIDGET_PROPERTY_FIELDS 条目 —— 属性面板只给
  // 布局四项，它的外观字段在设置页编辑。
  const propertyFields = (id: CcLayoutWidgetId) => {
    if (!(id in WIDGET_PROPERTY_FIELDS)) return []
    return WIDGET_PROPERTY_FIELDS[id as CcWidgetId].filter(field => !field.showIf || field.showIf({ inputMode: appearance().inputMode }))
  }
  const renderPropertyField = (field: WidgetPropertyField, index: number): JSX.Element | null => {
    if (field.kind === 'section') return <div class="cc-prop-sec" data-field-index={index}>{field.title}</div>
    const value = () => appearance().ccProperties[field.key]
    if (field.kind === 'color') return <div class="cc-prop-field"><label>{field.label}</label><input type="text" class="set-color-input" aria-label={field.label} value={String(value())} onChange={event => setProperty({ type: 'set-cc-property', key: field.key, value: event.currentTarget.value })} /></div>
    if (field.kind === 'number') return <div class="cc-prop-field"><label>{field.label}</label><input type="number" class="set-num" aria-label={field.label} value={Number(value())} min={field.min} max={field.max} step={field.step ?? 1} onInput={event => {
      const next = event.currentTarget.valueAsNumber
      if (Number.isFinite(next)) setProperty({ type: 'set-cc-property', key: field.key, value: Math.max(field.min, Math.min(field.max, next)) })
    }} />{field.suffix && <span>{field.suffix}</span>}</div>
    if (field.kind === 'chips') return <div class="cc-prop-field"><label>{field.label}</label><div class="set-preset-row"><For each={field.options}>{option => (
      <button type="button" class={`set-preset-chip${value() === option.value ? ' active' : ''}`} onClick={() => {
        setProperty({ type: 'set-cc-property', key: field.key, value: option.value })
        if (option.sync) setProperty({ type: 'set-cc-property', key: option.sync.key, value: option.sync.value })
      }}>{option.label}</button>
    )}</For></div></div>
    return null
  }

  /**
   * 信息控件容器（#238 刀3）：**一个落脚处一个容器**，不再是三个槽位包装 div。组内按 `order` 排。
   *
   * ★ #238 刀5B：**分隔点整族删除**（用户口径「分割点可以不要」）—— 这里不再插入 `·`；
   *   配套删掉的还有 `.cc-widget-separator` 样式、ControlCenter.css 里两条旧 `::before`
   *   回落规则、以及 WorkbenchChrome.css 里专门压住它们的那处 `content:none !important`。
   */
  const statusGroup = () => <div class="cc-status-group" data-cc-landing={INFO_LANDING}>
    <For each={idsForLanding(INFO_LANDING)}>{id => renderWidget(id)}</For>
  </div>

  // Keep empty-state/edit-mode controls available for session setup and layout
  // editing; hide the legacy status widgets from the active conversation view.
  const showStatusSlots = () => emptyVisual() || appearance().ccEditMode
  // 例外（2026-09-14）：常态放行的状态控件，见 ALWAYS_VISIBLE_STATUS_WIDGET_IDS。
  const hasAlwaysVisibleStatusWidget = () => ALWAYS_VISIBLE_STATUS_WIDGET_IDS
    .some(id => isWidgetVisible(id, visibilityContext()))
  const statusRowContent = () => showStatusSlots() || hasAlwaysVisibleStatusWidget()

  onMount(() => {
    const slot = controlCenterElement?.querySelector<HTMLElement>('.cc-input-slot')
    if (!slot) return
    const update = () => {
      const width = slot.getBoundingClientRect().width || slot.clientWidth
      if (width > 0) controlCenterElement?.style.setProperty('--cc-input-text-inset-x', `${width * 0.05}px`)
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(slot)
    onCleanup(() => observer?.disconnect())
  })

  return <div
    ref={node => { controlCenterElement = node }}
    class={`solid-workbench-control-center-slot control-center${appearance().inputMode === 'cli' ? ' cli-mode' : ''}${appearance().ccEditMode ? ' cc-editing' : ''} cc-variant-${appearance().ccVariant}${emptyVisual() ? ' is-empty' : ''}${sessionEntering() ? ' is-session-entering' : ''}${submitting() ? ' is-session-creating' : ''}`}
    data-control-center="production"
    data-creation-state={sessionEntering() ? 'entering' : submitting() ? 'creating' : undefined}
    role={!input().sessionId ? 'region' : undefined}
    aria-label={!input().sessionId ? 'Agent 工作台空态' : undefined}
    aria-busy={!input().sessionId ? submitting() : undefined}
    style={{
      '--cc-height': `${appearance().ccHeight}px`,
      '--cc-min-height': `${minHeight()}px`,
      '--cc-margin-x': `${appearance().ccMarginX}px`,
      '--cc-margin-bottom': `${appearance().ccMarginBottom}px`,
      '--cc-radius': `${appearance().ccRadius}px`,
      '--cc-surface-opacity': `${surfaceOpacityPercent()}%`,
      '--cc-surface': appearance().ccBg || 'transparent',
      '--cc-surface-image': toCssBackgroundImage(appearance().ccBgImage),
      '--cc-input-offset-top': `${appearance().inputOffsetTop}px`,
      '--cc-input-height': `${appearance().inputHeight}px`,
      '--cc-input-margin-x': `${appearance().inputMarginX}px`,
      '--cc-input-surface': appearance().inputSurfaceBg || 'transparent',
      '--cc-input-surface-opacity': `${inputSurfaceOpacityPercent()}%`,
      '--cc-input-focus-ring-enabled': appearance().inputFocusRingEnabled ? '1' : '0',
      '--cc-input-focus-ring-color': appearance().inputFocusRingColor || 'var(--accent)',
      '--cc-input-highlight-opacity': `${inputHighlightOpacityPercent()}%`,
      '--cc-input-shadow-enabled': appearance().inputShadowEnabled ? '1' : '0',
      '--cc-input-shadow': appearance().inputShadowEnabled
        ? '0 0 30px rgba(15,23,42,.22)'
        : 'none',
      // 光环独立于阴影（A6-1-FIX 1.3）：光环开启时只产出光环投影；关闭时不产出该变量，
      // CSS 侧 hover/focus-within 回退到常态投影（阴影关闭即无变化）。常态阴影开关只控制 --cc-input-shadow。
      '--cc-input-focus-ring-shadow': appearance().inputFocusRingEnabled
        ? '0 0 24px color-mix(in srgb, var(--cc-input-focus-ring-color, var(--input-focus-ring-color, var(--accent))) 55%, transparent)'
        : undefined,
      '--cc-input-radius': `${appearance().inputRadius}px`,
      '--cc-input-border': appearance().inputBorder || 'transparent',
      '--cc-input-border-width': `${appearance().inputBorderWidth}px`,
      '--cc-input-border-opacity': `${inputBorderOpacityPercent()}%`,
      '--cc-input-font-size': `${appearance().inputFontSize}px`,
      '--cc-input-line-height': appearance().inputLineHeight,
      '--cc-input-text': appearance().inputTextColor,
      '--cc-input-placeholder': appearance().inputPlaceholder,
      '--cc-send-size': `calc(var(--cc-input-height) * ${sendButtonMode() === 'inline' ? '0.8' : '1'})`,
      // ★ #238 刀3：发送按钮「右侧偏移」的来源改成定义表（`layout.x.gap`；
      //   现在是 0，所以像素与改造前完全一致）。剩下的 `calc()` 是"贴输入栏哪一侧"
      //   的**档位**（inline/external）与运行期尺寸（输入栏高/按钮大小），不是可声明的常量。
      '--cc-send-anchor-gap': `${resolveCcWidgetGroup('cc-send-button')?.layout?.x.gap ?? 0}px`,
      '--cc-send-color': appearance().sendButtonColor,
      '--cc-send-radius': `${Number(appearance().sendButtonRadius || '0.5') * 100}%`,
      '--cc-send-border-color': appearance().sendButtonBorderColor === 'black' ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.5)',
      '--cc-send-icon-color': appearance().sendButtonIconColor === 'black' ? '#000' : appearance().sendButtonIconColor === 'gray' ? 'rgba(0,0,0,.5)' : '#fff',
      '--cc-input-text-right-inset': sendButtonMode() === 'inline'
        ? 'calc(var(--cc-input-height) * 0.9 + var(--cc-input-text-inset-x, 5%))'
        : 'var(--cc-input-text-inset-x, 5%)',
    }}
  >
    <Show when={appearance().ccEditMode}><div
      class="cc-edit-hdr"
      role="separator"
      aria-label="调整中控高度"
      aria-orientation="horizontal"
      aria-valuemin={minHeight()}
      aria-valuemax="400"
      aria-valuenow={appearance().ccHeight}
      tabIndex="0"
      onPointerDown={beginHeightDrag}
      onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        workbench.appearance.dispatch({ type: 'set-cc-height', height: appearance().ccHeight + (event.key === 'ArrowUp' ? 4 : -4) })
      }}
    ><div class="cc-edit-hdr-bar" /><span class="cc-edit-hdr-label">{appearance().ccHeight}px</span></div></Show>
    <div class="cc-bg" data-cc-widget={ccSurfaceRegistered() ? 'cc-surface' : undefined} />
    <Show when={ccSendButtonRegistered() && sendButtonMode() && !appearance().ccHidden.includes('cc-send-button')}><SolidCcSendButton disabled={readonly() || submitting()} mode={sendButtonMode() as 'inline' | 'external'} /></Show>
    <div class="cc-input-shadow-clip" aria-hidden="true" />
    <div class="cc-body">
      {appearance().footerLayout === 'peri' ? <div class="cc-footer cc-footer-peri">
        <div class="cc-input-slot"><For each={idsForLanding(INPUT_LANDING)}>{renderWidget}</For></div>
        <div class="cc-footer-status">
          <Show when={SHOW_EMPTY_WORKSPACE_CONTROL && emptyVisual()}>
            <EmptyWorkspaceControl />
          </Show>
          <Show when={statusRowContent()}>{statusGroup()}</Show>
        </div>
      </div> : <>
        <div class="cc-input-slot"><For each={idsForLanding(INPUT_LANDING)}>{renderWidget}</For></div>
        <div class="cc-status-row"><Show when={SHOW_EMPTY_WORKSPACE_CONTROL && emptyVisual()}><EmptyWorkspaceControl /></Show><Show when={statusRowContent()}>{statusGroup()}</Show></div>
      </>}
    </div>
    <Show when={appearance().ccEditMode && selected()}>{id => (
      <div class="cc-prop-panel" role="dialog" aria-label={`${CC_WIDGET_LABELS[id()]} 属性`}>
        <div class="cc-prop-header"><span>{CC_WIDGET_LABELS[id()]}</span><button type="button" aria-label="关闭属性面板" onClick={() => setSelected(undefined)}>✕</button></div>
        <div class="cc-prop-body">
          <div class="cc-prop-sec">布局</div>
          <div class="cc-prop-field"><label>顺序</label><input type="number" class="set-num" aria-label="控件顺序" min="0" max="99" step="1" value={appearance().ccLayout.placements[id()].order} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) updatePlacement(id(), { order: value })
          }} /></div>
          <div class="cc-prop-field"><label>水平微调</label><input type="number" class="set-num" aria-label="水平微调" min="-48" max="48" step="1" value={appearance().ccLayout.placements[id()].offsetX} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) updatePlacement(id(), { offsetX: value })
          }} /><span>px</span></div>
          <div class="cc-prop-field"><label>垂直微调</label><input type="number" class="set-num" aria-label="垂直微调" min="-16" max="16" step="1" value={appearance().ccLayout.placements[id()].offsetY} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) updatePlacement(id(), { offsetY: value })
          }} /><span>px</span></div>
          <Show when={id() !== 'input'}><div class="cc-prop-field"><label>缩放</label><input type="number" class="set-num" aria-label="控件缩放" min="50" max="200" step="5" value={appearance().ccScale[id()] ?? 100} onInput={event => {
            const value = event.currentTarget.valueAsNumber
            if (Number.isFinite(value)) workbench.appearance.dispatch({ type: 'set-cc-scale', id: id(), scale: value })
          }} /><span>%</span></div></Show>
          <For each={propertyFields(id())}>{(field, index) => renderPropertyField(field, index())}</For>
        </div>
        <div class="cc-prop-footer"><button type="button" class="ps-btn sm" onClick={() => {
          setSelected(undefined)
          workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
        }}>退出自定义</button></div>
      </div>
    )}</Show>
    <Show when={appearance().ccEditMode}>
      <div class="cc-edit-toolbar" role="toolbar" aria-label="中控控件工具栏">
        <span class="cc-edit-toolbar-label">控件</span>
        <For each={CC_EDIT_TOOLBAR_IDS}>{id => {
          const hidden = () => appearance().ccHidden.includes(id)
          return <span class={`cc-edit-toolbar-chip-wrap${selected() === id ? ' active' : ''}${hidden() ? ' dim' : ''}`}>
            <button type="button" class="cc-edit-toolbar-chip" aria-label={`${CC_WIDGET_LABELS[id]} 属性`} onClick={() => setSelected(id)}>{hidden() ? '＋' : '●'} {CC_WIDGET_LABELS[id]}</button>
            <button type="button" class="cc-chip-toggle" aria-label={`${hidden() ? '显示' : '隐藏'} ${CC_WIDGET_LABELS[id]}`} onClick={() => workbench.appearance.dispatch({ type: 'set-cc-hidden', id, hidden: !hidden() })}>{hidden() ? '显示' : '隐藏'}</button>
          </span>
        }}</For>
        <button type="button" class="cc-edit-toolbar-btn" aria-label="重置控件位置" onClick={() => workbench.appearance.dispatch({ type: 'reset-cc-layout' })}>↺ 重置位置</button>
        <button type="button" class="cc-edit-toolbar-btn danger" aria-label="退出中控编辑" onClick={() => {
          setSelected(undefined)
          workbench.appearance.dispatch({ type: 'set-cc-edit-mode', enabled: false })
        }}>退出编辑</button>
      </div>
    </Show>
  </div>
}

function placementStyle(placement: CcWidgetPlacement): JSX.CSSProperties {
  return placement.offsetX === 0 && placement.offsetY === 0
    ? {}
    : { transform: `translate(${placement.offsetX}px, ${placement.offsetY}px)` }
}

function usageTokenCount(usage: UsageSnapshot | undefined, fallback: number): number {
  if (usage?.totalTokens !== undefined) return usage.totalTokens
  const parts = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
  return parts > 0 ? parts : Math.max(0, fallback)
}

function contextRatio(usage: UsageSnapshot | undefined, fallback: number): number {
  const explicit = usage?.contextPercent
  if (explicit !== undefined) return clamp01(explicit / 100)
  const limit = usage?.contextLimit ?? 0
  const used = usage?.contextUsed ?? usageTokenCount(usage, fallback)
  return limit > 0 ? clamp01(used / limit) : 0
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
}
