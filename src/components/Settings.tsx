import { useRef, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import type { ThemeSettings } from '../store'
import PresetRow from './PresetRow'
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './Settings.css'

// ── helpers ──

const COLOR_CHIPS = ['#a855f7','#3b82f6','#34d399','#f59e0b','#ef4444','#ec4899','#6366f1']

function Swatch({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  const ref = useRef<HTMLInputElement>(null)
  return <>
    <div className="set-swatch" style={{background:value}} onClick={() => ref.current?.click()}/>
    <input ref={ref} type="color" value={value} onChange={e => onChange(e.target.value)} className="set-swatch-input"/>
  </>
}

function ColorPopover({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)

  return (
    <div className="set-color-wrap" ref={ref}>
      <div className="set-swatch" style={{background:value}} onClick={() => setOpen(!open)}/>
      {open && <>
        <div className="set-color-popover">
          {COLOR_CHIPS.map(c => (
            <div key={c} className={`set-color-chip ${value === c ? 'active' : ''}`}
              style={{background:c}} onClick={() => { onChange(c); setOpen(false) }} />
          ))}
          <button className="set-color-custom" onClick={() => pickerRef.current?.click()}>自定义</button>
        </div>
        <div className="set-color-backdrop" onClick={() => setOpen(false)}/>
      </>}
      <input ref={pickerRef} type="color" value={value} onChange={e => { onChange(e.target.value); setOpen(false) }} className="set-swatch-input"/>
    </div>
  )
}

function BgImageRow({ label, value, onChange }: { label:string; value:string; onChange:(v:string)=>void }) {
  const openFile = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ multiple: false, filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','webp','bmp'] }] })
      if (selected) onChange(selected as string)
    } catch { /* browser fallback */ }
  }
  return (
    <Row label={label}>
      <div style={{display:'flex',alignItems:'center',gap:6,flex:1}}>
        <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" style={{flex:1}} placeholder="路径或 URL" />
        <button className="ps-btn sm" onClick={openFile}>选择</button>
      </div>
      {value && <div className="set-bg-preview" style={{backgroundImage:`url(${value})`}}
        onClick={() => onChange('')} title="点击清除" />}
    </Row>
  )
}

function Row({ label, children }: { label:string; children:React.ReactNode }) {
  return <div className="set-row"><span className="set-row-label">{label}</span>{children}</div>
}

function Slider({ value, onChange, min, max, step }: { value:number; onChange:(v:number)=>void; min:number; max:number; step?:number }) {
  return <input type="range" min={min} max={max} step={step||0.05} value={value}
    onChange={e => onChange(+e.target.value)} className="set-range" style={{width:'120px'}}/>
}

function Num({ value, onChange, min, max }: { value:number; onChange:(v:number)=>void; min?:number; max?:number }) {
  return <input type="number" min={min} max={max} value={value}
    onChange={e => onChange(+e.target.value)} className="set-num"/>
}

function Sel({ value, onChange, options }: { value:string; onChange:(v:string)=>void; options:string[] }) {
  return <select value={value} onChange={e => onChange(e.target.value)} className="set-select">
    {options.map(o => <option key={o}>{o}</option>)}
  </select>
}

