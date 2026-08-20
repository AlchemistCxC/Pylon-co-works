import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { clearWindowSize } from '../windowSizePersistence'
import { buildExportPayloadAsync, configFileName, preflightImportPayload } from '../configExportImport'
import { selectUserDataRepository } from '../userDataRepository'
import { importConfigurationTransaction } from '../application/transactions/importConfigurationTransaction'
import { createAgentClient } from '../infrastructure/acp/agentClient'
import { ZoneGroupFields } from '../themeFieldRenderer'
import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { applyToolDictionaryThroughPort } from '../app/ports/productContributionPorts.ts'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import { GLOBAL_PRESETS, pickZoneFields } from '../presets'
import { useWorkspaceStore } from '../workspaceStore'
import { pickCustomPresetTheme } from '../customPresets'
import { deriveGlobalStatus, deriveZoneStatus } from '../domains/theme/presetReducer'
import SettingsPreview from './SettingsPreview'
import { reportRuntimeError } from '../runtimeError'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { normalizeAgentStatus, selectAgentStatus, statusLabel } from './settings/agentTypes'
import { runReconnectCommand } from './settings/reconnectCommand'
import AgentRuntimePanel from './settings/AgentRuntimePanel'
import AgentConfigEditor from './settings/AgentConfigEditor'
import ConfigOptionsPanel from './settings/ConfigOptionsPanel'
import TemplateLibrary from './settings/TemplateLibrary'
import HistoryRetention from './settings/HistoryRetention'
import GatewayRiskPanel from './settings/GatewayRiskPanel'
import PluginManager from './settings/PluginManager'
import PresentationProfilePicker from './settings/PresentationProfilePicker'
import PluginSettingsPageHost from './settings/PluginSettingsPageHost'
import InterfaceModePicker from './settings/InterfaceModePicker.tsx'
import { getPluginServiceRegistry, getPluginSettingsPageRegistry } from '../plugin-runtime/runtimeServices.ts'
import { loadRetentionPolicyPayload, syncImportedRetentionPolicy } from '../retentionPolicyRepository'
import { resolveToolIndicatorAsset, toolIndicatorOptions } from './chat/toolIndicatorAssets'
import Select from './ui/Select.tsx'
// I13-W1：Settings 一级信息架构唯一真值（domain → section + 字段归属派生）
import { SETTINGS_DOMAIN_BY_ID, SETTINGS_DOMAINS, SETTINGS_SECTION_LABELS, sectionZone, type SettingsDomainId, type SettingsSectionId } from '../settingsDomains'

// FE-AUD-008：typed client 收口 agent 域 command literal
const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })

// ── helpers ──

function Row({ label, children }: { label:string; children:React.ReactNode }) {
  return <div className="set-row"><span className="set-row-label">{label}</span>{children}</div>
}

function Sel({ value, onChange, options, ariaLabel }: { value:string; onChange:(v:string)=>void; options:(string | { value: string; label: string })[]; ariaLabel: string }) {
  return <Select ariaLabel={ariaLabel} value={value} onChange={onChange} className="set-select" options={options.map(option => typeof option === 'string' ? { value: option, label: option } : option)} />
}


