import { useState, useEffect, useRef } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { clearWindowSize } from '../windowSizePersistence'
import { applyImportPayload, buildExportPayload, configFileName } from '../configExportImport'
import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import { GLOBAL_PRESETS, pickZoneFields } from '../presets'
import { pickCustomPresetTheme } from '../customPresets'
import ColorPopover from './ColorPopover'
import SettingsPreview from './SettingsPreview'
import { reportRuntimeError } from '../runtimeError'
import { resolveBackgroundImage } from '../backgroundImage'
import { runAgentSwitchTransaction } from './agentSwitchTransaction'
import './SettingsCommon.css'
import './Settings.css'
import { normalizeAgentStatus, statusLabel } from './settings/agentTypes'
import { beginReconnect, failReconnect, normalizeAgentList } from './settings/agentState'
import ConfigOptionsPanel from './settings/ConfigOptionsPanel'
import { resolveSpinnerFrames } from './chat/spinnerFrames'
import { resolveToolIndicatorAsset, toolIndicatorOptions } from './chat/toolIndicatorAssets'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../ccHeightState'

// ── helpers ──

function BgImageRow({ label, value, onChange }: { label:string; value:string; onChange:(v:string)=>void }) {
  const resolved = resolveBackgroundImage(value)
  const openFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','webp','bmp'] }] })
      if (selected) onChange(selected as string)
    } catch { /* browser fallback */ }
  }
  return (
    <Row label={label}>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" style={{width:'160px'}} placeholder="路径或 URL" />
      <button className="ps-btn sm" onClick={openFile}>选择</button>
      {value && <>
        <div className={`set-bg-preview ${resolved.error ? 'error' : ''}`} style={{backgroundImage:resolved.cssValue}}
          onClick={() => onChange('')} title={resolved.error ? `加载失败：${resolved.error}；点击清除` : '点击清除'} />
        {resolved.error && <span className="set-bg-error" role="alert">{resolved.error}</span>}
      </>}
    </Row>
  )
}

function Row({ label, children }: { label:string; children:React.ReactNode }) {
  return <div className="set-row"><span className="set-row-label">{label}</span>{children}</div>
}

function Slider({ value, onChange, min, max, step }: { value:number; onChange:(v:number)=>void; min:number; max:number; step?:number }) {
  return <input type="range" min={min} max={max} step={step||0.05} value={value}
    onChange={e => onChange(+e.target.value)} className="set-range"/>
}

function Num({ value, onChange, min, max }: { value:number; onChange:(v:number)=>void; min?:number; max?:number }) {
  return <input type="number" min={min} max={max} value={value} step={0.1}
    onChange={e => onChange(+e.target.value)} className="set-num"/>
}

function Sel({ value, onChange, options }: { value:string; onChange:(v:string)=>void; options:(string | { value: string; label: string })[] }) {
  return <select value={value} onChange={e => onChange(e.target.value)} className="set-select">
    {options.map(option => {
      const item = typeof option === 'string' ? { value: option, label: option } : option
      return <option key={item.value} value={item.value}>{item.label}</option>
    })}
  </select>
}