function Txt({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  return <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" style={{width:'140px'}}/>
}

function Group({ title, children, defaultOpen }: { title:string; children:React.ReactNode; defaultOpen?:boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="set-group">
      <div className="set-group-title" onClick={() => setOpen(!open)}>
        <span className="set-group-arrow">{open ? '▾' : '▸'}</span>
        {title}
      </div>
      {open && children}
    </div>
  )
}

// ── global presets ──

const GLOBAL_PRESETS: { name: string; label: string; theme: Partial<ThemeSettings> }[] = [
  {
    name: 'claude', label: 'Claude Code',
    theme: {
      transparency: 0.95, bgBlur: 8, globalFont: 'mono', globalFontSize: 16,
      sidebarBg: '#16162a', sidebarWidth: 250, sidebarTextColor: '#a0a0c0', sidebarNameSize: 14, sidebarGroupSize: 12,
      chatBg: '#1a1a2e', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.6, chatTextColor: '#cdd6f4', chatCodeColor: '#f9c74f', chatCodeBg: 'rgba(255,255,255,0.05)',
      toolOk: '#4ade80', toolRun: '#60a5fa', toolErr: '#f87171', toolNameColor: '#cdd6f4', toolSummaryColor: 'rgba(205,214,244,0.4)',
      userTagBg: 'rgba(168,85,247,0.12)', userTagText: '#c4b5fd',
      inputBg: 'rgba(255,255,255,0.04)', inputTextColor: '#cdd6f4', inputPlaceholder: 'rgba(205,214,244,0.28)', inputSendBg: 'rgba(205,214,244,0.1)', inputFocusBorder: 'rgba(96,165,250,0.4)', inputFontSize: 17, inputMinHeight: 56,
      inputMode: 'default', cliLineWidth: 2, cliLineColor: '#60a5fa', cliTextColor: '#cdd6f4',
      statusBg: 'rgba(22,22,42,0.8)', ekgWidth: 150, ekgFontSize: 16, ekgGreen: '#4ade80', ekgYellow: '#f9c74f', ekgRed: '#f87171',
      pillBg: 'rgba(255,255,255,0.04)', pillText: 'rgba(205,214,244,0.65)', prismOnColor: '#4ade80',
      ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2,
      ekgLeftColor: 'rgba(205,214,244,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(205,214,244,0.08)', tokenDisplay: 'ekg',
      rightBg: 'rgba(22,22,42,0.8)', rightWidth: 260,
      sidebarTransparency: 1, sidebarBlur: 0, chatTransparency: 1, chatBlur: 0, rightTransparency: 1, rightBlur: 0,
      ccHeight: 120, ccBgHeight: 120, ccBg: 'transparent', ccStyle: 'wave',
      userName: '', userPrefix: '❯', userColor: '',
      toolIndicator: '●', sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊', spinnerColor: '', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,
    }
  },
  {
    name: 'glass', label: 'Glass Light',
    theme: {
      transparency: 0.85, bgBlur: 16, globalFont: 'system', globalFontSize: 18,
      sidebarBg: 'rgba(0,0,0,0.02)', sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
      chatBg: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.4, chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
      toolOk: '#1e9646', toolRun: '#3b82f6', toolErr: '#be2828', toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.4)',
      userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
      inputBg: 'rgba(0,0,0,0.02)', inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)', inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputFontSize: 17, inputMinHeight: 56,
      inputMode: 'default', cliLineWidth: 2, cliLineColor: '', cliTextColor: '',
      statusBg: 'rgba(0,0,0,0.02)', ekgWidth: 150, ekgFontSize: 16, ekgGreen: '#1e9646', ekgYellow: '#b47814', ekgRed: '#be2828',
      pillBg: 'rgba(0,0,0,0.04)', pillText: 'rgba(0,0,0,0.65)', prismOnColor: '#1e9646',
      ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2,
      ekgLeftColor: 'rgba(0,0,0,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.08)', tokenDisplay: 'ekg',
      rightBg: 'rgba(0,0,0,0.02)', rightWidth: 260,
      sidebarTransparency: 1, sidebarBlur: 0, chatTransparency: 1, chatBlur: 0, rightTransparency: 1, rightBlur: 0,
      ccHeight: 120, ccBgHeight: 120, ccBg: 'transparent', ccStyle: 'wave',
      userName: '', userPrefix: '❯', userColor: '',
      toolIndicator: '●', sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊', spinnerColor: '', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,
    }
  },
  {
    name: 'nord', label: 'Nord Frost',
    theme: {
      transparency: 0.95, bgBlur: 8, globalFont: 'system', globalFontSize: 17,
      sidebarBg: '#2e3440', sidebarWidth: 250, sidebarTextColor: '#d8dee9', sidebarNameSize: 14, sidebarGroupSize: 12,
      chatBg: '#242933', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.6, chatTextColor: '#d8dee9', chatCodeColor: '#ebcb8b', chatCodeBg: 'rgba(255,255,255,0.04)',
      toolOk: '#a3be8c', toolRun: '#81a1c1', toolErr: '#bf616a', toolNameColor: '#d8dee9', toolSummaryColor: 'rgba(216,222,233,0.4)',
      userTagBg: 'rgba(180,142,173,0.15)', userTagText: '#b48ead',
      inputBg: 'rgba(255,255,255,0.04)', inputTextColor: '#d8dee9', inputPlaceholder: 'rgba(216,222,233,0.28)', inputSendBg: 'rgba(216,222,233,0.1)', inputFocusBorder: 'rgba(136,192,208,0.4)', inputFontSize: 17, inputMinHeight: 56,
      inputMode: 'default', cliLineWidth: 2, cliLineColor: '#88c0d0', cliTextColor: '#d8dee9',
      statusBg: '#2e3440', ekgWidth: 150, ekgFontSize: 16, ekgGreen: '#a3be8c', ekgYellow: '#ebcb8b', ekgRed: '#bf616a',
      pillBg: 'rgba(255,255,255,0.04)', pillText: 'rgba(216,222,233,0.65)', prismOnColor: '#a3be8c',
      ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2,
      ekgLeftColor: 'rgba(216,222,233,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(216,222,233,0.08)', tokenDisplay: 'ekg',
      rightBg: '#2e3440', rightWidth: 260,
      sidebarTransparency: 1, sidebarBlur: 0, chatTransparency: 1, chatBlur: 0, rightTransparency: 1, rightBlur: 0,
      ccHeight: 120, ccBgHeight: 120, ccBg: 'transparent', ccStyle: 'wave',
      userName: '', userPrefix: '❯', userColor: '',
      toolIndicator: '●', sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊', spinnerColor: '', spinnerSize: 14,
      msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,
    }
  },
]

