import { Fragment, useMemo, useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { createAgentClient } from '../infrastructure/acp/agentClient'
import { ZoneGroupFields } from '../themeFieldRenderer'
import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { applyToolDictionaryThroughPort } from '../app/ports/productContributionPorts.ts'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import { INTERFACE_MODE_PRESET_BUCKET, fallbackPresetChip, presetsForInterfaceMode } from '../presets/index.ts'
import { isCustomZonePresetEntry, resolveZonePresetEntryTheme, zonePresetsFor, type ZonePresetEntry } from '../zones/index.ts'
import { useWorkspaceStore } from '../workspaceStore'
import { normalizeCustomPresetId, pickCustomPresetTheme } from '../customPresets'
import type { PresetApplyResult } from '../domains/theme/presetBundle.ts'
import { deriveGlobalStatus, deriveZoneStatus } from '../domains/theme/presetReducer'
import SettingsPreview from './SettingsPreview'
import { reportRuntimeDiagnostic, reportRuntimeError, resolveRuntimeErrors } from '../runtimeError'
import { pulseSettingsAnchor } from '../utils/anchorPulse.ts'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { reloadAgentsTransaction } from '../application/transactions/reloadAgentsTransaction.ts'
import { applyGlobalPreset as applyGlobalPresetTransaction } from '../application/transactions/applyGlobalPreset.ts'
import { normalizeAgentStatus, selectAgentStatus, statusLabel } from './settings/agentTypes'
import { runReconnectCommand } from './settings/reconnectCommand'
import AgentRuntimePanel from './settings/AgentRuntimePanel'
import AgentConfigEditor from './settings/AgentConfigEditor'
import ConfigOptionsPanel from './settings/ConfigOptionsPanel'
import TemplateLibrary from './settings/TemplateLibrary'
import WindowPanel from './settings/WindowPanel'
import ConfigBackupPanel from './settings/ConfigBackupPanel'
import HistoryRetention from './settings/HistoryRetention'
import GatewayRiskPanel from './settings/GatewayRiskPanel'
import InputPredictionSettingsPanel from './settings/InputPredictionSettingsPanel'
import PluginManager from './settings/PluginManager'
import PresentationProfilePicker from './settings/PresentationProfilePicker'
import RendererSettingsPanel from './settings/RendererSettingsPanel'
import RendererSettingsPreview from './settings/RendererSettingsPreview.tsx'
import type { RendererSettingsCatalogEntry } from './settings/rendererSettingsCatalog.ts'
import PluginSettingsPageHost from './settings/PluginSettingsPageHost'
import InterfaceModePicker from './settings/InterfaceModePicker.tsx'
import SettingsSectionHeader from './settings/SettingsSectionHeader.tsx'
import SettingsQuickSearch from './settings/SettingsQuickSearch.tsx'
import { readDensity, writeDensity, readPreviewCollapsed, writePreviewCollapsed, safeStorage, type SettingsDensity } from './settings/settingsChromeState.ts'
import { getPluginServiceRegistry } from '../plugin-runtime/runtimeServices.ts'
import HookDiagnosticsPanel from './settings/HookDiagnosticsPanel.tsx'
import { useRightRailStore } from '../rightRailStore.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
// I13-W1：Settings 一级信息架构唯一真值（domain → section + 字段归属派生）
import { SETTINGS_DOMAINS, SETTINGS_SECTION_LABELS, sectionZone, type SettingsDomainId, type SettingsSectionId } from '../settingsDomains'
import type { WorkspaceViewProps } from '../workspace-sheets/workspaceTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import { useSettingsContributionCatalog } from './settings/useSettingsContributionCatalog.ts'
import SidebarModulesPanel from './settings/SidebarModulesPanel.tsx'

// FE-AUD-008：typed client 收口 agent 域 command literal
const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })

// ── helpers ──

function Group({ title, children, defaultOpen }: { title:string; children:React.ReactNode; defaultOpen?:boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="set-group">
      <button type="button" className="set-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-group-arrow">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  )
}

/**
 * 刀6（#206）：区域预设行。候选不再是「平铺 10 个整体预设」，而是该
 * (界面模式桶, 区域) 的池条目——出厂条目（存引用，应用时现场切）+ 自定义条目（存值快照）。
 * 未登记归属桶的界面模式（如 tactical-blue）⇒ 池为空 ⇒ **整组不渲染**（与刀5 同口径）。
 */