// 窗口尺寸：显示当前值 + 重置（记忆由 App 的 onResized 防抖持久化负责）
function WindowSizeRow() {
  const [size, setSize] = useState('—')
  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    getCurrentWindow().outerSize().then(({ width, height }) => {
      if (!cancelled) setSize(`${width}×${height}`)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const reset = () => {
    getCurrentWindow().setSize(new PhysicalSize(1200, 800)).catch(() => {})
    clearWindowSize(localStorage)
  }
  return (
    <Group title="窗口">
      <Row label="当前尺寸"><span className="set-val" style={{ width: 'auto' }}>{size} px</span></Row>
      <div className="set-hint">拖动窗口边框后自动记忆尺寸，下次启动恢复</div>
      <div className="set-preset-row">
        <button type="button" className="ps-btn sm" onClick={reset}>重置为默认 1200×800</button>
      </div>
    </Group>
  )
}

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

// 配置导出/导入：Tauri 对话框 + 浏览器下载/上传 fallback
function ConfigBackupRow() {
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isTauri = IS_TAURI
  const doExport = async () => {
    try {
      // I14-W8：Tauri 模式导出聚合后端 versioned user store（profiles/sessions envelope
      // 权威源）；browser 模式无后端 → 与原 buildExportPayload 等价
      // I13-W6：保留策略后端权威 payload 聚合（Tauri；browser 走 localStorage key）
      const repo = isTauri ? selectUserDataRepository() : null
      const json = await buildExportPayloadAsync(localStorage, repo ? {
        loadProfiles: async () => (await repo.load('profiles'))?.payload ?? null,
        loadSessions: async () => (await repo.load('sessions'))?.payload ?? null,
        loadRetention: async () => {
          const payload = await loadRetentionPolicyPayload()
          return payload ? { payload } : null
        },
      } : undefined)
      const fileName = configFileName()
      if (isTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog')
        const path = await save({ defaultPath: fileName, filters: [{ name: 'Pylon 配置', extensions: ['json'] }] })
        if (path) {
          const { writeTextFile } = await import('@tauri-apps/plugin-fs')
          await writeTextFile(path, json)
          setMsg('已导出配置')
        }
      } else {
        const blob = new Blob([json], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = fileName; a.click()
        URL.revokeObjectURL(url)
        setMsg('已导出配置')
      }
    } catch (cause) { setMsg(`导出失败：${String(cause)}`) }
  }
  const doImport = async (file?: File) => {
    try {
      let json: string | null = null
      if (file) {
        json = await file.text()
      } else if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ multiple: false, filters: [{ name: 'Pylon 配置', extensions: ['json'] }] })
        if (!selected) return
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        json = await readTextFile(selected as string)
      }
      if (json === null) return
      const result = await importConfigurationTransaction(json, {
        storage: localStorage,
        preflight: preflightImportPayload,
        rehydrate: () => {
          // I14-W6 CR-01：导入后强制本地读回（读取刚写入的 localStorage）+ 写穿后端，
          // 避免 Tauri 模式后端权威读回覆盖导入值（导入静默失效）
          useIdentityStore.getState().hydrateFromLocal()
          useWorkspaceStore.getState().hydrateWorkspaceSheets()
        },
        reportError: (action, error) => reportRuntimeError(action, error),
      })
      // I13-W6 CR-001：仅当导入 payload 确含保留策略 key 时写穿后端权威（防本地残留盲写覆盖）
      if (result.ok) {
        syncImportedRetentionPolicy(localStorage, result.value).catch(error => {
          reportRuntimeError('导入保留策略', error)
        })
      }
      setMsg(result.ok
        ? `已导入 ${result.value.length} 项配置`
        : `导入失败：${result.message}`)
    } catch (cause) { setMsg(`导入失败：${String(cause)}`) }
  }
  return (
    <Group title="配置备份">
      <div className="set-preset-row">
        <button type="button" className="ps-btn sm" onClick={doExport}>导出配置</button>
        <button type="button" className="ps-btn sm" onClick={() => fileRef.current?.click()}>导入配置</button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
          onChange={e => { const file = e.target.files?.[0]; if (file) void doImport(file); e.target.value = '' }} />
      </div>
      {msg && <div className="set-hint">{msg}</div>}
    </Group>
  )
}

function ZonePresetRow({ zone, activeName, isDirty, onApply }: {
  zone: string; activeName: string; isDirty: boolean; onApply: (zone: string, name: string) => void
}) {
  return (
    <Group title="局部预设">
      <div className="set-preset-row">
        {GLOBAL_PRESETS.map(p => (
          <button key={p.name} className={`set-preset-chip ${activeName === p.name && !isDirty ? 'active' : ''}`}
            onClick={() => onApply(zone, p.name)}>{p.label}</button>
        ))}
        {isDirty && <span className="set-preset-chip active">自定义</span>}
      </div>
    </Group>
  )
}

// ── main ──