// ── local preset helper ──

const SIDEBAR_FIELDS = ['sidebarBg','sidebarBgImage','sidebarWidth','sidebarTransparency','sidebarBlur','sidebarTextColor','sidebarNameSize','sidebarGroupSize'] as const
type SidebarFields = typeof SIDEBAR_FIELDS[number]
const TERMINAL_FIELDS = ['chatBg','chatBgImage','chatTransparency','chatBlur','chatFont','chatFontSize','chatLineHeight','chatTextColor','chatCodeColor','chatCodeBg','toolOk','toolRun','toolErr','toolNameColor','toolSummaryColor','userTagBg','userTagText','toolIndicator','sparkles','spinnerColor','spinnerSize','msgStyle','msgFont','msgTextColor','msgLineHeight'] as const
const CC_FIELDS = ['ccHeight','ccBgHeight','ccBg','inputBg','inputBgImage','inputTextColor','inputPlaceholder','inputSendBg','inputFocusBorder','inputFontSize','inputMinHeight','inputMode','cliLineWidth','cliLineColor','cliTextColor','statusBg','statusBgImage','ekgWidth','ekgFontSize','ekgGreen','ekgYellow','ekgRed','pillBg','pillText','prismOnColor','ekgLineWidth','ekgAmplitudeMax','ekgSpeedBase','ekgSpeedMax','ekgLeftColor','ekgMovingColor','ekgConsumedColor','tokenDisplay','ccStyle'] as const
const RIGHT_FIELDS = ['rightBg','rightBgImage','rightWidth','rightTransparency','rightBlur'] as const

function pickPresetFields(preset: Partial<ThemeSettings>, fields: readonly string[]): Partial<ThemeSettings> {
  const out: any = {}
  for (const f of fields) if (f in preset) out[f] = (preset as any)[f]
  return out
}

// ── CC widget drag-to-reorder ──

const WIDGET_LABELS: Record<string, string> = {
  input: '输入栏', context: '上下文仪表', model: '模型选择', mode: '模式切换',
}