function ZonePresetRow({ zone, interfaceMode, activeName, isDirty, onApply, onSaveCurrent, onRemoveEntry }: {
  zone: ZonePresetEntry['zone']; interfaceMode: string; activeName: string; isDirty: boolean
  onApply: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveCurrent: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveEntry: (id: string) => void
}) {
  const customEntries = useStore(s => s.zonePresetEntries)
  const entries = zonePresetsFor(interfaceMode, zone, customEntries)
  const [entryName, setEntryName] = useState('')
  // 刀7 前置（#211）：行内两段式确认的待删条目（照全局自定义预设先例，不常驻、不开模态）
  const [pendingDeleteEntryId, setPendingDeleteEntryId] = useState<string | null>(null)
  if (entries.length === 0) return null
  return (
    <Group title="局部预设">
      <div className="set-preset-row">
        {entries.map(entry => {
          const selected = activeName === entry.id && !isDirty
          // 刀7 前置（#211）出现条件：**只在自定义条目**上；普通条目「被选中才出现」
          // （那排 chip 本来就挤），Q8 灰显占位条目常驻——那是它唯一的自然出口。
          // 刀2（#223）起判据是显式来源字段 `origin`：出厂条目（`origin:'factory'`）**任何情况下**
          // 都不进入这一段（铁律 1：出厂件不可改、不可删）。
          const deletable = isCustomZonePresetEntry(entry) && (entry.stale === true || selected)
          return (
            <Fragment key={entry.id}>
              <button type="button"
                className={`set-preset-chip ${selected ? 'active' : ''}`}
                aria-current={selected ? 'true' : undefined}
                // Q8：清理后已无有效字段的自定义条目 = 行内占位（灰显、不可应用）；不给用户开关。
                disabled={entry.stale === true}
                title={entry.stale
                  ? '该条目引用的字段已被删除，值已自动清理，不能再应用'
                  : undefined}
                onClick={() => onApply(zone, entry)}>{entry.label}</button>
              {deletable && (pendingDeleteEntryId === entry.id ? (
                <div className="set-confirm set-confirm-inline" role="alertdialog" aria-label={`确认删除区域预设 ${entry.label}`}>
                  <span className="set-confirm-text">删除后不可恢复；将移除本区的自定义条目「{entry.label}」，本区保留现值但失去该预设基准。</span>
                  <div className="set-confirm-actions">
                    <button type="button" className="ps-btn sm danger"
                      onClick={() => { setPendingDeleteEntryId(null); onRemoveEntry(entry.id) }}>确认删除</button>
                    <button type="button" className="ps-btn sm" onClick={() => setPendingDeleteEntryId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <button type="button" className="ps-btn sm danger"
                  onClick={() => setPendingDeleteEntryId(entry.id)}>删除</button>
              ))}
            </Fragment>
          )
        })}
        {isDirty && <span className="set-preset-chip active">自定义</span>}
      </div>
      <div className="set-hint">只改本区外观参数，自动切换为自定义；改动后可存成属于本区的自定义条目</div>
      <div className="set-custom-preset-save">
        <input className="set-input" value={entryName} onChange={event => setEntryName(event.target.value)} placeholder="区域预设名称" />
        <button type="button" className="ps-btn sm" disabled={!entryName.trim()} title={entryName.trim() ? undefined : '保存必须命名'}
          onClick={() => { onSaveCurrent(zone, entryName); setEntryName('') }}>存当前</button>
      </div>
    </Group>
  )
}

// ── main ──

export default function Settings({ sheet, ctx, state }: WorkspaceViewProps<SettingsSheetState>) {
  // #154 阶段 4：设置由固定覆盖层迁入 sheet 体系。导航真值（domain/section/pluginPageId/
  // agentId）改为 sheet 状态（持久化、随 workspace 布局落盘），本组件只保留视图局部态。
  // 深链 `pylon:open-settings` 的打开/聚焦/patch 由 App 层 openOrFocusSettingsSheet 统一处理。
  const activeDomain = state.domain
  const activeSection = state.section
  const activePluginPageId = state.pluginPageId ?? null
  const navigate = (partial: {
    domain?: SettingsDomainId
    section?: SettingsSectionId
    pluginPageId?: string | null
    agentId?: string | null
    rendererCategoryId?: string | null
  }) => useWorkspaceStore.getState().patchSheetState(sheet.id, partial as Record<string, unknown>)

  // 只订阅主题字段 + ccEditMode：后台生成时的 live 状态（token/生成源）不再穿透整棵设置树。
  // pickCustomPresetTheme 白名单覆盖 Settings 全部 t.xxx 访问（已核对），ccEditMode 单独补。
  const t = useStore(useShallow(s => ({
    ...pickCustomPresetTheme(s),
    ccEditMode: s.ccEditMode,
  } as ThemeSettings & { ccEditMode: boolean })))
  // #116 子项 9：破坏性操作（重置主题 / 删除自定义预设）原先一击即生效、无撤销点，
  // 故补两段式确认：第一次点击只进入待确认态，确认才真正执行。
  // #154 阶段 4：重置主题确认块整体迁往左栏导航（SettingsSheetSidebar）。
  const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null)
  const resetZone = useStore(s => s.resetZone)
  const setZoneField = useStore(s => s.setZoneField)
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const applyZonePreset = useStore(s => s.applyZonePreset)
  const appliedPreset = useStore(s => s.appliedPreset)
  const custom = useStore(s => s.custom)
  // A2：全局预设状态派生（任一 zone 触碰/基准不一致 → custom），原 appliedPreset.global 直读退役
  const globalStatus = useStore(s => deriveGlobalStatus(s))
  // 刀5（#201，UI 二次修订 2026-09-19）：预设区直接显示当前界面模式对应的预设
  // （presetsForInterfaceMode），随界面模式切换自动跟随；「GUI / 终端」的选择只在
  // 「界面模式」Group 里发生。当前模式不在归属表内（如 tactical-blue）⇒ 整组不出现。
  const currentInterfaceMode = useInterfaceModeStore(s => s.interfaceMode)
  const modeBucket = INTERFACE_MODE_PRESET_BUCKET[currentInterfaceMode]
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const setAgentStatus = useRuntimeStore(s => s.setAgentStatus)
  const setActiveAgent = useIdentityStore(s => s.setActiveAgent)
  const customPresets = useStore(s => s.customPresets)
  /** #116 子项 7：预设行兜底 chip 的口径见 presets.ts 的 fallbackPresetChip。 */
  const fallbackPresetChipView = fallbackPresetChip(globalStatus, customPresets.map(preset => preset.id))
  const sessions = useIdentityStore(s => s.sessions)
  // I01-W2：动态配置按 AgentContext（agentId+source）读写
  const activeSessionId = ctx.activeSession
  const activeSessionContext = (() => {
    const session = sessions.find(session => session.id === activeSessionId)
    return session ? { agentId: session.agentId, source: session.source } : undefined
  })()
  const saveCustomPreset = useStore(s => s.saveCustomPreset)
  const applyCustomPreset = useStore(s => s.applyCustomPreset)
  const removeCustomPreset = useStore(s => s.removeCustomPreset)
  // 刀6（#206）：区域预设池自定义条目的存入口 + Q8 落盘清理（每次打开设置过一遍，
  // 读入容错也在此收口；无变化不写状态）。
  const saveZonePresetEntry = useStore(s => s.saveZonePresetEntry)
  const pruneZonePresetEntries = useStore(s => s.pruneZonePresetEntries)
  const removeZonePresetEntry = useStore(s => s.removeZonePresetEntry)
  useEffect(() => { pruneZonePresetEntries() }, [pruneZonePresetEntries])
  // I13-W1：导航状态收敛为 activeDomain/activeSection（settingsDomains 驱动）
  // #154 阶段 4：activeDomain/activeSection/activePluginPageId 已在函数顶部由 sheet 状态派生。
  const { settingsContributionCatalog, pluginSettingsPages, rendererRegistrySnapshot, activeRendererSuiteId } = useSettingsContributionCatalog()
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)
  const [searchQuery, setSearchQuery] = useState('')
  // #154 阶段 4：renderers 分类导航位随 sheet 状态持久化（侧栏三级项与速搜命中同源）。
  const rendererCategoryId = state.rendererCategoryId ?? 'markdown-text'
  const [rendererObjectKey, setRendererObjectKey] = useState<string | undefined>()
  const [rendererPreviewEntry, setRendererPreviewEntry] = useState<RendererSettingsCatalogEntry>()
  const [customPresetName, setCustomPresetName] = useState('')
  const [customPresetFeedback, setCustomPresetFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [applyingPresetId, setApplyingPresetId] = useState<string | null>(null)
  const presetApplyRequest = useRef(0)
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null)
  const [reconnectPending, setReconnectPending] = useState(false)
  const [reconnectCommandError, setReconnectCommandError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [dictFeedback, setDictFeedback] = useState<string | null>(null)
  const currentStatus = selectAgentStatus(activeAgent, activeAgent, agentStatuses)

  const reportSettingsError = (action: string, error: unknown, agentId?: string) => reportRuntimeError(action, error, agentId, {
    key: `settings:${action}:${agentId ?? 'app'}`,
    scope: agentId ? { kind: 'agent', id: agentId } : { kind: 'app', id: 'settings' },
    source: 'settings',
    recovery: { kind: 'open-runtime-log', agentId },
  })
  const resolveSettingsError = (action: string, agentId?: string) => resolveRuntimeErrors({
    key: `settings:${action}:${agentId ?? 'app'}`,
  })

  // #154 阶段 4：旧覆盖层时代的「已挂载时消费 open-settings 事件」监听删除——
  // App 层 openOrFocusSettingsSheet 对已打开的设置 sheet 直接 patch 导航态并聚焦。

  // 应用全局预设
  const applyGlobalPreset = (name: string) => {
    applyGlobalPresetTransaction(name)
  }

  const applyCustomPresetTransaction = (requestedId: string): Promise<PresetApplyResult> =>
    applyCustomPreset(normalizeCustomPresetId(requestedId))

  const applyCustomPresetFromSettings = async (requestedId: string): Promise<PresetApplyResult> => {
    const id = normalizeCustomPresetId(requestedId)
    const request = ++presetApplyRequest.current
    setApplyingPresetId(id)
    setCustomPresetFeedback(null)
    try {
      const result = await applyCustomPreset(id)
      if (request !== presetApplyRequest.current) return result
      if (result.status === 'applied') {
        resolveRuntimeErrors({ key: `preset:${id}` })
        resolveSettingsError('应用自定义预设')
        setCustomPresetFeedback({
          kind: 'success',
          message: result.unavailable && result.unavailable.length > 0
            ? `自定义预设已应用（不可用提供者：${result.unavailable.join('、')}）`
            : '自定义预设已应用',
        })
      } else {
        setCustomPresetFeedback({
          kind: 'error',
          message: `自定义预设应用失败（${result.failedProvider}）：${result.message}`,
        })
      }
      return result
    } catch (error) {
      const detail = reportSettingsError('应用自定义预设', error)
      const result: PresetApplyResult = {
        status: 'failed', id, failedProvider: 'unknown', message: detail.message, rolledBack: false, revision: request,
      }
      if (request === presetApplyRequest.current) setCustomPresetFeedback({ kind: 'error', message: `自定义预设应用失败：${detail.message}` })
      return result
    } finally {
      if (request === presetApplyRequest.current) setApplyingPresetId(null)
    }
  }

  // 改单个字段 — 标记当前 section 对应的 zone 为 custom（非主题 section 回退 global）
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = sectionZone(activeSection) || 'global'
    setZoneField(zone, partial)
  }
  // 声明式字段渲染上下文（骨架 3）：纯字段组由 themeFieldRenderer 自动渲染
  const renderCtx = { t, onChange: onSettingChange, search: searchQuery }
  // 搜索时隐藏手写组（预设/布局骨架/窗口/配置备份等非主题字段），只留命中的自动字段组
  const isSearching = searchQuery.trim().length > 0

  // 局部预设（zone 级别）：出厂条目现场切来源预设、自定义条目直接用值快照。
  // 出厂条目的 id === 来源预设名 ⇒ appliedPreset[zone] 记的名字与刀5 完全一致。
  const applyLocalPreset = (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => {
    const theme = resolveZonePresetEntryTheme(entry)
    if (!theme) return
    applyZonePreset(zone, entry.id, theme)
  }

  // 「存当前为自定义」：存 = pickZoneFields(当前主题, zone)，随后立刻应用同一条目，
  // 使新条目成为该区基准（与全局预设「保存当前」后立即应用同一交互）。
  const saveZonePresetEntryFromSettings = (zone: ZonePresetEntry['zone'], name: string) => {
    if (!modeBucket) return
    const id = saveZonePresetEntry(modeBucket, zone, name)
    if (!id) return
    const entry = useStore.getState().zonePresetEntries.find(item => item.id === id)
    const theme = entry ? resolveZonePresetEntryTheme(entry) : null
    if (theme) applyZonePreset(zone, id, theme)
  }

  /**
   * Custom preset persistence is a user action, so failures must stay visible
   * in this dialog. Previously an exception from provider capture (or a stale
   * overwrite id) escaped the click handler and looked like a dead button.
   */
  const saveCustomPresetFromSettings = (name: string, id?: string): string | undefined => {
    const isOverwrite = Boolean(id)
    try {
      const savedId = saveCustomPreset(name, id)
      resolveSettingsError(isOverwrite ? '覆盖已有自定义预设' : '保存自定义预设')
      setCustomPresetFeedback({
        kind: 'success',
        message: isOverwrite ? '自定义预设已覆盖' : '自定义预设已保存',
      })
      return savedId
    } catch (error) {
      const action = isOverwrite ? '覆盖已有自定义预设' : '保存自定义预设'
      const detail = reportSettingsError(action, error)
      setCustomPresetFeedback({ kind: 'error', message: `${action}失败：${detail.message}` })
      return undefined
    }
  }

  const previewZone = sectionZone(activeSection)

  useEffect(() => {
    if (activePluginPageId && !pluginSettingsPages.some(entry => entry.contributionId === activePluginPageId)) {
      navigate({ pluginPageId: null, section: 'pluginManager' })
    }
    // navigate 是本渲染周期的 patchSheetState 绑定（随 sheet.id 定），非数据依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePluginPageId, pluginSettingsPages])

  const switchAgent = async (agentId: string) => {
    if (switchingAgentId || agentId === activeAgent) return
    setSwitchingAgentId(agentId)
    await switchAgentTransaction(agentId, agentId, {
      switchAgent: () => agentClient.switchAgent(agentId),
      resetRuntime: () => useRuntimeStore.getState().resetAll(),
      setActiveAgent: id => setActiveAgent(id),
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
      reportError: (action, error) => reportSettingsError(action, error, agentId),
      resolveError: action => resolveSettingsError(action, agentId),
      dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
    })
    setSwitchingAgentId(null)
  }

  const reconnectAgent = async () => {
    if (reconnectPending) return
    const targetAgent = activeAgent
    setReconnectPending(true)
    setReconnectCommandError(null)
    const result = await runReconnectCommand({
      reconnect: () => agentClient.reconnectAgent(),
      readSnapshot: async () => normalizeAgentStatus(await agentClient.agentStatus(), targetAgent),
      applySnapshot: snapshot => setAgentStatus(targetAgent, snapshot),
    })
    if (result.commandError !== undefined) {
      const reconciledStatus = useRuntimeStore.getState().agentStatuses[targetAgent]
      const recovered = reconciledStatus?.status === 'connected'
        || reconciledStatus?.status === 'connecting'
        || reconciledStatus?.status === 'reconnecting'
      if (recovered) {
        // The command may reject because reconnect is already in progress;
        // an authoritative connected/starting snapshot means there is no
        // active failure to show. Keep the provider text diagnostic-only.
        reportRuntimeDiagnostic('重连 Agent', result.commandError, targetAgent, {
          key: `settings:重连 Agent:${targetAgent}`,
          scope: { kind: 'agent', id: targetAgent },
          source: 'settings.reconnect',
          metadata: { reconciledStatus: reconciledStatus.status },
        })
        resolveSettingsError('重连 Agent', targetAgent)
      } else {
        // Compatibility token retained for the reconnect structure guard:
        // reportRuntimeError('重连 Agent', result.commandError)
        const detail = reportSettingsError('重连 Agent', result.commandError, targetAgent)
        setReconnectCommandError(detail.message)
      }
    } else {
      resolveSettingsError('重连 Agent', targetAgent)
    }
    if (result.reconciliationError !== undefined) {
      reportSettingsError('对账 Agent 状态', result.reconciliationError, targetAgent)
    } else {
      // A rejected reconnect command can still reconcile successfully against
      // the authoritative status snapshot; that success must retire any old
      // reconciliation notice as well.
      resolveSettingsError('对账 Agent 状态', targetAgent)
    }
    setReconnectPending(false)
  }

  const reloadAgents = async () => {
    await reloadAgentsTransaction({
      isReloading: () => reloading,
      setReloading,
      reloadAgents: () => agentClient.reloadAgents(),
      listAgents: () => agentClient.listAgents(),
      setAgents: list => useIdentityStore.getState().setAgents(list),
      loadToolDictionary: async () => {
        const dictionary = await agentClient.listToolDictionary()
        applyToolDictionaryThroughPort(getPluginServiceRegistry(), dictionary)
        const providerCount = Object.keys(dictionary as Record<string, unknown> ?? {}).length
        setDictFeedback(providerCount > 0 ? `工具归一化字典已加载（${providerCount} 个 provider）` : '工具归一化字典为空，已使用内置 fallback')
      },
      reportError: (action, error) => {
        setDictFeedback('工具归一化字典加载失败，详情见右下角错误中心')
        reportSettingsError(action, error)
      },
      resolveError: action => resolveSettingsError(action),
    })
  }

  // F2：禁储环境安全存储（内存兜底，会话内可用）
  const storage = safeStorage()

  // K-1：密度档 chrome 态（localStorage 持久化；拍板 D3-A 全局一档）
  const [density, setDensity] = useState<SettingsDensity>(() =>
    readDensity((k) => storage.get(k)))
  const changeDensity = (d: SettingsDensity) => {
    setDensity(d)
    writeDensity(d, (key, v) => storage.set(key, v))
  }

  // #116 子项 8：预览栏折叠（chrome 态，持久化；折叠后正文宽度回升）
  const [previewCollapsed, setPreviewCollapsed] = useState<boolean>(() =>
    readPreviewCollapsed((k) => storage.get(k)))
  const togglePreviewCollapsed = () => {
    setPreviewCollapsed(prev => {
      writePreviewCollapsed(!prev, (key, v) => storage.set(key, v))
      return !prev
    })
  }

  // K-2/K-4：二级折叠展开态与收藏置顶随导航迁入 SettingsSheetSidebar（#154 阶段 4）。

  // O-3：速搜定位态
  const [quickSearchOpen, setQuickSearchOpen] = useState(false)
  // B2 边界修复：面板打开或 Renderer catalog 热更新时重建索引。
  // 不能只依赖 quickSearchOpen，否则插件热装卸后的字段要重新打开命令面板才可搜。
  const quickSearchItems = useMemo(() => {
    // 显式引用依赖项：它们是缓存失效信号（B2），非数据来源——抑制 exhaustive-deps
    void quickSearchOpen
    void rendererRegistrySnapshot.revision
    void settingsContributionCatalog.revision
    return settingsContributionCatalog.searchItems
  }, [quickSearchOpen, rendererRegistrySnapshot.revision, settingsContributionCatalog])
  const navigateToField = (item: import('../settingsDomains').SettingsSearchItem) => {
    if (item.contextPanelId) {
      navigate({ domain: 'appearance', section: 'right', pluginPageId: null })
      useRightRailStore.getState().setActivePanel(item.contextPanelId)
      useRightRailStore.getState().setCollapsed(false)
      if (item.anchor) requestAnimationFrame(() => document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor!)}"]`)?.scrollIntoView({ block: 'center' }))
      return
    }
    if (item.pluginPageId) {
      navigate({ domain: 'plugins', section: 'pluginManager', pluginPageId: item.pluginPageId })
      if (item.anchor) requestAnimationFrame(() => document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor!)}"]`)?.scrollIntoView({ block: 'center' }))
      return
    }
    if (item.rendererRoute) {
      navigate({ rendererCategoryId: item.rendererRoute.categoryId })
      setRendererObjectKey(item.rendererRoute.objectKey)
      setSearchQuery(item.label)
    }
    jumpToSection(item.section)
    if (density !== 'all') changeDensity('all')  // D2-A：advanced 命中自动切全部档
    requestAnimationFrame(() => {
      // B3 边界修复：优先唯一锚定位（重名字段如多个「背景图」不再误跳第一处）
      let target: Element | null = null
      if (item.anchor) target = document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor)}"]`)
      if (!target) {
        // 链B entry 无字段级锚——回退到组标题文本匹配
        target = [...document.querySelectorAll('.set-group-title, .renderer-settings-group-heading h3')]
          .find(el => el.textContent?.includes(item.label)) ?? null
      }
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      const group = target?.closest('[data-group-anchor], .renderer-settings-group, .set-group')
      if (group instanceof HTMLElement) pulseSettingsAnchor(group)
    })
  }
  // F1 边界修复：section → 所属 domain 反查（SETTINGS_DOMAINS 单一真值派生）
  const domainOfSection = (section: string): SettingsDomainId | undefined =>
    SETTINGS_DOMAINS.find(d => (d.sections as readonly string[]).includes(section))?.id
  const jumpToSection = (section: SettingsSectionId) => {
    const domain = domainOfSection(section)
    // #154 阶段 4：跨域跳转由 codec 归一（normalizeSettingsSheetState → normalizeSettingsIntent），
    // 这里直接写目标 section 与所属 domain；二级折叠展开态归左栏导航组件自持。
    navigate({ section, domain: domain ?? activeDomain, pluginPageId: null })
  }

  // I13-W1：section → 内容（复用既有块/组件，视觉 token 与字段行为不变）
  const renderSection = (section: SettingsSectionId) => {
    switch (section) {
      case 'templates':
        return (
          <Group title="模板库">
            <TemplateLibrary onApply={applyGlobalPreset} onRestore={applyGlobalPreset} onCustomApply={applyCustomPresetTransaction} />
          </Group>
        )
      case 'pet':
        return (
          <Group title="宠物">
            <div className="set-preset-row">
              <button type="button" className="set-preset-chip" onClick={() => setShowPet(!showPet)}>
                {showPet ? '宠物显示中 — 点击隐藏' : '宠物已隐藏 — 点击显示'}
              </button>
            </div>
          </Group>
        )
      case 'window':
        return <WindowPanel />
      case 'history':
        return <HistoryRetention />
      case 'backup':
        return <ConfigBackupPanel />
      case 'global':
        return (
          <>
            {!isSearching && <Group title="界面模式"><InterfaceModePicker /></Group>}
            {!isSearching && modeBucket && <Group title="全局预设">
              {/* 刀5（#201，UI 二次修订）：直接显示当前界面模式归属桶的预设 chips（随模式切换跟随）。 */}
              <div className="set-preset-row">
                {presetsForInterfaceMode(currentInterfaceMode).map(p => (
                  <button type="button" key={p.name} className={`set-preset-chip ${globalStatus === p.name ? 'active' : ''}`}
                    aria-current={globalStatus === p.name ? 'true' : undefined}
                    onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
                ))}
                {/* #116 子项 7：兜底 chip 原先直接输出 globalStatus 原文——它是 'custom'
                    哨兵或自定义预设 id 时会把内部标识当预设名显示，且与下方
                    .set-custom-presets 里的具名 chip 重复点亮。现在：自定义预设 id 由
                    具名列表负责（此处不出兜底），'custom' 哨兵显示为「自定义」，其余
                    无法识别的值显示为「未知预设」并把原值留在 title/data 上供排查。 */}
                {fallbackPresetChipView && (
                  <button type="button" className="set-preset-chip active" aria-current="true"
                    title={fallbackPresetChipView.title} data-preset-status={globalStatus}>{fallbackPresetChipView.label}</button>
                )}
              </div>
              <div className="set-hint">
                {globalStatus === 'custom'
                  ? '当前为自定义 — 可保存为新预设或覆盖已有自定义预设'
                  : '选择预设后修改任意外观参数，自动切换为自定义'}
              </div>
              <div className="set-custom-preset-save">
                <input className="set-input" value={customPresetName} onChange={event => setCustomPresetName(event.target.value)} placeholder="自定义预设名称" />
                {/* A3：保存必须命名——空名禁用按钮（数据层 saveCustomPresetReducer 抛错兜底），不再静默 return */}
                <button type="button" className="ps-btn sm" disabled={!customPresetName.trim()} title={customPresetName.trim() ? undefined : '保存必须命名'}
                  onClick={() => {
                    const id = saveCustomPresetFromSettings(customPresetName)
                    if (id) {
                      void applyCustomPresetFromSettings(id).then(result => {
                        if (result.status === 'applied') setCustomPresetName('')
                      })
                    }
                  }}>保存当前</button>
              </div>
              {customPresetFeedback && (
                <div className={`set-hint custom-preset-feedback ${customPresetFeedback.kind === 'error' ? 'is-error' : 'is-success'}`}
                  role={customPresetFeedback.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
                  {customPresetFeedback.message}
                </div>
              )}
              {customPresets.length > 0 && <div className="set-custom-presets">
                {customPresets.map(preset => <div className="set-custom-preset" key={preset.id}>
                  <button type="button" className={`set-preset-chip ${globalStatus === preset.id ? 'active' : ''}`} disabled={applyingPresetId !== null} aria-busy={applyingPresetId === preset.id || undefined} onClick={() => { void applyCustomPresetFromSettings(preset.id) }}>{preset.name}</button>
                  <button type="button" className="ps-btn sm" onClick={() => { void saveCustomPresetFromSettings(preset.name, preset.id) }}>覆盖</button>
                  {pendingDeletePresetId === preset.id ? (
                    <div className="set-confirm set-confirm-inline" role="alertdialog" aria-label={`确认删除预设 ${preset.name}`}>
                      <span className="set-confirm-text">删除后不可恢复；引用它的区域会保留现值但失去预设基准。</span>
                      <button type="button" className="ps-btn sm danger"
                        onClick={() => { setPendingDeletePresetId(null); removeCustomPreset(preset.id) }}>确认删除</button>
                      <button type="button" className="ps-btn sm" onClick={() => setPendingDeletePresetId(null)}>取消</button>
                    </div>
                  ) : (
                    <button type="button" className="ps-btn sm danger" onClick={() => setPendingDeletePresetId(preset.id)}>删除</button>
                  )}
                </div>)}
              </div>}
            </Group>}
            {/* 个人信息/强调色/布局骨架/玻璃效果/字体 已声明式化（defs 组），自动获得搜索/custom/恢复默认 */}
            <ZoneGroupFields zone="global" ctx={renderCtx} density={density} />
          </>
        )
      case 'sidebar':
        return (
          <>
            {!isSearching && <h3>{SETTINGS_SECTION_LABELS.sidebar}</h3>}
            {!isSearching && <Group title="模块"><SidebarModulesPanel /></Group>}
            {!isSearching && <ZonePresetRow zone="sidebar" interfaceMode={currentInterfaceMode} activeName={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').isCustom} onApply={applyLocalPreset} onSaveCurrent={saveZonePresetEntryFromSettings} onRemoveEntry={removeZonePresetEntry}/>}
            <ZoneGroupFields zone="sidebar" ctx={renderCtx} density={density} />
          </>
        )
      case 'chat':
        return (
          <>
            {!isSearching && <Group title="渲染风格"><PresentationProfilePicker /></Group>}
            {!isSearching && <ZonePresetRow zone="chat" interfaceMode={currentInterfaceMode} activeName={deriveZoneStatus({ appliedPreset, custom }, 'chat').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'chat').isCustom} onApply={applyLocalPreset} onSaveCurrent={saveZonePresetEntryFromSettings} onRemoveEntry={removeZonePresetEntry}/>}
            <ZoneGroupFields zone="chat" ctx={renderCtx} density={density} />
          </>
        )
      case 'renderers':
        return <RendererSettingsPanel search={searchQuery} categoryId={rendererCategoryId} objectKey={rendererObjectKey} density={density} settingsCatalog={settingsContributionCatalog} onSelectionChange={setRendererPreviewEntry} />
      case 'cc':
        return (
          <>
            {!isSearching && <h3>{SETTINGS_SECTION_LABELS.cc}</h3>}
            {!isSearching && <ZonePresetRow zone="cc" interfaceMode={currentInterfaceMode} activeName={deriveZoneStatus({ appliedPreset, custom }, 'cc').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'cc').isCustom} onApply={applyLocalPreset} onSaveCurrent={saveZonePresetEntryFromSettings} onRemoveEntry={removeZonePresetEntry}/>}
            <ZoneGroupFields zone="cc" ctx={renderCtx} density={density} />
            {!isSearching && <Group title="布局编辑">
              <button type="button" className="ps-btn primary"
                onClick={() => {
                  const cur = useStore.getState().ccEditMode
                  setCcEditMode(!cur)
                  if (!cur) ctx.closeSheet(sheet.id)
                }}>
                {t.ccEditMode ? '退出布局编辑器' : '进入布局编辑器'}
              </button>
              <div className="set-hint">位置 / 大小 / 显隐 在编辑器中拖拽调整</div>
            </Group>}
          </>
        )
      case 'right':
        return (
          <>
            {!isSearching && <h3>{SETTINGS_SECTION_LABELS.right}</h3>}
            {!isSearching && <ZonePresetRow zone="right" interfaceMode={currentInterfaceMode} activeName={deriveZoneStatus({ appliedPreset, custom }, 'right').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'right').isCustom} onApply={applyLocalPreset} onSaveCurrent={saveZonePresetEntryFromSettings} onRemoveEntry={removeZonePresetEntry}/>}
            <ZoneGroupFields zone="right" ctx={renderCtx} density={density} />
          </>
        )
      case 'agent':
        return (
          <>
            <div className="agent-settings-heading">
              <div><h3>Agent</h3><p>连接、发现与导入集中在这里；YAML 和动态配置保留在高级区域。</p></div>
            </div>
            <section className="agent-settings-overview" aria-label="当前 Agent 概况">
              <div className="agent-settings-overview-main">
                <span className={`agent-status-indicator is-${currentStatus.status}`} aria-hidden="true" />
                <div>
                  <span className="agent-settings-kicker">当前 Agent</span>
                  <strong>{agents.find(agent => agent.id === activeAgent)?.name || activeAgent || 'peri'}</strong>
                  <span>{activeAgent || 'peri'}</span>
                  <span className="agent-settings-status-copy">状态：{statusLabel(currentStatus.status)}</span>
                </div>
              </div>
              <div className="agent-settings-actions">
                <button type="button" className="ps-btn sm primary" disabled={reconnectPending} onClick={reconnectAgent}>{reconnectPending ? '重连中…' : '重新连接'}</button>
                <button type="button" className="ps-btn sm" disabled={reloading} onClick={reloadAgents}>{reloading ? '重载中…' : '重载配置'}</button>
              </div>
              <dl className="agent-settings-facts">
                <div><dt>传输方式</dt><dd>{currentStatus.transport || '未报告'}</dd></div>
                <div><dt>工作目录</dt><dd title={currentStatus.cwd}>{currentStatus.cwd || '跟随会话'}</dd></div>
              </dl>
              {/* This is an authoritative Agent status fact, not a dismissible
                  runtime toast; keep the alert semantics for assistive tech. */}
              {currentStatus.recentError && <div className="agent-settings-notice error" role="alert">最近错误：{currentStatus.recentError}</div>}
              {reconnectCommandError && <div className="agent-settings-notice error" role="status">重连失败，详情见右下角错误中心</div>}
              {dictFeedback && <div className="agent-settings-notice" role="status">{dictFeedback}</div>}
            </section>
            <Group title="切换 Agent">
              <div className="agent-switch-list">
                {agents.map((agent) => (
                  <button key={agent.id} type="button" className={`agent-switch-card ${agent.id === activeAgent ? 'active' : ''}`}
                    disabled={switchingAgentId !== null || agent.id === activeAgent}
                    aria-busy={switchingAgentId === agent.id}
                    onClick={() => switchAgent(agent.id)}>
                    <span className="agent-switch-copy"><strong>{agent.name}</strong><small>{agent.provider || agent.id}</small></span>
                    <span className="agent-switch-state">{switchingAgentId === agent.id ? '连接中…' : agent.id === activeAgent ? '当前' : '切换'}</span>
                  </button>
                ))}
              </div>
              <div className="set-hint">切换会立即重置当前会话的运行时状态。</div>
            </Group>
            <Group title="发现与管理 Agent">
              <AgentRuntimePanel initialAgentId={state.agentId} />
            </Group>
            <Group title="高级：YAML 配置" defaultOpen={false}>
              <AgentConfigEditor agentId={activeAgent} />
              <div className="set-hint">保存会原子写回生效配置并刷新 Agent 列表；当前 active agent 不可被删除。</div>
            </Group>
            <Group title="高级：会话动态配置" defaultOpen={false}>
              <ConfigOptionsPanel context={activeSessionContext} />
            </Group>
          </>
        )
      case 'session':
        return (
          <div className="settings-empty-state">
            <span className="settings-empty-kicker">当前会话</span>
            <h3>会话设置从会话入口打开</h3>
            <p>在左栏目标会话右侧点击设置按钮，可编辑工作目录与 Session Prompt。会话级 Skills / Hooks 暂未接入运行时。</p>
          </div>
        )
      case 'gateway':
        // I13-W5：Gateway 风险 consumer——真实实例/凭据状态 + 备份边界提示（不伪装备份加密）
        return <GatewayRiskPanel />
      case 'prediction':
        return <InputPredictionSettingsPanel />
      case 'pluginManager': {
        // P53：插件管理默认进入管理器插件提供的页面（贡献存在时）；
        // 包未激活/未授权时贡献不存在，回落宿主基础页（承载能力授权卡）。
        const managerPage = pluginSettingsPages.find(entry => entry.contributionId === 'pylon-plugin-manager')
        return managerPage ? <PluginSettingsPageHost pageId={managerPage.contributionId} /> : <PluginManager />
      }
      case 'hookDiagnostics':
        return <HookDiagnosticsPanel />
    }
  }

  return (
    <div className="settings flex flex-1 min-w-0" data-settings-domain={activeDomain} data-settings-section={activeSection}>
      {/* #154 阶段 4：对话框外壳（role=dialog/焦点陷阱/settings-header/关闭钮）随覆盖层退役；
          一二级导航迁入注册表 sidebar（SettingsSheetSidebar），主区只保留 正文 + 速搜 + 预览。 */}
      <div className="settings-tabs-root">
        <div className="settings-body" data-settings-domain={activeDomain} data-settings-section={activeSection}>
          {!activePluginPageId && (
            <SettingsSectionHeader section={activeSection} density={density} onDensity={changeDensity} />
          )}
          {!activePluginPageId && (previewZone || activeSection === 'renderers') && (
            <div className="set-toolbar">
              <div className="set-search-wrap">
                <input className="set-search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索设置项…（如 语法、停滞、透明）" />
                {searchQuery && <button type="button" className="set-search-clear" onClick={() => setSearchQuery('')} aria-label="清除搜索">✕</button>}
              </div>
              {previewZone && <button type="button" className="ps-btn sm set-zone-reset"
                onClick={() => resetZone(sectionZone(activeSection) || 'global')}
                title="将该区全部字段恢复默认">重置本区</button>}
            </div>
          )}
          {activePluginPageId ? <PluginSettingsPageHost pageId={activePluginPageId} /> : renderSection(activeSection)}
        </div>

        <SettingsQuickSearch
          open={quickSearchOpen}
          items={quickSearchItems}
          onNavigate={navigateToField}
          onOpenChange={setQuickSearchOpen}
        />
        {!activePluginPageId && (previewZone || activeSection === 'renderers') && (
          <div className={`settings-preview-pane${previewCollapsed ? ' collapsed' : ''}`}>
            <div className="settings-preview-pane-head">
              {!previewCollapsed && (
                <div className="settings-preview-label">{activeSection === 'renderers' ? 'Renderer fixture' : '实时预览'}</div>
              )}
              <button type="button" className="settings-preview-toggle"
                onClick={togglePreviewCollapsed}
                aria-expanded={!previewCollapsed}
                aria-controls="settings-preview-body"
                title={previewCollapsed ? '展开预览栏' : '折叠预览栏'}
                aria-label={previewCollapsed ? '展开预览栏' : '折叠预览栏'}>
                {previewCollapsed ? '‹' : '›'}
              </button>
            </div>
            {!previewCollapsed && (
              <div id="settings-preview-body" className="settings-preview-body">
                {activeSection === 'renderers'
                  ? <RendererSettingsPreview entry={rendererPreviewEntry} catalog={rendererRegistrySnapshot} settingsCatalog={settingsContributionCatalog} activeSuiteId={activeRendererSuiteId} />
                  : <SettingsPreview zone={previewZone!} />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