export default function Settings({ onClose, activeSessionId, initialDomain, initialSection, initialAgentId }: {
  onClose?: () => void
  activeSessionId?: string | null
  initialDomain?: string
  initialSection?: string
  initialAgentId?: string
}) {
  // 只订阅主题字段 + ccEditMode：后台生成时的 live 状态（token/生成源）不再穿透整棵设置树。
  // pickCustomPresetTheme 白名单覆盖 Settings 全部 t.xxx 访问（已核对），ccEditMode 单独补。
  const t = useStore(useShallow(s => ({
    ...pickCustomPresetTheme(s),
    ccEditMode: s.ccEditMode,
  } as ThemeSettings & { ccEditMode: boolean })))
  const reset = useStore(s => s.resetTheme)
  const resetZone = useStore(s => s.resetZone)
  const setGlobalPreset = useStore(s => s.setGlobalPreset)
  const setZoneField = useStore(s => s.setZoneField)
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const applyZonePreset = useStore(s => s.applyZonePreset)
  const appliedPreset = useStore(s => s.appliedPreset)
  const custom = useStore(s => s.custom)
  // A2：全局预设状态派生（任一 zone 触碰/基准不一致 → custom），原 appliedPreset.global 直读退役
  const globalStatus = useStore(s => deriveGlobalStatus(s))
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const setAgentStatus = useRuntimeStore(s => s.setAgentStatus)
  const setActiveAgent = useIdentityStore(s => s.setActiveAgent)
  const customPresets = useStore(s => s.customPresets)
  const sessions = useIdentityStore(s => s.sessions)
  // I01-W2：动态配置按 AgentContext（agentId+source）读写
  const activeSessionContext = (() => {
    const session = sessions.find(session => session.id === activeSessionId)
    return session ? { agentId: session.agentId, source: session.source } : undefined
  })()
  const saveCustomPreset = useStore(s => s.saveCustomPreset)
  const applyCustomPreset = useStore(s => s.applyCustomPreset)
  const removeCustomPreset = useStore(s => s.removeCustomPreset)
  // I13-W1：导航状态收敛为 activeDomain/activeSection（settingsDomains 驱动）
  const [activeDomain, setActiveDomain] = useState<SettingsDomainId>(
    (initialDomain as SettingsDomainId) || 'appearance',
  )
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    initialSection && initialSection in SETTINGS_SECTION_LABELS ? initialSection as SettingsSectionId : 'global',
  )
  const settingsPageRegistry = getPluginSettingsPageRegistry()
  const pluginSettingsPages = useSyncExternalStore(
    listener => settingsPageRegistry.subscribe(listener),
    () => settingsPageRegistry.getSnapshot(),
    () => settingsPageRegistry.getSnapshot(),
  ).entries
  const [activePluginPageId, setActivePluginPageId] = useState<string | null>(
    initialSection && !(initialSection in SETTINGS_SECTION_LABELS) ? initialSection : null,
  )
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)
  const [searchQuery, setSearchQuery] = useState('')
  const [customPresetName, setCustomPresetName] = useState('')
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null)
  const [reconnectPending, setReconnectPending] = useState(false)
  const [reconnectCommandError, setReconnectCommandError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [dictFeedback, setDictFeedback] = useState<string | null>(null)
  const currentStatus = selectAgentStatus(activeAgent, activeAgent, agentStatuses)

  // 施工文档 §5.3：Settings 宿主消费 open-settings 事件（ErrorCenter/Overview 恢复入口）。
  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ domain?: string; section?: string; agentId?: string }>).detail
      if (!detail) return
      if (detail.domain) setActiveDomain(detail.domain as SettingsDomainId)
      if (detail.section && detail.section in SETTINGS_SECTION_LABELS) {
        setActivePluginPageId(null)
        setActiveSection(detail.section as SettingsSectionId)
      } else if (detail.section) {
        setActiveDomain('plugins')
        setActivePluginPageId(detail.section)
      }
    }
    window.addEventListener('pylon:open-settings', onOpenSettings)
    return () => window.removeEventListener('pylon:open-settings', onOpenSettings)
  }, [])
  void initialAgentId

  // 应用全局预设
  const applyGlobalPreset = (name: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === name)
    if (!preset) return
    setGlobalPreset(name, preset.theme)
  }

  // 改单个字段 — 标记当前 section 对应的 zone 为 custom（非主题 section 回退 global）
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = sectionZone(activeSection) || 'global'
    setZoneField(zone, partial)
  }
  // 助手头像：Tauri 文件选择 → 存路径到 assistantDotImage（zone=chat）
  const pickAssistantAvatar = async () => {
    if (!IS_TAURI) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
    if (selected) setZoneField('chat', { assistantDotImage: selected as string })
  }
  // 声明式字段渲染上下文（骨架 3）：纯字段组由 themeFieldRenderer 自动渲染
  const renderCtx = { t, onChange: onSettingChange, search: searchQuery }
  // 搜索时隐藏手写组（预设/布局骨架/窗口/配置备份等非主题字段），只留命中的自动字段组
  const isSearching = searchQuery.trim().length > 0

  // 局部预设（zone 级别）
  const applyLocalPreset = (zone: string, presetName: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === presetName)
    if (!preset) return
    const sub = pickZoneFields(preset.theme, zone)
    applyZonePreset(zone, presetName, sub)
  }

  const previewZone = sectionZone(activeSection)

  useEffect(() => {
    if (activePluginPageId && !pluginSettingsPages.some(entry => entry.contributionId === activePluginPageId)) {
      setActivePluginPageId(null)
      setActiveSection('pluginManager')
    }
  }, [activePluginPageId, pluginSettingsPages])

  // I13-W1：切换 domain 时跳到该 domain 首个 section
  const switchDomain = (next: SettingsDomainId) => {
    if (next === activeDomain) return
    setActiveDomain(next)
    setActivePluginPageId(null)
    setActiveSection(SETTINGS_DOMAIN_BY_ID[next].sections[0])
  }

  const switchAgent = async (agentId: string) => {
    if (switchingAgentId || agentId === activeAgent) return
    setSwitchingAgentId(agentId)
    await switchAgentTransaction(agentId, agentId, {
      switchAgent: () => agentClient.switchAgent(agentId),
      resetRuntime: () => useRuntimeStore.getState().resetAll(),
      setActiveAgent: id => setActiveAgent(id),
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
      reportError: (action, error) => reportRuntimeError(action, error),
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
      const detail = reportRuntimeError('重连 Agent', result.commandError)
      setReconnectCommandError(detail.message)
    }
    if (result.reconciliationError !== undefined) {
      reportRuntimeError('对账 Agent 状态', result.reconciliationError)
    }
    setReconnectPending(false)
  }

  const reloadAgents = async () => {
    if (reloading) return
    setReloading(true)
    try {
      await agentClient.reloadAgents()
      const list = await agentClient.listAgents()
      useIdentityStore.getState().setAgents(list)
      const dictionary = await agentClient.listToolDictionary()
      applyToolDictionaryThroughPort(getPluginServiceRegistry(), dictionary)
      const providerCount = Object.keys(dictionary as Record<string, unknown> ?? {}).length
      setDictFeedback(providerCount > 0 ? `工具归一化字典已加载（${providerCount} 个 provider）` : '工具归一化字典为空，已使用内置 fallback')
    } catch (error) {
      setDictFeedback('工具归一化字典加载失败')
      reportRuntimeError('重载 Agent 配置', error)
    } finally { setReloading(false) }
  }

  const activeDomainConfig = SETTINGS_DOMAIN_BY_ID[activeDomain]

  // I13-W1：section → 内容（复用既有块/组件，视觉 token 与字段行为不变）
  const renderSection = (section: SettingsSectionId) => {
    switch (section) {
      case 'templates':
        return (
          <Group title="模板库">
            <TemplateLibrary onApply={applyGlobalPreset} onRestore={applyGlobalPreset} />
          </Group>
        )
      case 'pet':
        return (
          <Group title="宠物">
            <div className="set-preset-row">
              <button className="set-preset-chip" onClick={() => setShowPet(!showPet)}>
                {showPet ? '宠物显示中 — 点击隐藏' : '宠物已隐藏 — 点击显示'}
              </button>
            </div>
          </Group>
        )
      case 'window':
        return <WindowSizeRow />
      case 'history':
        return <HistoryRetention />
      case 'backup':
        return <ConfigBackupRow />
      case 'global':
        return (
          <>
            {!isSearching && <Group title="界面模式"><InterfaceModePicker /></Group>}
            {!isSearching && <Group title="全局预设">
              <div className="set-preset-row">
                {GLOBAL_PRESETS.map(p => (
                  <button key={p.name} className={`set-preset-chip ${globalStatus === p.name ? 'active' : ''}`}
                    onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
                ))}
                {globalStatus && !GLOBAL_PRESETS.some(p => p.name === globalStatus) && (
                  <button className="set-preset-chip active">{globalStatus}</button>
                )}
              </div>
              <div className="set-hint">
                {globalStatus === 'custom'
                  ? '当前为自定义 — 可保存为新预设或覆盖已有预设'
                  : '选择预设后修改任意外观参数，自动切换为自定义'}
              </div>
              <div className="set-custom-preset-save">
                <input className="set-input" value={customPresetName} onChange={event => setCustomPresetName(event.target.value)} placeholder="自定义预设名称" />
                {/* A3：保存必须命名——空名禁用按钮（数据层 saveCustomPresetReducer 抛错兜底），不再静默 return */}
                <button className="ps-btn sm" disabled={!customPresetName.trim()} title={customPresetName.trim() ? undefined : '保存必须命名'}
                  onClick={() => {
                    const id = saveCustomPreset(customPresetName)
                    applyCustomPreset(id)
                    setCustomPresetName('')
                  }}>保存当前</button>
              </div>
              {customPresets.length > 0 && <div className="set-custom-presets">
                {customPresets.map(preset => <div className="set-custom-preset" key={preset.id}>
                  <button className={`set-preset-chip ${globalStatus === preset.id ? 'active' : ''}`} onClick={() => applyCustomPreset(preset.id)}>{preset.name}</button>
                  <button className="ps-btn sm" onClick={() => saveCustomPreset(preset.name, preset.id)}>覆盖</button>
                  <button className="ps-btn sm danger" onClick={() => removeCustomPreset(preset.id)}>删除</button>
                </div>)}
              </div>}
            </Group>}
            {/* 个人信息/强调色/布局骨架/玻璃效果/字体 已声明式化（defs 组），自动获得搜索/custom/恢复默认 */}
            <ZoneGroupFields zone="global" ctx={renderCtx} />
          </>
        )
      case 'sidebar':
        return (
          <>
            {!isSearching && <h3>左侧栏</h3>}
            {!isSearching && <ZonePresetRow zone="sidebar" activeName={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="sidebar" ctx={renderCtx} />
          </>
        )
      case 'chat':
        return (
          <>
            {!isSearching && <Group title="渲染风格"><PresentationProfilePicker /></Group>}
            {!isSearching && <ZonePresetRow zone="chat" activeName={deriveZoneStatus({ appliedPreset, custom }, 'chat').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'chat').isCustom} onApply={applyLocalPreset}/>}
            {!isSearching && <Group title="指示器形状">
              <Row label="形状"><Sel ariaLabel="指示器形状" value={resolveToolIndicatorAsset(t.toolIndicator).id} onChange={v=>onSettingChange({toolIndicator:v})} options={toolIndicatorOptions()} /></Row>
            </Group>}
            <ZoneGroupFields zone="chat" ctx={renderCtx} />
          </>
        )
      case 'cc':
        return (
          <>
            {!isSearching && <h3>中控区</h3>}
            {!isSearching && <ZonePresetRow zone="cc" activeName={deriveZoneStatus({ appliedPreset, custom }, 'cc').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'cc').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="cc" ctx={renderCtx} />
            {!isSearching && (
              <Group title="助手头像">
                <div className="set-preset-row">
                  <button type="button" className="ps-btn sm" onClick={() => void pickAssistantAvatar()}>选择图片文件…</button>
                  {useStore.getState().assistantDotImage && (
                    <button type="button" className="ps-btn sm" onClick={() => useStore.getState().setZoneField('chat', { assistantDotImage: '' })}>清除</button>
                  )}
                </div>
              </Group>
            )}
            {!isSearching && <Group title="布局编辑">
              <button className="ps-btn primary"
                onClick={() => {
                  const cur = useStore.getState().ccEditMode
                  setCcEditMode(!cur)
                  if (typeof onClose === 'function') onClose?.()
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
            {!isSearching && <h3>右侧栏</h3>}
            {!isSearching && <ZonePresetRow zone="right" activeName={deriveZoneStatus({ appliedPreset, custom }, 'right').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'right').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="right" ctx={renderCtx} />
          </>
        )
      case 'agent':
        return (
          <>
            <div className="agent-settings-heading">
              <div><h3>Agent</h3><p>先处理连接和切换；运行时、YAML 与动态配置收在高级区域。</p></div>
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
                <button className="ps-btn sm primary" disabled={reconnectPending} onClick={reconnectAgent}>{reconnectPending ? '重连中…' : '重新连接'}</button>
                <button className="ps-btn sm" disabled={reloading} onClick={reloadAgents}>{reloading ? '重载中…' : '重载配置'}</button>
              </div>
              <dl className="agent-settings-facts">
                <div><dt>传输方式</dt><dd>{currentStatus.transport || '未报告'}</dd></div>
                <div><dt>工作目录</dt><dd title={currentStatus.cwd}>{currentStatus.cwd || '跟随会话'}</dd></div>
              </dl>
              {currentStatus.recentError && <div className="agent-settings-notice error" role="alert">最近错误：{currentStatus.recentError}</div>}
              {reconnectCommandError && <div className="agent-settings-notice error" role="alert">重连失败：{reconnectCommandError}</div>}
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
            <Group title="管理 Agent 与本机运行时" defaultOpen={false}>
              <AgentRuntimePanel />
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
      case 'pluginManager':
        // M12：插件管理页（列表只读 core；signed/dev 停用；本地包安装；日志）
        return <PluginManager />
    }
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <div>
          <h2>设置</h2>
          <p>调整 Pylon 的外观、工作区和 Agent 运行方式。</p>
        </div>
        <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置">✕</button>
      </header>
      <div className="settings-tabs-root">
        <div className="settings-nav">
          {/* I13-W2：左侧 domain 导航（一级 = 稳定设置域，settingsDomains 驱动） */}
          <div className="settings-nav-group">
            <div className="settings-nav-label">设置域</div>
            {SETTINGS_DOMAINS.map(domain => (
              <button key={domain.id} type="button" className={`set-nav-btn ${activeDomain === domain.id ? 'active' : ''}`}
                onClick={() => switchDomain(domain.id)}>
                {domain.label}
              </button>
            ))}
          </div>
          <div className="settings-nav-group settings-nav-sections">
            <div className="settings-nav-label">{activeDomainConfig.label} 分区</div>
            {activeDomainConfig.sections.map(section => {
              const zone = sectionZone(section)
              return (
                <button type="button" key={section}
                  className={`set-nav-btn ${!activePluginPageId && activeSection === section ? 'active' : ''}${zone && custom[zone] ? ' custom' : ''}`}
                  onClick={() => { setActivePluginPageId(null); setActiveSection(section) }}
                  title={zone && custom[zone] ? '该区有未保存的自定义改动' : undefined}>
                  {SETTINGS_SECTION_LABELS[section]}
                </button>
              )
            })}
            {activeDomain === 'plugins' && pluginSettingsPages.map(entry => (
              <button type="button" key={entry.contributionId}
                className={`set-nav-btn plugin-page ${activePluginPageId === entry.contributionId ? 'active' : ''}`}
                onClick={() => setActivePluginPageId(entry.contributionId)}
                title={entry.value.description}>
                <span>{entry.value.label}</span>
                <small>{entry.ownerPluginId}</small>
              </button>
            ))}
          </div>
          <div className="settings-nav-footer">
            <button className="set-nav-btn reset" onClick={reset}>重置主题</button>
          </div>
        </div>

        <div className="settings-body">
          {!activePluginPageId && previewZone && (
            <div className="set-toolbar">
              <div className="set-search-wrap">
                <input className="set-search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索设置项…（如 语法、停滞、透明）" />
                {searchQuery && <button type="button" className="set-search-clear" onClick={() => setSearchQuery('')} aria-label="清除搜索">✕</button>}
              </div>
              <button type="button" className="ps-btn sm set-zone-reset"
                onClick={() => resetZone(sectionZone(activeSection) || 'global')}
                title="将该区全部字段恢复默认">重置本区</button>
            </div>
          )}
          {activePluginPageId ? <PluginSettingsPageHost pageId={activePluginPageId} /> : renderSection(activeSection)}
        </div>

        {!activePluginPageId && previewZone && (
          <div className="settings-preview-pane">
            <div className="settings-preview-label">实时预览</div>
            <SettingsPreview zone={previewZone} />
          </div>
        )}
      </div>
    </div>
  )
}