function SortableWidget({ id }: { id: string }) {
  const u = useStore(s => s.updateTheme)
  const hidden = (useStore(s => s.ccHidden) || []).includes(id)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div ref={setNodeRef} style={{
      transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1,
    }} className="set-row" {...attributes}>
      <span {...listeners} className="cc-drag-handle" style={{ cursor:'grab', color:'var(--text-dim)', fontSize:14, userSelect:'none' }}>☰</span>
      <span className="set-row-label">{WIDGET_LABELS[id] || id}</span>
      <label className="cc-vis-toggle">
        <input type="checkbox" checked={!hidden} onChange={() => {
          const h = useStore.getState().ccHidden || []
          u({ ccHidden: hidden ? h.filter(x => x !== id) : [...h, id] } as any)
        }} />
        <span style={{ fontSize:11, color: hidden ? 'var(--text-dim)' : 'var(--success)' }}>{hidden ? '隐藏' : '显示'}</span>
      </label>
    </div>
  )
}

// ── nav ──

const TABS = ['global', 'sidebar', 'terminal', 'cc', 'right', 'agent', 'session'] as const
const TAB_LABELS: Record<string, string> = {
  global: '全局', sidebar: '左栏', terminal: '终端', cc: '中控区', right: '右栏',
  agent: 'Agent', session: '会话',
}

// ── main ──