function Txt({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  return <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input"/>
}

function SpinnerMarkerRow({ label, mode, value, frames, onModeChange, onValueChange }: {
  label: string
  mode: ThemeSettings['spinnerDoneMarkerMode']
  value: string
  frames: string[]
  onModeChange: (value: ThemeSettings['spinnerDoneMarkerMode']) => void
  onValueChange: (value: string) => void
}) {
  const safeFrames = frames.length > 0 ? frames : ['·']
  return (
    <Row label={label}>
      <Sel value={mode} onChange={v => onModeChange(v as ThemeSettings['spinnerDoneMarkerMode'])} options={['frame', 'custom']} />
      {mode === 'frame'
        ? <Sel value={safeFrames.includes(value) ? value : safeFrames[0]} onChange={onValueChange} options={safeFrames} />
        : <Txt value={value} onChange={onValueChange} />}
    </Row>
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

// 窗口尺寸：显示当前值 + 重置（记忆由 App 的 onResized 防抖持久化负责）
function WindowSizeRow() {
  const [size, setSize] = useState('—')
  useEffect(() => {
    if (typeof (window as any).__TAURI_INTERNALS__ === 'undefined') return
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

// 配置导出/导入：Tauri 对话框 + 浏览器下载/上传 fallback
function ConfigBackupRow() {
  const [msg, setMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const isTauri = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined'
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
      const result = applyImportPayload(localStorage, json)
      setMsg(result.ok
        ? `已导入 ${result.keys.length} 项配置，刷新后生效`
        : `导入失败：${result.error}`)
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

// 局部预设 chip 行 — 复用于每个 zone
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
  const setGlobalPreset = useStore(s => s.setGlobalPreset)
  const setZoneField = useStore(s => s.setZoneField)
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const applyZonePreset = useStore(s => s.applyZonePreset)
  const activePreset = useStore(s => s.activePreset)
  const dirty = useStore(s => s.dirty)
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
  const [activeTab, setActiveTab] = useState('global')
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

  // 改单个字段 — 标记当前 tab 对应的 zone 为 dirty
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = TAB_ZONE_MAP[activeTab] || 'global'
    setZoneField(zone, partial)
  }

  // 局部预设（zone 级别）
  const applyLocalPreset = (zone: string, presetName: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === presetName)
    if (!preset) return
    const sub = pickZoneFields(preset.theme, zone)
    applyZonePreset(zone, presetName, sub)
  }

  const previewZone = TAB_PREVIEW[activeTab]
  const spinnerFrames = resolveSpinnerFrames(t.spinnerFramePreset, t.spinnerCustomFrames)
  const ccMinHeight = resolveCcMinHeight({
    inputMode: t.inputMode,
    footerLayout: t.footerLayout || 'free',
    hintMode: t.cliHintMode || 'full',
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: t.ccHidden || [],
      inputMode: t.inputMode,
      ccStyle: t.ccStyle,
    }),
    cliOverflowMode: t.cliOverflowMode || 'fixed-scroll',
  })

  const switchAgent = async (agentId: string) => {
    if (switchingAgentId || agentId === activeAgent) return
    setSwitchingAgentId(agentId)
    await runAgentSwitchTransaction({
      switchAgent: () => invoke('switch_agent', { name: agentId }),
      onSuccess: () => {
        useRuntimeStore.getState().resetAll()
        setActiveAgent(agentId)
        window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
      },
      onError: error => reportRuntimeError('切换 Agent', error),
    })
    setSwitchingAgentId(null)
  }

  const reconnectAgent = async () => {
    if (reconnecting) return
    setReconnecting(true)
    setAgentStatus(activeAgent, { ...beginReconnect({ ...currentStatus, pending: false }), agent: activeAgent })
    try {
      await invoke('reconnect_agent')
      // command resolve 只代表请求已接受，最终状态由 peri:agent-status 事件确认。
    } catch (error) {
      const detail = reportRuntimeError('重连 Agent', error)
      setAgentStatus(activeAgent, { ...failReconnect({ ...currentStatus, pending: false }, detail.message), agent: activeAgent })
    } finally { setReconnecting(false) }
  }

  const reloadAgents = async () => {
    if (reloading) return
    setReloading(true)
    try {
      await invoke('reload_agents')
      const list = await invoke<unknown>('list_agents')
      useIdentityStore.getState().setAgents(normalizeAgentList(list))
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
      <div className="settings-tabs-root">
        <div className="settings-nav">
          <div className="settings-nav-group">
            <div className="settings-nav-label">外观</div>
            {TABS.slice(0, 5).map(tab => (
              <button type="button" key={tab}
                className={`set-nav-btn ${activeTab === tab ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}>
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
          <Tabs.Root value={activeTab} orientation="vertical" onValueChange={setActiveTab}>

            {/* ═══ 全局 ═══ */}
            <Tabs.Content value="global">
              <h3>用户信息</h3>
              <Group title="个人信息">
                <Row label="显示名"><Txt value={t.userName} onChange={v=>onSettingChange({userName:v})}/></Row>
                <Row label="前缀"><Txt value={t.userPrefix} onChange={v=>onSettingChange({userPrefix:v})}/></Row>
                <Row label="名字颜色">
                  <ColorPopover value={t.userColor} onChange={v=>onSettingChange({userColor:v})}/>
                </Row>
              </Group>

              <h3>外观</h3>
              <Group title="全局预设">
                <div className="set-preset-row">
                  {GLOBAL_PRESETS.map(p => (
                    <button key={p.name} className={`set-preset-chip ${activePreset.global === p.name ? 'active' : ''}`}
                      onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
                  ))}
                  {activePreset.global && !GLOBAL_PRESETS.some(p => p.name === activePreset.global) && (
                    <button className="set-preset-chip active">{activePreset.global}</button>
                  )}
                </div>
                <div className="set-hint">
                  {dirty.global
                    ? '当前为自定义 — 可保存为新预设或覆盖已有预设'
                    : '选择预设后修改任意外观参数，自动切换为自定义'}
                </div>
                <div className="set-custom-preset-save">
                  <input className="set-input" value={customPresetName} onChange={event => setCustomPresetName(event.target.value)} placeholder="自定义预设名称" />
                  <button className="ps-btn sm" onClick={() => {
                    if (!customPresetName.trim()) return
                    const id = saveCustomPreset(customPresetName)
                    applyCustomPreset(id)
                    setCustomPresetName('')
                  }}>保存当前</button>
                </div>
                {customPresets.length > 0 && <div className="set-custom-presets">
                  {customPresets.map(preset => <div className="set-custom-preset" key={preset.id}>
                    <button className={`set-preset-chip ${activePreset.global === preset.id ? 'active' : ''}`} onClick={() => applyCustomPreset(preset.id)}>{preset.name}</button>
                    <button className="ps-btn sm" onClick={() => saveCustomPreset(preset.name, preset.id)}>覆盖</button>
                    <button className="ps-btn sm danger" onClick={() => removeCustomPreset(preset.id)}>删除</button>
                  </div>)}
                </div>}
              </Group>

              <Group title="强调色">
                <Row label="强调色">
                  <ColorPopover value={t.accent || '#3b82f6'} onChange={v=>onSettingChange({accent:v})}/>
                </Row>
                <div className="set-hint">链接、用户前缀、选中/焦点、spinner 光扫的统一取色</div>
              </Group>

              <Group title="布局骨架">
                <Row label="Tab 条"><Sel value={t.showTabBar === false ? 'hidden' : 'shown'} onChange={v=>onSettingChange({showTabBar: v === 'shown'})} options={['shown','hidden']}/></Row>
                <Row label="侧栏"><Sel value={t.showSidebar === false ? 'hidden' : 'shown'} onChange={v=>onSettingChange({showSidebar: v === 'shown'})} options={['shown','hidden']}/></Row>
                <Row label="宠物"><Sel value={t.showPet === false ? 'hidden' : 'shown'} onChange={v=>onSettingChange({showPet: v === 'shown'})} options={['shown','hidden']}/></Row>
                <div className="set-hint">隐藏 Tab/侧栏/宠物可拼出 CC 式纯聊天单流</div>
              </Group>

              <Group title="玻璃效果">
                <BgImageRow label="背景图" value={t.globalBgImage||''} onChange={v=>onSettingChange({globalBgImage:v})}/>
                <Row label="背景底色">
                  <ColorPopover value={t.globalBgColor || '#e8e8ec'} onChange={v=>onSettingChange({globalBgColor:v})}/>
                  <span className="set-hint" style={{marginLeft:8}}>终端/桌面背景模拟色</span>
                </Row>
                <Row label="UI 配色">
                  <div className="set-preset-row">
                    <button className={`set-preset-chip ${t.uiScheme === 'light' ? 'active' : ''}`} onClick={()=>onSettingChange({uiScheme:'light'})}>浅色</button>
                    <button className={`set-preset-chip ${t.uiScheme === 'dark' ? 'active' : ''}`} onClick={()=>onSettingChange({uiScheme:'dark'})}>深色</button>
                  </div>
                </Row>
                <Row label="透明度"><Slider value={t.transparency} onChange={v=>onSettingChange({transparency:v})} min={0} max={1}/>
                  <span className="set-val">{Math.round(t.transparency*100)}%</span></Row>
                <Row label="模糊"><Slider value={t.bgBlur} onChange={v=>onSettingChange({bgBlur:v})} min={0} max={40} step={2}/>
                  <span className="set-val">{t.bgBlur}px</span></Row>
              </Group>

              <Group title="字体">
                <Row label="字体"><Sel value={t.globalFont} onChange={v=>onSettingChange({globalFont:v})} options={['system','mono']}/></Row>
                <Row label="基础字号"><Num value={t.globalFontSize} onChange={v=>onSettingChange({globalFontSize:v})} min={12} max={24}/></Row>
              </Group>

              <WindowSizeRow />
              <ConfigBackupRow />
            </Tabs.Content>

            {/* ═══ 左栏 ═══ */}
            <Tabs.Content value="sidebar">
              <h3>左侧栏</h3>
              <ZonePresetRow zone="sidebar" activeName={activePreset.sidebar} isDirty={dirty.sidebar} onApply={applyLocalPreset}/>
              <Group title="背景">
                <Row label="背景色">
                  <ColorPopover value={t.sidebarBg} onChange={v=>onSettingChange({sidebarBg:v})}/>
                </Row>
                <BgImageRow label="背景图" value={t.sidebarBgImage} onChange={v=>onSettingChange({sidebarBgImage:v})}/>
              </Group>
              <Group title="布局">
                <Row label="栏宽"><Num value={t.sidebarWidth} onChange={v=>onSettingChange({sidebarWidth:v})} min={160} max={400}/></Row>
              </Group>
              <Group title="玻璃效果">
                <Row label="透明度"><Slider value={t.sidebarTransparency} onChange={v=>onSettingChange({sidebarTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.sidebarTransparency*100)}%</span></Row>
                <Row label="模糊"><Slider value={t.sidebarBlur} onChange={v=>onSettingChange({sidebarBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.sidebarBlur}px</span></Row>
              </Group>
              <Group title="文字">
                <Row label="文字颜色">
                  <ColorPopover value={t.sidebarTextColor} onChange={v=>onSettingChange({sidebarTextColor:v})}/>
                </Row>
                <Row label="会话名字号"><Num value={t.sidebarNameSize} onChange={v=>onSettingChange({sidebarNameSize:v})} min={11} max={20}/></Row>
                <Row label="分组标题字号"><Num value={t.sidebarGroupSize} onChange={v=>onSettingChange({sidebarGroupSize:v})} min={10} max={16}/></Row>
              </Group>
            </Tabs.Content>

            {/* ═══ 终端 ═══ */}
            <Tabs.Content value="terminal">
              <h3>聊天区</h3>
              <ZonePresetRow zone="chat" activeName={activePreset.chat} isDirty={dirty.chat} onApply={applyLocalPreset}/>
              <Group title="背景">
                <Row label="背景色">
                  <ColorPopover value={t.chatBg} onChange={v=>onSettingChange({chatBg:v})}/>
                </Row>
                <BgImageRow label="背景图" value={t.chatBgImage} onChange={v=>onSettingChange({chatBgImage:v})}/>
              </Group>
              <Group title="字体">
                <Row label="字体"><Sel value={t.chatFont} onChange={v=>onSettingChange({chatFont:v})} options={['mono','system']}/></Row>
                <Row label="字号"><Num value={t.chatFontSize} onChange={v=>onSettingChange({chatFontSize:v})} min={12} max={22}/></Row>
                <Row label="行高"><Num value={t.chatLineHeight} onChange={v=>onSettingChange({chatLineHeight:v})} min={1.2} max={2.5}/></Row>
              </Group>
              <Group title="颜色">
                <div className="set-compact-row">
                  <span className="set-compact-label">文字</span>
                  <ColorPopover value={t.chatTextColor} onChange={v=>onSettingChange({chatTextColor:v})} chips={false}/>
                  <span className="set-compact-label">内联代码</span>
                  <ColorPopover value={t.chatCodeColor} onChange={v=>onSettingChange({chatCodeColor:v})} chips={false}/>
                  <span className="set-compact-label">代码背景</span>
                  <ColorPopover value={t.chatCodeBg} onChange={v=>onSettingChange({chatCodeBg:v})} chips={false}/>
                </div>
              </Group>
              <Group title="玻璃效果">
                <Row label="透明度"><Slider value={t.chatTransparency} onChange={v=>onSettingChange({chatTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.chatTransparency*100)}%</span></Row>
                <Row label="模糊"><Slider value={t.chatBlur} onChange={v=>onSettingChange({chatBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.chatBlur}px</span></Row>
              </Group>
              <Group title="语法高亮">
                <div className="set-compact-row">
                  <span className="set-compact-label">关键字</span>
                  <ColorPopover value={t.synKeyword} onChange={v=>onSettingChange({synKeyword:v})} chips={false}/>
                  <span className="set-compact-label">字符串</span>
                  <ColorPopover value={t.synString} onChange={v=>onSettingChange({synString:v})} chips={false}/>
                  <span className="set-compact-label">注释</span>
                  <ColorPopover value={t.synComment} onChange={v=>onSettingChange({synComment:v})} chips={false}/>
                  <span className="set-compact-label">数字</span>
                  <ColorPopover value={t.synLiteral} onChange={v=>onSettingChange({synLiteral:v})} chips={false}/>
                </div>
                <div className="set-compact-row">
                  <span className="set-compact-label">类型</span>
                  <ColorPopover value={t.synEntity} onChange={v=>onSettingChange({synEntity:v})} chips={false}/>
                  <span className="set-compact-label">函数</span>
                  <ColorPopover value={t.synFunction} onChange={v=>onSettingChange({synFunction:v})} chips={false}/>
                  <span className="set-compact-label">变量</span>
                  <ColorPopover value={t.synVariable} onChange={v=>onSettingChange({synVariable:v})} chips={false}/>
                  <span className="set-compact-label">属性</span>
                  <ColorPopover value={t.synProperty} onChange={v=>onSettingChange({synProperty:v})} chips={false}/>
                </div>
                <div className="set-compact-row">
                  <span className="set-compact-label">正则</span>
                  <ColorPopover value={t.synRegex} onChange={v=>onSettingChange({synRegex:v})} chips={false}/>
                  <span className="set-compact-label">标题</span>
                  <ColorPopover value={t.synMarkupHeading} onChange={v=>onSettingChange({synMarkupHeading:v})} chips={false}/>
                  <span className="set-compact-label">模块</span>
                  <ColorPopover value={t.synSupport} onChange={v=>onSettingChange({synSupport:v})} chips={false}/>
                </div>
              </Group>

              <h3>工具调用</h3>
              <Group title="指示器">
                <div className="set-compact-row">
                  <span className="set-compact-label">完成</span>
                  <ColorPopover value={t.toolOk} onChange={v=>onSettingChange({toolOk:v})} chips={false}/>
                  <span className="set-compact-label">运行中</span>
                  <ColorPopover value={t.toolRun} onChange={v=>onSettingChange({toolRun:v})} chips={false}/>
                  <span className="set-compact-label">错误</span>
                  <ColorPopover value={t.toolErr} onChange={v=>onSettingChange({toolErr:v})} chips={false}/>
                </div>
              </Group>
              <Group title="文字 & 标签">
                <div className="set-compact-row">
                  <span className="set-compact-label">工具名</span>
                  <ColorPopover value={t.toolNameColor} onChange={v=>onSettingChange({toolNameColor:v})} chips={false}/>
                  <span className="set-compact-label">摘要</span>
                  <ColorPopover value={t.toolSummaryColor} onChange={v=>onSettingChange({toolSummaryColor:v})} chips={false}/>
                </div>
                <div className="set-compact-row" style={{marginTop:4}}>
                  <span className="set-compact-label">标签背景</span>
                  <ColorPopover value={t.userTagBg} onChange={v=>onSettingChange({userTagBg:v})} chips={false}/>
                  <span className="set-compact-label">标签文字</span>
                  <ColorPopover value={t.userTagText} onChange={v=>onSettingChange({userTagText:v})} chips={false}/>
                </div>
              </Group>
              <Group title="指示器 & 连接线">
                <Row label="形状"><Sel value={resolveToolIndicatorAsset(t.toolIndicator).id} onChange={v=>onSettingChange({toolIndicator:v})} options={toolIndicatorOptions()} /></Row>
                <Row label="辉光"><Slider value={t.toolIndicatorGlow} onChange={v=>onSettingChange({toolIndicatorGlow:v})} min={0} max={20} step={1}/><span className="set-val">{t.toolIndicatorGlow}px</span></Row>
                <Row label="辉光色"><ColorPopover value={t.toolIndicatorGlowColor} onChange={v=>onSettingChange({toolIndicatorGlowColor:v})}/></Row>
                <Row label="连接线"><Sel value={t.toolConnectorMode} onChange={v=>onSettingChange({toolConnectorMode:v})} options={['none','fixed','follow']}/></Row>
                <Row label="线样式"><Sel value={t.toolConnectorStyle} onChange={v=>onSettingChange({toolConnectorStyle:v as ThemeSettings['toolConnectorStyle']})} options={['solid','dotted','pulse']}/></Row>
                <Row label="线宽"><Num value={t.toolConnectorWidth} onChange={v=>onSettingChange({toolConnectorWidth:Math.max(1, Math.min(6, v))})} min={1} max={6}/><span className="set-val">px</span></Row>
                <Row label="线透明度"><Slider value={t.toolConnectorOpacity} onChange={v=>onSettingChange({toolConnectorOpacity:v})} min={0.1} max={1} step={0.05}/><span className="set-val">{Math.round(t.toolConnectorOpacity*100)}%</span></Row>
                {t.toolConnectorMode==='fixed' && <Row label="线色"><ColorPopover value={t.toolConnectorColor} onChange={v=>onSettingChange({toolConnectorColor:v})}/></Row>}
              </Group>
              <Group title="Spinner">
                <Row label="动画预设"><Sel value={t.spinnerFramePreset} onChange={v=>onSettingChange({spinnerFramePreset:v as ThemeSettings['spinnerFramePreset']})} options={['sparkles','ascii-line','braille','dots','orbit','clock','wave','blocks','scan','custom']}/></Row>
                {t.spinnerFramePreset === 'custom' && <Row label="自定义帧"><textarea className="set-textarea" value={t.spinnerCustomFrames} onChange={e=>onSettingChange({spinnerCustomFrames:e.target.value})} placeholder="逐字符输入，例如：◐◓◑◒" /></Row>}
                <Row label="文案语言"><Sel value={t.spinnerVerbSet} onChange={v=>onSettingChange({spinnerVerbSet:v as ThemeSettings['spinnerVerbSet']})} options={['zh','en','analysis','engineering','custom']}/></Row>
                {t.spinnerVerbSet === 'custom' && <Row label="自定义文案"><textarea className="set-textarea" value={t.spinnerCustomVerbs} onChange={e=>onSettingChange({spinnerCustomVerbs:e.target.value})} placeholder="每行一条文案" /></Row>}
                <SpinnerMarkerRow label="完成标记" mode={t.spinnerDoneMarkerMode} value={t.spinnerDoneMarker} frames={spinnerFrames}
                  onModeChange={v=>onSettingChange({spinnerDoneMarkerMode:v})} onValueChange={v=>onSettingChange({spinnerDoneMarker:v})}/>
                <SpinnerMarkerRow label="取消标记" mode={t.spinnerCancelledMarkerMode} value={t.spinnerCancelledMarker} frames={spinnerFrames}
                  onModeChange={v=>onSettingChange({spinnerCancelledMarkerMode:v})} onValueChange={v=>onSettingChange({spinnerCancelledMarker:v})}/>
                <SpinnerMarkerRow label="错误标记" mode={t.spinnerErrorMarkerMode} value={t.spinnerErrorMarker} frames={spinnerFrames}
                  onModeChange={v=>onSettingChange({spinnerErrorMarkerMode:v})} onValueChange={v=>onSettingChange({spinnerErrorMarker:v})}/>
                <div className="set-compact-row">
                  <span className="set-compact-label">颜色</span>
                  <ColorPopover value={t.spinnerColor} onChange={v=>onSettingChange({spinnerColor:v})} chips={false}/>
                  <span className="set-compact-label">大小</span>
                  <Num value={t.spinnerSize} onChange={v=>onSettingChange({spinnerSize:v})} min={10} max={32}/>
                  <span className="set-compact-label">间隔</span>
                  <Num value={t.spinnerIntervalMs} onChange={v=>onSettingChange({spinnerIntervalMs: Math.max(40, Math.min(1000, v))})} min={40} max={1000}/>
                  <span className="set-val">ms</span>
                </div>
              </Group>

              <h3>消息渲染</h3>
              <Group title="风格">
                <Row label="信息层级"><Sel value={t.messageLayout || 'classic'} onChange={v=>onSettingChange({messageLayout:v as ThemeSettings['messageLayout']})} options={['classic','claude','bubble']}/></Row>
                <Row label="风格"><Sel value={t.msgStyle} onChange={v=>onSettingChange({msgStyle:v})} options={['terminal','bubble']}/></Row>
                <Row label="字体"><Sel value={t.msgFont} onChange={v=>onSettingChange({msgFont:v})} options={['mono','system']}/></Row>
                <div className="set-compact-row">
                  <span className="set-compact-label">文字颜色</span>
                  <ColorPopover value={t.msgTextColor} onChange={v=>onSettingChange({msgTextColor:v})} chips={false}/>
                  <span className="set-compact-label">行间距</span>
                  <Num value={t.msgLineHeight} onChange={v=>onSettingChange({msgLineHeight:v})} min={1.2} max={2.5}/>
                </div>
              </Group>
            </Tabs.Content>

            {/* ═══ 中控区 ═══ */}
            <Tabs.Content value="cc">
              <h3>中控区</h3>
              <ZonePresetRow zone="cc" activeName={activePreset.cc} isDirty={dirty.cc} onApply={applyLocalPreset}/>
              <Group title="外观风格">
                <Row label="整体风格">
                  <div className="set-preset-row">
                    {(['terminal','glass','pill'] as const).map(v => (
                      <button key={v} className={`set-preset-chip ${t.ccVariant===v?'active':''}`}
                        onClick={()=>onSettingChange({ccVariant:v})}>{v==='terminal'?'终端':v==='glass'?'玻璃':'胶囊'}</button>
                    ))}
                  </div>
                </Row>
                <Row label="高度"><Num value={t.ccHeight} onChange={v=>onSettingChange({ccHeight:Math.max(ccMinHeight, v)})} min={ccMinHeight} max={400}/><span className="set-val">px（最小 {ccMinHeight}）</span></Row>
                <Row label="背景色"><ColorPopover value={t.ccBg} onChange={v=>onSettingChange({ccBg:v})}/></Row>
                <BgImageRow label="背景图" value={t.ccBgImage||''} onChange={v=>onSettingChange({ccBgImage:v})}/>
              </Group>
              <Group title="控件样式">
                <Row label="输入栏"><Sel value={t.inputVariant || (t.inputMode === 'cli' ? 'cli' : 'composer')} onChange={v=>onSettingChange({inputVariant:v as ThemeSettings['inputVariant'], inputMode:v === 'cli' ? 'cli' : 'default'})} options={['cli','composer','compact','command']}/></Row>
                <Row label="Placeholder"><Sel value={t.inputShowPlaceholder === false ? 'hidden' : 'shown'} onChange={v=>onSettingChange({inputShowPlaceholder:v === 'shown'})} options={['shown','hidden']}/></Row>
                <Row label="历史提示"><Sel value={t.inputShowHistoryHint === false ? 'hidden' : 'shown'} onChange={v=>onSettingChange({inputShowHistoryHint:v === 'shown'})} options={['shown','hidden']}/></Row>
                <Row label="发送按钮"><Sel value={t.inputSubmitButtonMode || 'inline'} onChange={v=>onSettingChange({inputSubmitButtonMode:v as ThemeSettings['inputSubmitButtonMode']})} options={['inline','external','hidden']}/></Row>
                <Row label="Footer 布局"><Sel value={t.footerLayout || 'free'} onChange={v=>onSettingChange({footerLayout:v as ThemeSettings['footerLayout']})} options={['free','peri']}/></Row>
                <Row label="多行策略"><Sel value={t.cliOverflowMode || 'fixed-scroll'} onChange={v=>onSettingChange({cliOverflowMode:v as ThemeSettings['cliOverflowMode']})} options={['fixed-scroll','grow','overlay']}/></Row>
                <Row label="提示符颜色"><ColorPopover value={t.cliPromptColor || ''} onChange={v=>onSettingChange({cliPromptColor:v})}/></Row>
                <Row label="内容垂直偏移"><Num value={t.cliContentOffsetY ?? 0} onChange={v=>onSettingChange({cliContentOffsetY:v})} min={-6} max={6}/><span className="set-val">px</span></Row>
                <Row label="命令提示"><Sel value={t.cliHintMode || 'full'} onChange={v=>onSettingChange({cliHintMode:v as ThemeSettings['cliHintMode']})} options={['hidden','compact','full']}/></Row>
                <Row label="上下文"><Sel value={t.ccStyle} onChange={v=>onSettingChange({ccStyle:v})} options={['wave','bar','ring','numeric']}/></Row>
                <Row label="信息字号"><Num value={t.ccStatusFontSize ?? 14} onChange={v=>onSettingChange({ccStatusFontSize:v})} min={14} max={20}/></Row>
                <Row label="模型"><Sel value={t.modelVariant} onChange={v=>onSettingChange({modelVariant:v})} options={['dropdown','minimal','badge']}/></Row>
                <Row label="模式"><Sel value={t.modeVariant} onChange={v=>onSettingChange({modeVariant:v})} options={['pill','badge','minimal']}/></Row>
                <Row label="发送"><Sel value={t.sendVariant} onChange={v=>onSettingChange({sendVariant:v})} options={['icon','square','minimal']}/></Row>
                <Row label="附件"><Sel value={t.attachVariant} onChange={v=>onSettingChange({attachVariant:v})} options={['icon','square','minimal']}/></Row>
              </Group>
              <Group title="布局编辑">
                <button className="ps-btn primary"
                  onClick={() => {
                    const cur = useStore.getState().ccEditMode
                    setCcEditMode(!cur)
                    if (typeof onClose === 'function') onClose?.()
                  }}>
                  {t.ccEditMode ? '退出布局编辑器' : '进入布局编辑器'}
                </button>
                <div className="set-hint">位置 / 大小 / 显隐 在编辑器中拖拽调整</div>
              </Group>
            </Tabs.Content>

            {/* ═══ 右栏 ═══ */}
            <Tabs.Content value="right">
              <h3>右侧栏</h3>
              <ZonePresetRow zone="right" activeName={activePreset.right} isDirty={dirty.right} onApply={applyLocalPreset}/>
              <Group title="外观">
                <Row label="背景色"><ColorPopover value={t.rightBg} onChange={v=>onSettingChange({rightBg:v})}/></Row>
                <BgImageRow label="背景图" value={t.rightBgImage||''} onChange={v=>onSettingChange({rightBgImage:v})}/>
                <Row label="宽度"><Num value={t.rightWidth} onChange={v=>onSettingChange({rightWidth:v})} min={200} max={400}/></Row>
              </Group>
              <Group title="玻璃效果">
                <Row label="透明度"><Slider value={t.rightTransparency} onChange={v=>onSettingChange({rightTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.rightTransparency*100)}%</span></Row>
                <Row label="模糊"><Slider value={t.rightBlur} onChange={v=>onSettingChange({rightBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.rightBlur}px</span></Row>
              </Group>
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
    </div>
  )
}
