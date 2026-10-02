/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { appClients } from '../../app/appClients.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError'
import type { AdapterCatalogItem, AdapterInstance, GatewayInstanceInput } from '../../infrastructure/tauri/gatewayClient'
import { migrateLegacyRouteBindings, saveGatewayRouteTransaction, type GatewayRouteShape } from '../../application/transactions/saveGatewayRouteTransaction'
import { GATEWAY_ROUTE_RESETS, type GatewayRouteReset, type GatewayStatus, type GatewayWriteStatus, type PlatformSession } from '../../infrastructure/tauri/gatewayContracts.ts'
import { useIdentityStore } from '../../domains/identity/identityStore'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * GatewaySheetView — 网关平台概览（W3-01）+ 实例管理（I12-W5）+ 交互优化（P79）
 * + 视觉美化（P82：页头状态摘要、统一 section 卡片层级、状态点章、按钮分级、
 * 空态引导；classic 直角 / modern-gui 圆角双模式均沿 token 体系）。
 *
 * gateway_status 只读概览：适配器/平台会话两分区（GatewaySidebar）；主区平台概览
 * （routes 表 + inject 只读提示「归 Prism」不编辑）。I12-W5：实例分区展示真实
 * 实例/状态/错误/凭据状态与启停删操作；创建仅限 builtIn 平台（未实现平台不可用）；
 * 凭据提交后清空前端 secret state（不残留明文）。
 *
 * P79 交互优化：
 * - 实例状态轮询（3s，可见时才拉）：状态翻转（starting→connected/error）无后端
 *   推送通道，此前必须重开 sheet 才能看到「已连接」；
 * - 凭据表单按 catalog credentialFields 动态渲染（QQ = App ID + Client Secret 两框，
 *   提交按字段顺序 join ':'）——不再要求用户手拼单串；无字段描述的平台回退单框；
 * - 删除二段确认（误点保护，3s 自动回弹）。
 *
 * #515：Solid 实体，行为与 React 版逐行同构——一次性拉取的 effect 落 onMount，
 * 依赖响应值的 effect 落 createEffect（对照注释逐条标注）；文本输入 onChange→onInput。
 */

function statusLabel(status: AdapterInstance['status']): string {
  return status === 'connected' ? '已连接' : status === 'starting' ? '启动中' : status === 'error' ? '错误' : '已停止'
}

// 无字段描述平台的回退凭据框（模块级常量保持引用稳定，供 For 按引用去重）。
const FALLBACK_CREDENTIAL_FIELDS = [{ key: 'secret', label: '凭据（appId:clientSecret）', secret: true, required: true }]

const INSTANCE_REFRESH_MS = 3000
const DELETE_CONFIRM_MS = 3000

export interface GatewaySheetViewProps {
  sheet: SheetRecord
  ctx: SheetContext
}