export default function Settings({ onClose }: { onClose?: () => void }) {
  const t = useStore() as ThemeSettings
  const u = useStore(s => s.updateTheme)
  const reset = useStore(s => s.resetTheme)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('global')
  const [globalPreset, setGlobalPreset] = useState(useStore.getState().activePreset?.global || '')

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const layout = [...(t.ccLayout || ['input', 'context', 'model', 'mode'])]
    const oldIdx = layout.indexOf(active.id as string)
    const newIdx = layout.indexOf(over.id as string)
    if (oldIdx === -1 || newIdx === -1) return
    layout.splice(oldIdx, 1)
    layout.splice(newIdx, 0, active.id as string)
    u({ ccLayout: layout } as any)
  }

  const applyGlobalPreset = (name: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === name)
    if (!preset) return
    u(preset.theme as any)
    setGlobalPreset(name)
    useStore.setState(s => ({ activePreset: { ...s.activePreset, global: name } }))
  }

  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    u(partial)
    if (globalPreset && GLOBAL_PRESETS.some(p => p.name === globalPreset)) {
      // switched away from built-in preset → custom
      const existing = Object.keys(useStore.getState().presets || {})
      let n = 1
      while (existing.includes(`custom-${n}`)) n++
      const cn = `custom-${n}`
      setGlobalPreset(cn)
      useStore.setState(s => ({ activePreset: { ...s.activePreset, global: cn } }))
    }
  }

  const s = search.trim().toLowerCase()

  return (
    <div className="settings">
      {onClose && <button className="settings-close" onClick={onClose}>✕</button>}
      <div className="settings-search-bar">
        <input className="set-search" placeholder="搜索设置..." value={search}
          onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="settings-tabs-root">
        <div className="settings-nav">
          {TABS.map(tab => (
            <div key={tab}
              className={`set-nav-btn ${activeTab === tab ? 'active' : ''} ${s && !TAB_LABELS[tab].toLowerCase().includes(s) ? 'dim' : ''}`}
              onClick={() => { setActiveTab(tab); setSearch('') }}>
              {TAB_LABELS[tab]}
            </div>
          ))}
          <hr className="set-nav-hr"/>
          <button className="set-nav-btn reset" onClick={reset}>Reset</button>
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
                    <button key={p.name} className={`set-preset-chip ${globalPreset === p.name ? 'active' : ''}`}
                      onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
                  ))}
                  {globalPreset && !GLOBAL_PRESETS.some(p => p.name === globalPreset) && (
                    <button className="set-preset-chip active">{globalPreset}</button>
                  )}
                </div>
                <div style={{fontSize:11,color:'var(--text-dim)',marginTop:4}}>
                  选择预设后修改任意外观参数，自动切换为自定义
                </div>
              </Group>

              <Group title="玻璃效果">
                <BgImageRow label="背景图" value={t.globalBgImage||''} onChange={v=>onSettingChange({globalBgImage:v})}/>
                <Row label="透明度"><Slider value={t.transparency} onChange={v=>onSettingChange({transparency:v})} min={0} max={1}/>
                  <span className="set-val">{Math.round(t.transparency*100)}%</span></Row>
                <Row label="模糊"><Slider value={t.bgBlur} onChange={v=>onSettingChange({bgBlur:v})} min={0} max={40} step={2}/>
                  <span className="set-val">{t.bgBlur}px</span></Row>
              </Group>

              <Group title="字体">
                <Row label="字体"><Sel value={t.globalFont} onChange={v=>onSettingChange({globalFont:v})} options={['system','mono']}/></Row>
                <Row label="基础字号"><Num value={t.globalFontSize} onChange={v=>onSettingChange({globalFontSize:v})} min={12} max={24}/></Row>
              </Group>
            </Tabs.Content>

            {/* ═══ 左栏 ═══ */}
            <Tabs.Content value="sidebar">
              <h3>左侧栏</h3>
              <Group title="局部预设">
                <div className="set-preset-row">
                  {GLOBAL_PRESETS.map(p => (
                    <button key={p.name} className={`set-preset-chip`}
                      onClick={() => u(pickPresetFields(p.theme, SIDEBAR_FIELDS) as any)}>{p.label}</button>
                  ))}
                </div>
              </Group>
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
              <Group title="局部预设">
                <div className="set-preset-row">
                  {GLOBAL_PRESETS.map(p => (
                    <button key={p.name} className="set-preset-chip"
                      onClick={() => u(pickPresetFields(p.theme, TERMINAL_FIELDS) as any)}>{p.label}</button>
                  ))}
                </div>
              </Group>

              <h3>聊天区</h3>
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
                  <ColorPopover value={t.chatTextColor} onChange={v=>onSettingChange({chatTextColor:v})}/>
                  <span className="set-compact-label">内联代码</span>
                  <ColorPopover value={t.chatCodeColor} onChange={v=>onSettingChange({chatCodeColor:v})}/>
                  <span className="set-compact-label">代码背景</span>
                  <ColorPopover value={t.chatCodeBg} onChange={v=>onSettingChange({chatCodeBg:v})}/>
                </div>
              </Group>
              <Group title="玻璃效果">
                <Row label="透明度"><Slider value={t.chatTransparency} onChange={v=>onSettingChange({chatTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.chatTransparency*100)}%</span></Row>
                <Row label="模糊"><Slider value={t.chatBlur} onChange={v=>onSettingChange({chatBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.chatBlur}px</span></Row>
              </Group>

              <h3>工具调用</h3>
              <Group title="指示器">
                <div className="set-compact-row">
                  <span className="set-compact-label">完成</span>
                  <ColorPopover value={t.toolOk} onChange={v=>onSettingChange({toolOk:v})}/>
                  <span className="set-compact-label">运行中</span>
                  <ColorPopover value={t.toolRun} onChange={v=>onSettingChange({toolRun:v})}/>
                  <span className="set-compact-label">错误</span>
                  <ColorPopover value={t.toolErr} onChange={v=>onSettingChange({toolErr:v})}/>
                </div>
              </Group>
              <Group title="文字 & 标签">
                <div className="set-compact-row">
                  <span className="set-compact-label">工具名</span>
                  <ColorPopover value={t.toolNameColor} onChange={v=>onSettingChange({toolNameColor:v})}/>
                  <span className="set-compact-label">摘要</span>
                  <ColorPopover value={t.toolSummaryColor} onChange={v=>onSettingChange({toolSummaryColor:v})}/>
                </div>
                <div className="set-compact-row" style={{marginTop:4}}>
                  <span className="set-compact-label">标签背景</span>
                  <ColorPopover value={t.userTagBg} onChange={v=>onSettingChange({userTagBg:v})}/>
                  <span className="set-compact-label">标签文字</span>
                  <ColorPopover value={t.userTagText} onChange={v=>onSettingChange({userTagText:v})}/>
                </div>
              </Group>
              <Group title="指示器 & Spinner">
                <Row label="形状"><Sel value={t.toolIndicator} onChange={v=>onSettingChange({toolIndicator:v})} options={['●','◆','■','▲','▶']}/></Row>
                <Row label="字符集"><Sel value={t.sparkles} onChange={v=>onSettingChange({sparkles:v})} options={[
                  '✳✴✵✶✷✸✹✺✻✼❃❊','◴◷◶◵','·○◎●◉◎○','←↖↑↗→↘↓↙','▖▗▘▝▗▖▝▘','▁▂▃▄▅▆▇█▇▆▅▄▃','┌┐┘└','⠁⠂⠄⡀⢀⠠⠐⠈'
                ]}/></Row>
                <div className="set-compact-row">
                  <span className="set-compact-label">颜色</span>
                  <ColorPopover value={t.spinnerColor} onChange={v=>onSettingChange({spinnerColor:v})}/>
                  <span className="set-compact-label">大小</span>
                  <Num value={t.spinnerSize} onChange={v=>onSettingChange({spinnerSize:v})} min={10} max={32}/>
                </div>
              </Group>

              <h3>消息渲染</h3>
              <Group title="风格">
                <Row label="风格"><Sel value={t.msgStyle} onChange={v=>onSettingChange({msgStyle:v})} options={['terminal','bubble']}/></Row>
                <Row label="字体"><Sel value={t.msgFont} onChange={v=>onSettingChange({msgFont:v})} options={['mono','system']}/></Row>
                <div className="set-compact-row">
                  <span className="set-compact-label">文字颜色</span>
                  <ColorPopover value={t.msgTextColor} onChange={v=>onSettingChange({msgTextColor:v})}/>
                  <span className="set-compact-label">行间距</span>
                  <Num value={t.msgLineHeight} onChange={v=>onSettingChange({msgLineHeight:v})} min={1.2} max={2.5}/>
                </div>
              </Group>
            </Tabs.Content>

            {/* ═══ 中控区 ═══ */}
            <Tabs.Content value="cc">
              <PresetRow area="cc" />

              <Group title="控件排序">
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={t.ccLayout || ['input', 'context', 'model', 'mode']} strategy={verticalListSortingStrategy}>
                    {(t.ccLayout || ['input', 'context', 'model', 'mode']).map(id => (
                      <SortableWidget key={id} id={id} />
                    ))}
                  </SortableContext>
                </DndContext>
              </Group>

              <Group title="Widget 位置">
                <div style={{ display:'flex', gap:8 }}>
                  <button className="ps-btn primary"
                    onClick={() => { u({ ccEditMode: !t.ccEditMode } as any); if (typeof onClose === 'function') onClose?.() }}>
                    {useStore.getState().ccEditMode ? '退出自定义' : '进入自定义'}
                  </button>
                  <span style={{ fontSize:12, color:'var(--text-dim)', alignSelf:'center' }}>
                    实时拖拽 widget 位置/大小
                  </span>
                </div>
              </Group>

              <Group title="布局">
                <Row label="高度"><Num value={t.ccHeight} onChange={v=>onSettingChange({ccHeight:v})} min={80} max={400}/><span className="set-val">px</span></Row>
                <Row label="背景色"><ColorPopover value={t.ccBg} onChange={v=>onSettingChange({ccBg:v})}/></Row>
              </Group>

              <h3>输入栏</h3>
              <Group title="外观">
                <Row label="背景色"><ColorPopover value={t.inputBg} onChange={v=>onSettingChange({inputBg:v})}/></Row>
                <BgImageRow label="背景图" value={t.inputBgImage||''} onChange={v=>onSettingChange({inputBgImage:v})}/>
                <Row label="文字颜色"><ColorPopover value={t.inputTextColor} onChange={v=>onSettingChange({inputTextColor:v})}/></Row>
                <Row label="占位符颜色"><ColorPopover value={t.inputPlaceholder} onChange={v=>onSettingChange({inputPlaceholder:v})}/></Row>
                <Row label="发送按钮色"><ColorPopover value={t.inputSendBg} onChange={v=>onSettingChange({inputSendBg:v})}/></Row>
                <Row label="聚焦边框"><ColorPopover value={t.inputFocusBorder} onChange={v=>onSettingChange({inputFocusBorder:v})}/></Row>
              </Group>
              <Group title="尺寸">
                <Row label="字号"><Num value={t.inputFontSize} onChange={v=>onSettingChange({inputFontSize:v})} min={12} max={22}/></Row>
                <Row label="最小高度"><Num value={t.inputMinHeight} onChange={v=>onSettingChange({inputMinHeight:v})} min={36} max={120}/></Row>
              </Group>
              <Group title="CLI 风格" defaultOpen={false}>
                <Row label="模式"><Sel value={t.inputMode} onChange={v=>onSettingChange({inputMode:v})} options={['default','cli']}/></Row>
                <Row label="横线宽度"><Num value={t.cliLineWidth} onChange={v=>onSettingChange({cliLineWidth:v})} min={1} max={6}/></Row>
                <Row label="横线颜色"><ColorPopover value={t.cliLineColor} onChange={v=>onSettingChange({cliLineColor:v})}/></Row>
                <Row label="文字颜色"><ColorPopover value={t.cliTextColor} onChange={v=>onSettingChange({cliTextColor:v})}/></Row>
              </Group>

              <h3>状态栏 & 心电图</h3>
              <Group title="外观">
                <Row label="背景色"><ColorPopover value={t.statusBg} onChange={v=>onSettingChange({statusBg:v})}/></Row>
                <BgImageRow label="背景图" value={t.statusBgImage||''} onChange={v=>onSettingChange({statusBgImage:v})}/>
                <Row label="心电图宽度"><Num value={t.ekgWidth} onChange={v=>onSettingChange({ekgWidth:v})} min={120} max={400}/></Row>
                <Row label="心电图字号"><Num value={t.ekgFontSize} onChange={v=>onSettingChange({ekgFontSize:v})} min={12} max={22}/></Row>
              </Group>
              <Group title="心电图颜色">
                <Row label="绿色"><ColorPopover value={t.ekgGreen} onChange={v=>onSettingChange({ekgGreen:v})}/></Row>
                <Row label="黄色"><ColorPopover value={t.ekgYellow} onChange={v=>onSettingChange({ekgYellow:v})}/></Row>
                <Row label="红色"><ColorPopover value={t.ekgRed} onChange={v=>onSettingChange({ekgRed:v})}/></Row>
              </Group>
              <Group title="胶囊" defaultOpen={false}>
                <Row label="背景"><ColorPopover value={t.pillBg} onChange={v=>onSettingChange({pillBg:v})}/></Row>
                <Row label="文字"><ColorPopover value={t.pillText} onChange={v=>onSettingChange({pillText:v})}/></Row>
              </Group>
              <Group title="其他" defaultOpen={false}>
                <Row label="Prism ON 色"><ColorPopover value={t.prismOnColor} onChange={v=>onSettingChange({prismOnColor:v})}/></Row>
              </Group>
              <Group title="心电图样式" defaultOpen={false}>
                <Row label="基线宽度"><Num value={t.ekgLineWidth} onChange={v=>onSettingChange({ekgLineWidth:v})} min={2} max={20}/></Row>
                <Row label="最大振幅"><Num value={t.ekgAmplitudeMax} onChange={v=>onSettingChange({ekgAmplitudeMax:v})} min={5} max={30}/></Row>
                <Row label="基础波速"><Num value={t.ekgSpeedBase} onChange={v=>onSettingChange({ekgSpeedBase:v})} min={0} max={3}/></Row>
                <Row label="最大波速"><Num value={t.ekgSpeedMax} onChange={v=>onSettingChange({ekgSpeedMax:v})} min={0} max={5}/></Row>
                <Row label="定端点颜色"><ColorPopover value={t.ekgLeftColor} onChange={v=>onSettingChange({ekgLeftColor:v})}/></Row>
                <Row label="动端点颜色"><ColorPopover value={t.ekgMovingColor} onChange={v=>onSettingChange({ekgMovingColor:v})}/></Row>
                <Row label="消耗区颜色"><ColorPopover value={t.ekgConsumedColor} onChange={v=>onSettingChange({ekgConsumedColor:v})}/></Row>
              </Group>
              <Group title="上下文显示" defaultOpen={false}>
                <Row label="仪表样式"><Sel value={t.ccStyle} onChange={v=>onSettingChange({ccStyle:v})} options={['wave','bar','numeric']}/></Row>
                <Row label="显示模式"><Sel value={t.tokenDisplay} onChange={v=>onSettingChange({tokenDisplay:v})} options={['ekg','numeric']}/></Row>
              </Group>
            </Tabs.Content>

            {/* ═══ 右栏 ═══ */}
            <Tabs.Content value="right">
              <h3>右侧栏</h3>
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
                  {useStore.getState().activeAgent || 'peri'}
                </div>
              </Group>
              <Group title="切换 Agent（需重启）">
                {useStore.getState().agents.map((a: any) => (
                  <Row key={a.id} label={a.name}>
                    <button className={`ps-btn sm ${a.id === useStore.getState().activeAgent ? 'primary' : ''}`}
                      onClick={() => {
                        invoke('switch_agent', { name: a.id }).then(() => {
                          useStore.getState().setActiveAgent(a.id)
                        }).catch(() => {})
                      }}>
                      {a.id === useStore.getState().activeAgent ? '当前' : '切换'}
                    </button>
                  </Row>
                ))}
              </Group>
              <div style={{ marginTop:16, fontSize:12, color:'var(--text-dim)' }}>
                切换 Agent 后需重启 Prism Desktop 生效。
              </div>
            </Tabs.Content>

            {/* ═══ 会话 ═══ */}
            <Tabs.Content value="session">
              <h3>当前会话设置</h3>
              <Group title="会话 Prompt（覆盖 Profile persona）">
                <Row label="Prompt"><textarea className="set-textarea"
                  defaultValue={useStore.getState().sessions[0]?.sessionPrompt || ''}
                  placeholder="留空则使用 Profile persona..." /></Row>
              </Group>
            </Tabs.Content>
          </Tabs.Root>

          <div className="set-presets">
            <button className="set-preset-btn" onClick={() => u({...defaults})}>Default</button>
            <span style={{color:'var(--text-dim)',fontSize:12,alignSelf:'center'}}>Export / Import coming soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const defaults: Partial<ThemeSettings> = {
  transparency:0.85, bgBlur:16, globalFont:'system', globalFontSize:18,
  sidebarBg:'rgba(0,0,0,0.02)', sidebarWidth:250, sidebarTextColor:'rgba(0,0,0,0.85)', sidebarNameSize:14, sidebarGroupSize:12,
  chatBg:'transparent', chatFont:'mono', chatFontSize:15, chatLineHeight:1.8,
  chatTextColor:'rgba(0,0,0,0.85)', chatCodeColor:'#b47814', chatCodeBg:'rgba(0,0,0,0.03)',
  toolOk:'#1e9646', toolRun:'#3b82f6', toolErr:'#be2828', toolNameColor:'var(--text)', toolSummaryColor:'rgba(0,0,0,0.4)',
  userTagBg:'rgba(0,0,0,0.03)', userTagText:'rgba(0,0,0,0.65)',
  inputBg:'rgba(0,0,0,0.03)', inputTextColor:'rgba(0,0,0,0.85)', inputPlaceholder:'rgba(0,0,0,0.28)',
  inputSendBg:'rgba(0,0,0,0.10)', inputFocusBorder:'rgba(0,0,0,0.22)', inputFontSize:17, inputMinHeight:56,
  statusBg:'rgba(0,0,0,0.02)', ekgWidth:240, ekgFontSize:16, ekgGreen:'#1e9646', ekgYellow:'#b47814', ekgRed:'#be2828',
  pillBg:'rgba(0,0,0,0.03)', pillText:'rgba(0,0,0,0.4)', prismOnColor:'#1e9646',
  rightBg:'rgba(0,0,0,0.02)', rightWidth:260,
}
