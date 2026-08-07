import { useState, useEffect, useRef } from 'react'
import { IS_TAURI } from '../infrastructure/tauri/env'
import * as Tabs from '@radix-ui/react-tabs'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { clearWindowSize } from '../windowSizePersistence'
import { buildExportPayload, configFileName, preflightImportPayload } from '../configExportImport'
import { importConfigurationTransaction } from '../application/transactions/importConfigurationTransaction'
import { createAgentClient } from '../infrastructure/acp/agentClient'
import { ZoneGroupFields } from '../themeFieldRenderer'
import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import { GLOBAL_PRESETS, pickZoneFields } from '../presets'
import { THEME_FIELD_KEYS, THEME_FIELD_DEFS, type ThemeFieldDef } from '../themeFieldDefs'
import { useWorkspaceStore } from '../workspaceStore'
import { pickCustomPresetTheme } from '../customPresets'
import { deriveGlobalStatus, deriveZoneStatus } from '../domains/theme/presetReducer'
import SettingsPreview from './SettingsPreview'
import { reportRuntimeError } from '../runtimeError'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import './SettingsCommon.css'
import './Settings.css'
import { normalizeAgentStatus, statusLabel } from './settings/agentTypes'
import { beginReconnect, failReconnect } from './settings/agentState'
import ConfigOptionsPanel from './settings/ConfigOptionsPanel'
import TemplateLibrary from './settings/TemplateLibrary'
import { resolveToolIndicatorAsset, toolIndicatorOptions } from './chat/toolIndicatorAssets'

// FE-AUD-008：typed client 收口 agent 域 command literal
const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })

// ── helpers ──

function Row({ label, children }: { label:string; children:React.ReactNode }) {
  return <div className="set-row"><span className="set-row-label">{label}</span>{children}</div>
}

function Sel({ value, onChange, options }: { value:string; onChange:(v:string)=>void; options:(string | { value: string; label: string })[] }) {
  return <select value={value} onChange={e => onChange(e.target.value)} className="set-select">
    {options.map(option => {
      const item = typeof option === 'string' ? { value: option, label: option } : option
      return <option key={item.value} value={item.value}>{item.label}</option>
    })}
  </select>
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
      const json = buildExportPayload(localStorage)
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
          useIdentityStore.getState().hydrateProfiles()
          useIdentityStore.getState().hydrateSessions()
          useWorkspaceStore.getState().hydrateWorkspaceSheets()
        },
        reportError: (action, error) => reportRuntimeError(action, error),
      })
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

// ── nav ──

const TABS = ['global', 'sidebar', 'terminal', 'cc', 'right', 'agent', 'session'] as const
const TAB_LABELS: Record<string, string> = {
  global: '全局', sidebar: '左栏', terminal: '终端', cc: '中控区', right: '右栏',
  agent: 'Agent', session: '会话',
}
// W2-13（F3-A）：设置三层（快速/进阶/专家）——进阶 = 现状原样；快速 = 一键换装 + basic 字段
const TIERS = ['quick', 'advanced', 'expert'] as const
const TIER_LABELS: Record<string, string> = { quick: '快速', advanced: '进阶', expert: '专家' }

// tab → 预览 zone（agent/session 无预览）
const TAB_PREVIEW: Record<string, string> = {
  global: 'global', sidebar: 'sidebar', terminal: 'chat', cc: 'cc', right: 'right',
}
// tab → 修改字段所属 zone（agent/session 无主题字段，回退 global）
const TAB_ZONE_MAP: Record<string, string> = {
  global: 'global', sidebar: 'sidebar', terminal: 'chat',
  cc: 'cc', right: 'right',
}

// ── main ──