export default function GatewaySheetView(props: GatewaySheetViewProps) {
  const sheetScope = createMemo<{ kind: 'sheet'; id: string }>(() => ({ kind: 'sheet', id: props.sheet.id }))
  const operationKey = (action: string, suffix = '') => `gateway:${props.sheet.id}:${action}${suffix ? `:${suffix}` : ''}`
  const gatewayClient = appClients.gateway()
  const [status, setStatus] = createSignal<GatewayStatus | null>(null)
  const [sessions, setSessions] = createSignal<PlatformSession[]>([])
  const [error, setError] = createSignal('')
  const [expandedRoute, setExpandedRoute] = createSignal<number | null>(null)
  const [editSource, setEditSource] = createSignal('')
  const [editAgentId, setEditAgentId] = createSignal('')
  // I12 W6（LR2-WI02）：新 route 表单——instance/profile/session 必填，其余可选
  const [editInstanceId, setEditInstanceId] = createSignal('')
  const [editProfileId, setEditProfileId] = createSignal('')
  const [editSessionKey, setEditSessionKey] = createSignal('')
  const [editReset, setEditReset] = createSignal<GatewayRouteReset>('idle')
  const [editIdleMinutes, setEditIdleMinutes] = createSignal('')
  const [editAllowFrom, setEditAllowFrom] = createSignal('')
  const [formError, setFormError] = createSignal('')
  const [writeStatus, setWriteStatus] = createSignal<GatewayWriteStatus>({ kind: 'idle' })
  // profile 只读消费（identityStore 仅查读，不写）
  const profiles = createZustandSignal(useIdentityStore, state => state.profiles)
  // I12-W5：实例/目录 + 操作反馈
  const [instances, setInstances] = createSignal<AdapterInstance[]>([])
  const [catalog, setCatalog] = createSignal<AdapterCatalogItem[]>([])
  const [instanceError, setInstanceError] = createSignal('')
  // P79：凭据草稿按 catalog 字段顺序存放（无字段描述的平台回退单框 = index 0）
  const [credentialDrafts, setCredentialDrafts] = createSignal<Record<string, string[]>>({})
  // P79：删除二段确认（null = 无待确认实例）
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null)
  const [createForm, setCreateForm] = createSignal<{ platform: string; id: string; label: string }>({ platform: '', id: '', label: '' })

  // W3-02 + FE-AUD-004：保存 = saveGatewayRouteTransaction（合并既有 routes → 保存 →
  // reload → read-back 一致才 ok）；锁中毒/回读 mismatch 明确展示
  // I12 W6（LR2-WI02）：新 route 必须绑定 instance/profile/session；既有 legacy route
  // 在保存时经 migrateLegacyRouteBindings 自动补绑定（平台唯一 enabled instance 时）
  const saveRoute = async () => {
    const route: GatewayRouteShape = {
      source: editSource().trim(),
      agentId: editAgentId().trim(),
      ...(editInstanceId() ? { instanceId: editInstanceId() } : {}),
      ...(editProfileId() ? { profileId: editProfileId() } : {}),
      ...(editSessionKey().trim() ? { sessionKey: editSessionKey().trim() } : {}),
      reset: editReset(),
      ...(editIdleMinutes().trim() !== '' ? { idleMinutes: Number(editIdleMinutes()) } : {}),
      ...(editAllowFrom().trim() ? { allowFrom: editAllowFrom().split(',').map(part => part.trim()).filter(Boolean) } : {}),
    }
    // 严格校验：新 route 必须绑定存在的 instance + 有效 profile/session（I12 W6）
    if (!route.instanceId) {
      setFormError('请选择实例：该 source 平台无可绑定实例（唯一 enabled instance 时自动选择）')
      return
    }
    if (!route.profileId) {
      setFormError('请选择 profile')
      return
    }
    if (!route.sessionKey) {
      setFormError('请输入 session')
      return
    }
    setFormError('')
    setWriteStatus({ kind: 'saving' })
    const enabledInstances = instances().filter(instance => instance.enabled)
    const readMigrated = async (): Promise<GatewayRouteShape[]> => {
      // SAFETY: 负载已经 normalizeGatewayStatus 收敛，但 gatewayClient 刻意只声明
      // Promise<unknown>——typed 消费发生在调用点（legacy 门禁 "raw as GatewayStatus" 亦断言此处）。
      // routes 的契约元素 GatewayRoute 与事务入参 GatewayRouteShape 字段同源，差别只在
      // reset 的必选/可选；该断言把契约快照交给事务侧校验（migrateLegacyRouteBindings +
      // upsertGatewayRoute 的 validateGatewayRoute），不引入未经验证的运行时形状。
      const existing = (await gatewayClient.status() as GatewayStatus).routes as unknown as GatewayRouteShape[]
      return migrateLegacyRouteBindings(existing, enabledInstances)
    }
    const result = await saveGatewayRouteTransaction(
      route,
      {
        readRoutes: readMigrated,
        saveRoutes: payload => gatewayClient.updateAgentsConfig(payload),
        reload: () => gatewayClient.reload(),
        readBackRoutes: readMigrated,
        reportError: (action, cause) => reportRuntimeError(action, cause, undefined, {
          key: operationKey(action), scope: sheetScope(), source: 'gateway',
        }),
      },
    )
    if (!result.ok) {
      // 命令缺失（旧版二进制）→ blocked；锁中毒/回读 mismatch 明确展示
      if (result.kind === 'blocked') setWriteStatus({ kind: 'blocked' })
      else if (result.kind === 'mismatch') {
        setWriteStatus({ kind: 'lock-poisoned' })
        reportRuntimeError('保存网关配置', new Error(result.message), undefined, {
          key: operationKey('保存网关配置'), scope: sheetScope(), source: 'gateway',
        })
      }
      else setWriteStatus({ kind: 'error', message: result.message })
      return
    }
    // FE-AUD-004：保存成功后用事务回读结果刷新 UI（status 不只挂载时读一次）
    setStatus({ ...(status() ?? { adapters: [], routes: [], qq: null, inject: null }), routes: result.value as GatewayStatus['routes'] })
    setWriteStatus({ kind: 'ok' })
    for (const action of ['读取网关路由', '保存网关配置', '重载网关', '回读网关状态']) {
      resolveRuntimeErrors({ key: operationKey(action) })
    }
  }

  // I12 W6：source 变化时，若平台恰好一个 enabled instance 则自动预选实例（可手动改）
  const onSourceChange = (value: string) => {
    setEditSource(value)
    const bound = migrateLegacyRouteBindings([{ source: value.trim(), agentId: editAgentId().trim() }], instances().filter(instance => instance.enabled))
    setEditInstanceId(bound[0]?.instanceId ?? '')
  }

  // W3-02：gateway_status 拉取（原 useEffect [gatewayClient, operationKey, sheet.id, sheetScope]
  // —— 挂载期一次性，sheet.id 变化即换 sheet 实例，落 onMount）。
  onMount(() => {
    let disposed = false
    gatewayClient.status().then(raw => {
      if (!disposed) {
        setStatus(raw as GatewayStatus)
        setError('')
        resolveRuntimeErrors({ key: operationKey('读取网关状态') })
      }
    }).catch(err => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取网关状态', err, undefined, {
          key: operationKey('读取网关状态'), scope: sheetScope(), source: 'gateway',
        })
      }
    })
    onCleanup(() => { disposed = true })
  })

  // Phase 2：平台会话（gateway_sessions 只读快照；挂载期一次性 → onMount）。
  onMount(() => {
    let disposed = false
    gatewayClient.sessions().then(raw => {
      if (!disposed) {
        setSessions(raw as PlatformSession[])
        resolveRuntimeErrors({ key: operationKey('读取平台会话') })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取平台会话', err, undefined, {
        key: operationKey('读取平台会话'), scope: sheetScope(), source: 'gateway',
      })
    })
    onCleanup(() => { disposed = true })
  })

  // I12-W5：实例列表 + 平台 catalog（创建表单可用平台与凭据字段来源）
  const reloadInstances = async () => {
    try {
      setInstances(await gatewayClient.instances())
      setInstanceError('')
      resolveRuntimeErrors({ key: operationKey('读取网关实例') })
    } catch (err) {
      setInstanceError(err instanceof Error ? err.message : String(err))
      reportRuntimeError('读取网关实例', err, undefined, {
        key: operationKey('读取网关实例'), scope: sheetScope(), source: 'gateway',
      })
    }
  }
  onMount(() => {
    let disposed = false
    void reloadInstances()
    gatewayClient.catalog().then(items => {
      if (!disposed) {
        setCatalog(items)
        resolveRuntimeErrors({ key: operationKey('读取平台目录') })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取平台目录', err, undefined, {
        key: operationKey('读取平台目录'), scope: sheetScope(), source: 'gateway',
      })
    })
    onCleanup(() => { disposed = true })
  })

  // P79：实例状态轮询——状态翻转（starting→connected/error）无后端推送通道，
  // 挂载期间低频轮询让「已连接/错误」自动可见（此前必须重开 sheet 才能看到）。
  onMount(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void reloadInstances()
    }, INSTANCE_REFRESH_MS)
    onCleanup(() => window.clearInterval(timer))
  })

  // P79：删除确认 3s 未二次点击自动回弹（原 useEffect [pendingDeleteId]）。
  createEffect(() => {
    const pending = pendingDeleteId()
    if (!pending) return
    const timer = window.setTimeout(() => setPendingDeleteId(null), DELETE_CONFIRM_MS)
    onCleanup(() => window.clearTimeout(timer))
  })

  const runInstanceAction = async (operation: string, action: () => Promise<unknown>) => {
    try {
      await action()
      // The mutation itself succeeded; retire its prior notification before
      // the follow-up snapshot read. A snapshot failure is tracked separately
      // under "读取网关实例" and must not make a successful mutation look
      // permanently failed.
      resolveRuntimeErrors({ key: operationKey(operation) })
      await reloadInstances()
    } catch (err) {
      setInstanceError(err instanceof Error ? err.message : String(err))
      reportRuntimeError(operation, err, undefined, {
        key: operationKey(operation), scope: sheetScope(), source: 'gateway',
      })
    }
  }

  const createInstance = async () => {
    const form = createForm()
    if (!form.platform || !form.id.trim()) return
    const input: GatewayInstanceInput = {
      platform: form.platform,
      id: form.id.trim(),
      label: form.label.trim() || form.id.trim(),
      enabled: true,
      autoStart: false,
    }
    await runInstanceAction('创建网关实例', () => gatewayClient.createInstance(input))
    setCreateForm({ platform: form.platform, id: '', label: '' })
  }

  const credentialFieldsFor = (platform: string) => {
    return catalog().find(item => item.platform === platform)?.credentialFields ?? []
  }

  const setCredentialDraft = (id: string, index: number, value: string) => {
    setCredentialDrafts(prev => {
      const current = prev[id] ?? []
      const next = [...current]
      next[index] = value
      return { ...prev, [id]: next }
    })
  }

  const submitCredentials = async (instance: AdapterInstance) => {
    const drafts = credentialDrafts()[instance.id] ?? []
    const secret = drafts.join(':')
    if (!secret) return
    await runInstanceAction('保存网关凭据', () => gatewayClient.setInstanceCredentials(instance.id, secret))
    // I12-W5：凭据提交后清空前端 secret state（明文不残留）
    setCredentialDrafts(prev => ({ ...prev, [instance.id]: [] }))
  }

  // P82：页头状态摘要（在线实例 / 路由 / 适配器）
  const availablePlatforms = createMemo(() => catalog().filter(item => item.availability === 'builtIn'))
  const connectedCount = createMemo(() => instances().filter(instance => instance.status === 'connected').length)

  // 样式绞杀（P93 批 3）：原 GatewaySheet.css 的 utility 化。gateway-* 类名保留为
  // gateway/styles/adaptive.css（modern-gui 覆写 + status-pulse 动画）锚点；
  // runtime-filter-input / template-apply 保留为底座消费与 adaptive 锚点；
  // file-main-*/search-result-* 共享词汇从 DOM 退役，基线值并入 utility。
  const SHEET = 'gateway-sheet flex-1 flex min-w-0 text-text font-[family-name:var(--font)]'
  // #154：左列几何归布局层的 .sidebar（见 SearchSheetView 同处说明）；本类只管内容样式。
  const SIDEBAR = 'sidebar gateway-sidebar flex flex-col py-6 px-3 bg-[color-mix(in_srgb,var(--bg-panel)_72%,transparent)]'
  const SECTION_TITLE = 'flex items-center gap-2 m-0 text-text text-[13px] font-[650] tracking-[.02em] before:content-[""] before:inline-block before:w-[3px] before:h-[14px] before:shrink-0 before:rounded-none before:bg-accent before:opacity-80 not-first:mt-6'
  const SIDEBAR_LIST = 'grid gap-1 m-0 p-0 list-none'
  const SIDEBAR_ITEM = 'flex items-center min-h-[var(--ui-control-compact)] px-3 border border-transparent rounded-none text-text-dim text-[12px] transition-[background-color,border-color,color] duration-[120ms] before:content-[""] before:inline-block before:w-1.5 before:h-1.5 before:mr-2 before:rounded-none before:bg-[var(--tool-ok)] before:shadow-[0_0_0_3px_var(--success-soft)] hover:border-border hover:bg-bg-hover hover:text-text'
  const SIDEBAR_ITEM_PATH = 'min-w-0 flex-1 overflow-hidden text-ellipsis text-accent font-[family-name:var(--mono)]'
  const SIDEBAR_ITEM_TEXT = 'text-text-dim max-w-[40%] overflow-hidden text-ellipsis whitespace-nowrap'
  const SIDEBAR_HINT = 'file-section-hint m-0 p-3 border border-dashed border-border rounded-none'
  const MAIN = 'gateway-main flex-1 min-w-0 py-6 px-[clamp(var(--ui-space-5),4vw,var(--ui-space-7))] overflow-y-auto'
  const TREE_ERROR = 'file-tree-error mb-4'
  const HINT = 'file-section-hint text-[12px] text-text-dim'
  const KICKER = 'font-mono text-[11px] font-[650] tracking-[.12em] text-accent'
  const MAIN_TITLE = 'mt-1 text-text text-[24px] font-bold tracking-[-.025em]'
  const HEADER = 'gateway-header flex items-end justify-between gap-4 flex-wrap mb-5'
  const SUMMARY = 'gateway-summary flex flex-wrap gap-2'
  const SUMMARY_CHIP = 'gateway-summary-chip inline-flex items-center gap-1 min-h-[26px] px-3 border border-border text-text-dim bg-bg-input font-[family-name:var(--mono)] text-[11px]'
  const SUMMARY_CHIP_ONLINE = 'gateway-summary-chip gateway-summary-chip-online inline-flex items-center gap-1 min-h-[26px] px-3 border border-success-edge text-text-dim bg-bg-input font-[family-name:var(--mono)] text-[11px]'
  const SUMMARY_NUM = 'text-text font-bold'
  const SECTION = 'gateway-section m-0 mb-5 p-4 border border-border rounded-none bg-bg-panel'
  const SECTION_HEAD = 'gateway-section-head flex items-baseline justify-between gap-3 flex-wrap m-0 mb-2'
  const SECTION_META = 'gateway-section-meta text-text-dim font-[family-name:var(--mono)] text-[11px]'
  const SECTION_HINT = 'gateway-section-hint m-0 mb-3 text-text-dim text-[12px]'
  const EMPTY = 'gateway-empty m-0 py-4 px-3 border border-dashed border-border text-text-dim text-[12px]'
  const ROUTES = 'gateway-routes flex flex-col gap-2'
  const ROUTE = 'gateway-route overflow-hidden border border-border rounded-none bg-bg-input transition-[border-color,background-color] duration-[120ms] hover:border-border-focus'
  const ROUTE_OPEN = 'gateway-route overflow-hidden border border-border-focus rounded-none bg-bg-input transition-[border-color,background-color] duration-[120ms]'
  const ROUTE_HEAD = 'gateway-route-head flex gap-3 items-center w-full min-h-[var(--ui-control-standard)] px-3 py-2 text-left text-text bg-transparent border-0 cursor-pointer font-[family-name:var(--font)] text-[12px] hover:bg-bg-hover aria-expanded:bg-bg-active aria-expanded:shadow-[inset_3px_0_0_var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const ROUTE_HEAD_PATH = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text font-[family-name:var(--mono)]'
  const ROUTE_HEAD_TEXT = 'shrink-0 text-text-dim whitespace-nowrap'
  const ROUTE_RESET = 'gateway-route-reset ml-auto text-text-dim font-[family-name:var(--mono)] text-[11px] whitespace-nowrap'
  const ROUTE_DETAIL = 'gateway-route-detail grid gap-1 p-3 border-t border-border bg-bg-panel text-[11px] text-text-dim [overflow-wrap:anywhere]'
  const ROUTE_DETAIL_FIELD = 'runtime-log-field flex gap-2 items-baseline min-h-[22px]'
  const ROUTE_DETAIL_CODE = 'runtime-log-field-code font-mono text-accent'
  const EDIT_ROW = 'gateway-edit-row flex gap-2 items-center mt-3'
  const FILTER_INPUT = 'runtime-filter-input flex-1 min-w-0'
  const TEMPLATE_BTN = 'template-apply min-w-[64px] h-[var(--ui-control-standard)] px-4 border border-border rounded-none text-text bg-bg-input cursor-pointer font-[family-name:var(--font)] text-[12px] transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-border-focus enabled:hover:bg-bg-hover disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const TEMPLATE_BTN_PRIMARY = 'template-apply gateway-btn-primary min-w-[64px] h-[var(--ui-control-standard)] px-4 cursor-pointer font-[family-name:var(--font)] text-[12px] font-[650] border border-accent-edge text-accent bg-accent-soft transition-[background-color,border-color,color] duration-[120ms] enabled:hover:border-accent-edge enabled:hover:bg-accent-soft-strong enabled:hover:text-accent disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const TEMPLATE_BTN_DANGER = 'template-apply gateway-btn-danger min-w-[64px] h-[var(--ui-control-standard)] px-4 cursor-pointer font-[family-name:var(--font)] text-[12px] font-[650] border border-danger-edge text-danger bg-danger-soft transition-[background-color,border-color,color] duration-[120ms] enabled:hover:bg-danger-soft-strong disabled:opacity-[0.42] disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const FIELD_ROW = 'gateway-field grid grid-cols-[88px_1fr] gap-3 items-baseline min-h-[24px] text-[12px] border-b border-dashed border-[color-mix(in_srgb,var(--border)_60%,transparent)] last:border-b-0'
  const FIELD_LABEL = 'gateway-field-label text-text-dim'
  const FIELD_VALUE = 'gateway-field-value text-text wrap-anywhere'
  const INSTANCE_LIST = 'gateway-instance-list block m-0 p-0 list-none'
  const INSTANCE_CARD = 'gateway-instance-card flex flex-col gap-2 p-3 mb-3 border border-border rounded-none bg-bg-input'
  const INSTANCE_CARD_ERROR = 'gateway-instance-card gateway-instance-card-error flex flex-col gap-2 p-3 mb-3 border border-danger-edge rounded-none bg-bg-input'
  const INSTANCE_HEAD = 'gateway-instance-head flex items-center gap-2 flex-wrap'
  const INSTANCE_STATUS_CONNECTED = 'gateway-instance-status gateway-instance-status-connected inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-success-soft text-success'
  const INSTANCE_STATUS_ERROR = 'gateway-instance-status gateway-instance-status-error inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-danger-soft text-danger'
  const INSTANCE_STATUS_STARTING = 'gateway-instance-status gateway-instance-status-starting gateway-status-pulse inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-warning-soft text-warning'
  const INSTANCE_STATUS_STOPPED = 'gateway-instance-status gateway-instance-status-stopped inline-flex items-center gap-[5px] text-[0.85em] px-2 py-[1px] rounded-full bg-[var(--bg-muted,#f0f0f0)] text-[var(--text-dim,#666)]'

  return (
    <div class={SHEET}>
      <aside class={SIDEBAR}>
        <div class={SECTION_TITLE}>适配器</div>
        <Show when={(status()?.adapters.length ?? 0) > 0} fallback={<p class={SIDEBAR_HINT}>无适配器</p>}>
          <ul class={SIDEBAR_LIST}>
            <For each={status()!.adapters}>{adapter => (
              <li class={SIDEBAR_ITEM}><span class={SIDEBAR_ITEM_PATH}>{adapter}</span></li>
            )}</For>
          </ul>
        </Show>
        <div class={SECTION_TITLE}>平台会话</div>
        <Show when={sessions().length > 0} fallback={<p class={SIDEBAR_HINT}>无平台会话</p>}>
          <ul class={SIDEBAR_LIST}>
            <For each={sessions()}>{session => (
              <li class={SIDEBAR_ITEM}>
                <span class={SIDEBAR_ITEM_PATH}>{session.source}</span>
                <span class={SIDEBAR_ITEM_TEXT}>→ {session.agentId} · {session.reset}</span>
              </li>
            )}</For>
          </ul>
        </Show>
      </aside>
      <main class={MAIN}>
        <Show when={error()}><p class={HINT} role="status">网关状态读取失败，详情见右下角错误中心</p></Show>
        <header class={HEADER}>
          <div>
            <div class={KICKER}>GATEWAY</div>
            <h2 class={MAIN_TITLE}>平台概览</h2>
          </div>
          <div class={SUMMARY} aria-label="网关状态摘要">
            <span class={SUMMARY_CHIP}><span class={SUMMARY_NUM}>{instances().length}</span> 实例</span>
            <span class={SUMMARY_CHIP_ONLINE}><span class={`${SUMMARY_NUM} text-success`}>{connectedCount()}</span> 在线</span>
            <span class={SUMMARY_CHIP}><span class={SUMMARY_NUM}>{status()?.routes.length ?? 0}</span> 路由</span>
            <span class={SUMMARY_CHIP}><span class={SUMMARY_NUM}>{status()?.adapters.length ?? 0}</span> 适配器</span>
          </div>
        </header>

        <section class={SECTION}>
          <div class={SECTION_HEAD}>
            <h3 class={SECTION_TITLE}>路由</h3>
            <span class={SECTION_META}>{status()?.routes.length ?? 0} 条 · 点击展开详情</span>
          </div>
          <Show when={Boolean(status()) && status()!.routes.length === 0} fallback={
            <div class={ROUTES}>
              <For each={status()?.routes ?? []}>{(route, index) => (
                <div class={expandedRoute() === index() ? ROUTE_OPEN : ROUTE}>
                  <button type="button" class={ROUTE_HEAD} aria-expanded={expandedRoute() === index()} onClick={() => setExpandedRoute(expandedRoute() === index() ? null : index())}>
                    <span class={ROUTE_HEAD_PATH}>{route.source}</span>
                    <span class={ROUTE_HEAD_TEXT}>→ {route.agentId}</span>
                    <span class={ROUTE_RESET}>{route.reset}</span>
                  </button>
                  <Show when={expandedRoute() === index()}>
                    <div class={ROUTE_DETAIL}>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>instanceId</code> = {route.instanceId || '—（未绑定实例）'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>profileId</code> = {route.profileId || '—'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>sessionKey</code> = {route.sessionKey || '—'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>allowFrom</code> = {(route.allowFrom || []).join(', ') || '—'}</div>
                      <div class={ROUTE_DETAIL_FIELD}><code class={ROUTE_DETAIL_CODE}>idleMinutes</code> = {route.idleMinutes ?? '—'}</div>
                    </div>
                  </Show>
                </div>
              )}</For>
            </div>
          }>
            <p class={EMPTY}>还没有路由——在下方「新增路由」把平台会话（如 qq 群）绑定到 agent</p>
          </Show>
        </section>

        <section class={SECTION}>
          <div class={SECTION_HEAD}>
            <h3 class={SECTION_TITLE}>新增路由</h3>
          </div>
          <p class={SECTION_HINT}>把平台会话（source）绑定到 agent：实例 / profile / session 为必填，其余可选</p>
          <div class={EDIT_ROW}>
            <input class={FILTER_INPUT} placeholder="source（如 qq:group:123）" value={editSource()} onInput={e => onSourceChange(e.currentTarget.value)} aria-label="路由 source" />
            <input class={FILTER_INPUT} placeholder="agentId（如 peri）" value={editAgentId()} onInput={e => setEditAgentId(e.currentTarget.value)} aria-label="路由 agentId" />
          </div>
          <div class={EDIT_ROW}>
            <select class={FILTER_INPUT} aria-label="路由 instance" value={editInstanceId()} onChange={e => setEditInstanceId(e.currentTarget.value)}>
              <option value="">选择实例</option>
              <For each={instances()}>{instance => (
                <option value={instance.id}>{instance.label || instance.id}（{instance.platform}）{instance.enabled ? '' : '· 未启用'}</option>
              )}</For>
            </select>
            <select class={FILTER_INPUT} aria-label="路由 profile" value={editProfileId()} onChange={e => setEditProfileId(e.currentTarget.value)}>
              <option value="">选择 profile</option>
              <For each={profiles()}>{profile => (
                <option value={profile.id}>{profile.name || profile.id}</option>
              )}</For>
            </select>
            <input class={FILTER_INPUT} placeholder="session（如 战役1）" value={editSessionKey()} onInput={e => setEditSessionKey(e.currentTarget.value)} aria-label="路由 session" />
          </div>
          <div class={EDIT_ROW}>
            <select class={FILTER_INPUT} aria-label="路由 reset" value={editReset()} onChange={e => setEditReset(e.currentTarget.value as GatewayRouteReset)}>
              <For each={GATEWAY_ROUTE_RESETS}>{reset => (
                <option value={reset}>{reset}</option>
              )}</For>
            </select>
            <input class={FILTER_INPUT} placeholder="idleMinutes（可选）" type="number" min="0" value={editIdleMinutes()} onInput={e => setEditIdleMinutes(e.currentTarget.value)} aria-label="路由 idleMinutes" />
            <input class={FILTER_INPUT} placeholder="allowFrom（逗号分隔，可选）" value={editAllowFrom()} onInput={e => setEditAllowFrom(e.currentTarget.value)} aria-label="路由 allowFrom" />
            <button type="button" class={TEMPLATE_BTN_PRIMARY} onClick={() => void saveRoute()}>保存</button>
          </div>
          <Show when={formError()}><div class={TREE_ERROR} role="alert">{formError()}</div></Show>
          <Show when={writeStatus().kind === 'blocked'}><p class={HINT} role="status">后端命令不可用：update_agents_config（请检查应用版本）</p></Show>
          <Show when={writeStatus().kind === 'lock-poisoned'}><p class="file-section-hint gateway-error-reference" role="status">网关配置回读不一致，详情见右下角错误中心</p></Show>
          <Show when={writeStatus().kind === 'error'}><p class="file-section-hint gateway-error-reference" role="status">网关配置保存失败，详情见右下角错误中心</p></Show>
          <Show when={writeStatus().kind === 'ok'}><p class={HINT} role="status">已保存并重载</p></Show>
        </section>

        {/* I12-W5：实例管理（真实实例/状态/错误/操作；未实现平台不可用） */}
        <section class={SECTION}>
          <div class={SECTION_HEAD}>
            <h3 class={SECTION_TITLE}>实例</h3>
            <span class={SECTION_META}>状态每 {INSTANCE_REFRESH_MS / 1000} 秒自动刷新</span>
          </div>
          <p class={SECTION_HINT}>启动前需配置凭据；状态翻转自动刷新，无需重开页面</p>
          <Show when={instanceError()}><p class={HINT} role="status">网关实例操作失败，详情见右下角错误中心</p></Show>
          <Show when={instances().length === 0} fallback={
            <ul class={INSTANCE_LIST}>
              <For each={instances()}>{instance => {
                // For 的 item 映射每项只跑一次（untrack）——随 catalog 变化的值必须收进
                // 访问器，让 JSX 模板内的 getter 逐处追踪（原 React 每渲染重算的等价）。
                const fields = () => credentialFieldsFor(instance.platform)
                const drafts = () => credentialDrafts()[instance.id] ?? []
                const readyToSave = () => fields().length > 0
                  ? fields().every((field, index) => !field.required || (drafts()[index] ?? '').length > 0)
                  : (drafts()[0] ?? '').length > 0
                const statusCls = instance.status === 'connected' ? INSTANCE_STATUS_CONNECTED
                  : instance.status === 'error' ? INSTANCE_STATUS_ERROR
                  : instance.status === 'starting' ? INSTANCE_STATUS_STARTING
                  : INSTANCE_STATUS_STOPPED
                return (
                  <li class={instance.status === 'error' ? INSTANCE_CARD_ERROR : INSTANCE_CARD}>
                    <div class={INSTANCE_HEAD}>
                      <span class="search-result-path">{instance.label || instance.id}</span>
                      <span class={statusCls}>{statusLabel(instance.status)}</span>
                      <span class="search-result-text">· {instance.platform}</span>
                      <span class="search-result-text">凭据：{instance.credentialStatus === 'configured' ? '已配置' : instance.credentialStatus === 'invalid' ? '损坏' : '未配置'}</span>
                    </div>
                    <Show when={instance.lastError}><p class="file-section-hint" role="status">上次运行错误：{instance.lastError}</p></Show>
                    <div class={EDIT_ROW}>
                      <button type="button" class={TEMPLATE_BTN_PRIMARY} disabled={instance.status === 'starting'} onClick={() => void runInstanceAction('启动网关实例', () => gatewayClient.startInstance(instance.id))}>启动</button>
                      <button type="button" class={TEMPLATE_BTN} disabled={instance.status === 'stopped' || instance.status === 'starting'} onClick={() => void runInstanceAction('停止网关实例', () => gatewayClient.stopInstance(instance.id))}>停止</button>
                      <button type="button" class={TEMPLATE_BTN} disabled={instance.status === 'starting'} onClick={() => void runInstanceAction('重启网关实例', () => gatewayClient.restartInstance(instance.id))}>重启</button>
                      <Show when={pendingDeleteId() === instance.id} fallback={
                        <button type="button" class={TEMPLATE_BTN} disabled={instance.status !== 'stopped'} aria-label={`删除 ${instance.id}`} onClick={() => setPendingDeleteId(instance.id)}>删除</button>
                      }>
                        <button type="button" class={TEMPLATE_BTN_DANGER} aria-label={`确认删除 ${instance.id}`} onClick={() => {
                          setPendingDeleteId(null)
                          void runInstanceAction('删除网关实例', () => gatewayClient.removeInstance(instance.id))
                        }}>确认删除</button>
                      </Show>
                    </div>
                    {/* P79：凭据字段按 catalog credentialFields 渲染（secret → 密码框）；
                        提交按字段顺序 join ':'；无字段描述的平台回退单框。 */}
                    <div class={EDIT_ROW}>
                      <For each={(fields().length > 0 ? fields() : FALLBACK_CREDENTIAL_FIELDS)}>{(field, index) => (
                        <input
                          class={FILTER_INPUT}
                          type={field.secret ? 'password' : 'text'}
                          placeholder={`${field.label}${field.required ? '' : '（可选）'}`}
                          value={drafts()[index()] ?? ''}
                          onInput={e => setCredentialDraft(instance.id, index(), e.currentTarget.value)}
                          aria-label={`${instance.id} ${field.label}`}
                          autocomplete="off"
                        />
                      )}</For>
                      <button type="button" class={TEMPLATE_BTN} disabled={!readyToSave()} onClick={() => void submitCredentials(instance)}>保存凭据</button>
                    </div>
                  </li>
                )
              }}</For>
            </ul>
          }>
            <p class={EMPTY}>还没有实例——在下方「新建实例」创建，配置凭据后启动</p>
          </Show>
          <div class={`${SECTION_HEAD} gateway-section-head-sub`}>
            <h3 class={SECTION_TITLE}>新建实例</h3>
          </div>
          <p class={SECTION_HINT}>仅显示已实现平台；创建后配置凭据并启动。未实现平台（如微信）不可创建。</p>
          <Show when={availablePlatforms().length === 0} fallback={
            <div class={EDIT_ROW}>
              <select class={FILTER_INPUT} aria-label="平台" value={createForm().platform} onChange={e => setCreateForm(prev => ({ ...prev, platform: e.currentTarget.value }))}>
                <option value="">选择平台</option>
                <For each={availablePlatforms()}>{item => <option value={item.platform}>{item.label}</option>}</For>
              </select>
              <input class={FILTER_INPUT} placeholder="实例 id" value={createForm().id} onInput={e => setCreateForm(prev => ({ ...prev, id: e.currentTarget.value }))} aria-label="实例 id" />
              <input class={FILTER_INPUT} placeholder="标签（可选）" value={createForm().label} onInput={e => setCreateForm(prev => ({ ...prev, label: e.currentTarget.value }))} aria-label="实例标签" />
              <button type="button" class={TEMPLATE_BTN} disabled={!createForm().platform || !createForm().id.trim()} onClick={() => void createInstance()}>创建</button>
            </div>
          }>
            <p class="file-section-hint">无可用平台（未实现平台不可用）</p>
          </Show>
        </section>

        {/* I12 W9：未绑定消息策略只读展示（明示风险——reject 模式未绑定消息不进入 agent） */}
        <Show when={status()?.unboundPolicy}>
          <section class={SECTION}>
            <div class={SECTION_HEAD}>
              <h3 class={SECTION_TITLE}>未绑定消息策略</h3>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>策略</span>
              <span class={FIELD_VALUE}>{status()!.unboundPolicy === 'reject' ? '严格模式（reject）：未绑定路由的消息将被拒绝，不会回退到 active agent' : '宽松模式（active-agent）：未绑定路由的消息回退到 active agent'}</span>
            </div>
          </section>
        </Show>
        <Show when={status()?.inject}>
          <section class={SECTION}>
            <div class={SECTION_HEAD}>
              <h3 class={SECTION_TITLE}>知识注入</h3>
              <span class={SECTION_META}>归 Prism 管理 · 只读</span>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>注入开关</span>
              <span class={FIELD_VALUE}>{status()!.inject!.enabled == null ? '—' : status()!.inject!.enabled ? '开启' : '关闭'}</span>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>注入场景</span>
              <span class={FIELD_VALUE}>{status()!.inject!.scenario || '跟随 Prism active.scenario'}</span>
            </div>
            <div class={FIELD_ROW}>
              <span class={FIELD_LABEL}>完成持久化</span>
              <span class={FIELD_VALUE}>{status()!.inject!.persist === 'prism' ? '写入 Prism（persist）' : status()!.inject!.persist || '—'}</span>
            </div>
          </section>
        </Show>
      </main>
    </div>
  )
}