export default function Settings({ onClose, activeSessionId }: { onClose?: () => void; activeSessionId?: string | null }) {
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
  const activeSessionSource = sessions.find(session => session.id === activeSessionId)?.source
  const saveCustomPreset = useStore(s => s.saveCustomPreset)
  const applyCustomPreset = useStore(s => s.applyCustomPreset)
  const removeCustomPreset = useStore(s => s.removeCustomPreset)
  const [tier, setTier] = useState<'quick' | 'advanced' | 'expert'>('quick')
  const [activeTab, setActiveTab] = useState('global')
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)
  const [searchQuery, setSearchQuery] = useState('')
  const [customPresetName, setCustomPresetName] = useState('')
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [reloading, setReloading] = useState(false)
  const currentStatus = agentStatuses[activeAgent] || normalizeAgentStatus({}, activeAgent)

  // 应用全局预设
  const applyGlobalPreset = (name: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === name)
    if (!preset) return
    setGlobalPreset(name, preset.theme)
  }

  // 改单个字段 — 标记当前 tab 对应的 zone 为 custom
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = TAB_ZONE_MAP[activeTab] || 'global'
    setZoneField(zone, partial)
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

  const previewZone = TAB_PREVIEW[activeTab]

  const switchAgent = async (agentId: string) => {
    if (switchingAgentId || agentId === activeAgent) return
    setSwitchingAgentId(agentId)
    await switchAgentTransaction(agentId, agentId, {
      switchAgent: () => agentClient.switchAgent(agentId),
      resetRuntime: () => useRuntimeStore.getState().resetAll(),
      setActiveAgent: id => setActiveAgent(id),
      reportError: (action, error) => reportRuntimeError(action, error),
      dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
    })
    setSwitchingAgentId(null)
  }

  const reconnectAgent = async () => {
    if (reconnecting) return
    setReconnecting(true)
    setAgentStatus(activeAgent, { ...beginReconnect({ ...currentStatus, pending: false }), agent: activeAgent })
    try {
      await agentClient.reconnectAgent()
      // command resolve 只代表请求已接受，最终状态由 pylon:agent-status 事件确认。
    } catch (error) {
      const detail = reportRuntimeError('重连 Agent', error)
      setAgentStatus(activeAgent, { ...failReconnect({ ...currentStatus, pending: false }, detail.message), agent: activeAgent })
    } finally { setReconnecting(false) }
  }

  const reloadAgents = async () => {
    if (reloading) return
    setReloading(true)
    try {
      await agentClient.reloadAgents()
      const list = await agentClient.listAgents()
      useIdentityStore.getState().setAgents(list)
    } catch (error) {
      reportRuntimeError('重载 Agent 配置', error)
    } finally { setReloading(false) }
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
      <div className="settings-tier-nav">
        {TIERS.map(item => (
          <button key={item} type="button" className={`set-nav-btn ${tier === item ? 'active' : ''}`} onClick={() => setTier(item)}>
            {TIER_LABELS[item]}
          </button>
        ))}
      </div>
      {tier === 'quick' && (
        <div className="settings-quick">
          <Group title="模板库">
            <TemplateLibrary onApply={applyGlobalPreset} onRestore={applyGlobalPreset} />
          </Group>
          <Group title="宠物">
            <div className="set-preset-row">
              <button className="set-preset-chip" onClick={() => setShowPet(!showPet)}>
                {showPet ? '宠物显示中 — 点击隐藏' : '宠物已隐藏 — 点击显示'}
              </button>
            </div>
          </Group>
          <div className="set-basic-fields">
            {(['global', 'sidebar', 'chat', 'cc'] as const).map(zone => {
              const hasBasic = THEME_FIELD_KEYS.some(key => { const def = THEME_FIELD_DEFS[key] as ThemeFieldDef; return def.zone === zone && def.tier === 'basic' })
              return hasBasic ? <ZoneGroupFields key={zone} zone={zone} ctx={renderCtx} basicOnly /> : null
            })}
          </div>
        </div>
      )}
      {tier !== 'quick' && (
      <div className="settings-tabs-root">
        <div className="settings-nav">
          <div className="settings-nav-group">
            <div className="settings-nav-label">外观</div>
            {TABS.slice(0, 5).map(tab => (
              <button type="button" key={tab}
                className={`set-nav-btn ${activeTab === tab ? 'active' : ''}${custom[TAB_ZONE_MAP[tab]] ? ' custom' : ''}`}
                onClick={() => setActiveTab(tab)} title={custom[TAB_ZONE_MAP[tab]] ? '该区有未保存的自定义改动' : undefined}>
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
          <div className="settings-nav-group settings-nav-runtime">
            <div className="settings-nav-label">运行</div>
            {TABS.slice(5).map(tab => (
              <button type="button" key={tab}
                className={`set-nav-btn ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}>
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
          <div className="settings-nav-footer">
            <button className="set-nav-btn reset" onClick={reset}>重置主题</button>
          </div>
        </div>

        <div className="settings-body">
          {previewZone && (
            <div className="set-toolbar">
              <div className="set-search-wrap">
                <input className="set-search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索设置项…（如 语法、停滞、透明）" />
                {searchQuery && <button type="button" className="set-search-clear" onClick={() => setSearchQuery('')} aria-label="清除搜索">✕</button>}
              </div>
              <button type="button" className="ps-btn sm set-zone-reset"
                onClick={() => resetZone(TAB_ZONE_MAP[activeTab] || 'global')}
                title="将该区全部字段恢复默认">重置本区</button>
            </div>
          )}
          <Tabs.Root value={activeTab} orientation="vertical" onValueChange={setActiveTab}>

            {/* ═══ 全局 ═══ */}
            <Tabs.Content value="global">
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

              {!isSearching && <><WindowSizeRow />
              <ConfigBackupRow /></>}
            </Tabs.Content>

            {/* ═══ 左栏 ═══ */}
            <Tabs.Content value="sidebar">
              {!isSearching && <h3>左侧栏</h3>}
              {!isSearching && <ZonePresetRow zone="sidebar" activeName={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').isCustom} onApply={applyLocalPreset}/>}
              <ZoneGroupFields zone="sidebar" ctx={renderCtx} />
            </Tabs.Content>

            {/* ═══ 终端 ═══ */}
            <Tabs.Content value="terminal">
              {!isSearching && <ZonePresetRow zone="chat" activeName={deriveZoneStatus({ appliedPreset, custom }, 'chat').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'chat').isCustom} onApply={applyLocalPreset}/>}

              {!isSearching && <Group title="指示器形状">
                <Row label="形状"><Sel value={resolveToolIndicatorAsset(t.toolIndicator).id} onChange={v=>onSettingChange({toolIndicator:v})} options={toolIndicatorOptions()} /></Row>
              </Group>}
              <ZoneGroupFields zone="chat" ctx={renderCtx} />
            </Tabs.Content>

            {/* ═══ 中控区 ═══ */}
            <Tabs.Content value="cc">
              {!isSearching && <h3>中控区</h3>}
              {!isSearching && <ZonePresetRow zone="cc" activeName={deriveZoneStatus({ appliedPreset, custom }, 'cc').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'cc').isCustom} onApply={applyLocalPreset}/>}

              <ZoneGroupFields zone="cc" ctx={renderCtx} />
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
            </Tabs.Content>

            {/* ═══ 右栏 ═══ */}
            <Tabs.Content value="right">
              {!isSearching && <h3>右侧栏</h3>}
              {!isSearching && <ZonePresetRow zone="right" activeName={deriveZoneStatus({ appliedPreset, custom }, 'right').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'right').isCustom} onApply={applyLocalPreset}/>}

              <ZoneGroupFields zone="right" ctx={renderCtx} />
            </Tabs.Content>

            {/* ═══ Agent ═══ */}
            <Tabs.Content value="agent">
              <h3>Agent</h3>
              <Group title="当前 Agent">
                <div style={{ padding:'8px 0', fontFamily:'var(--mono)', fontSize:14, color:'var(--accent)' }}>
                  {activeAgent || 'peri'}
                </div>
                <div className="set-hint">状态：{statusLabel(currentStatus.status)}</div>
                {currentStatus.transport && <div className="set-hint">Transport：{currentStatus.transport}</div>}
                {currentStatus.cwd && <div className="set-hint">CWD：{currentStatus.cwd}</div>}
                {currentStatus.recentError && <div className="set-hint" role="alert">最近错误：{currentStatus.recentError}</div>}
                <div className="set-preset-row">
                  <button className="ps-btn sm" disabled={reconnecting} onClick={reconnectAgent}>{reconnecting ? '重连中…' : '重连'}</button>
                  <button className="ps-btn sm" disabled={reloading} onClick={reloadAgents}>{reloading ? '重载中…' : '重载配置'}</button>
                </div>
              </Group>
              <Group title="切换 Agent（需重启）">
                {agents.map((a) => (
                  <Row key={a.id} label={a.name}>
                    <button className={`ps-btn sm ${a.id === activeAgent ? 'primary' : ''}`}
                      disabled={switchingAgentId !== null || a.id === activeAgent}
                      aria-busy={switchingAgentId === a.id}
                      onClick={() => switchAgent(a.id)}>
                      {switchingAgentId === a.id ? '连接中…' : a.id === activeAgent ? '当前' : '切换'}
                    </button>
                  </Row>
                ))}
              </Group>
              <div className="set-hint" style={{marginTop:16}}>
                切换 Agent 后需重启 Prism Desktop 生效。
              </div>
              <Group title="动态配置">
                <ConfigOptionsPanel sessionSource={activeSessionSource} />
              </Group>
            </Tabs.Content>

            {/* ═══ 会话 ═══ */}
            <Tabs.Content value="session">
              <div className="settings-empty-state">
                <span className="settings-empty-kicker">当前会话</span>
                <h3>会话设置从会话入口打开</h3>
                <p>在左栏目标会话右侧点击设置按钮，可编辑工作目录与 Session Prompt。会话级 Skills / Hooks 暂未接入运行时。</p>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </div>

        {previewZone && (
          <div className="settings-preview-pane">
            <div className="settings-preview-label">实时预览</div>
            <SettingsPreview zone={previewZone} />
          </div>
        )}
      </div>
      )}
    </div>
  )
}
