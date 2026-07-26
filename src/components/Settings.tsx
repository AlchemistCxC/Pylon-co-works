import { useRef, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import type { ThemeSettings } from '../store'
import { GLOBAL_PRESETS, ZONE_FIELDS, pickZoneFields } from '../presets'
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

function ColorPopover({ value, onChange, chips }: { value:string; onChange:(v:string)=>void; chips?:boolean }) {
  const [open, setOpen] = useState(false)
  const pickerRef = useRef<HTMLInputElement>(null)
  if (chips === false) return <Swatch value={value} onChange={onChange} />
  return (
    <div className="set-color-wrap">
      <div className="set-swatch" style={{background:value}} onClick={() => setOpen(!open)}/>
      {open && <>
        <div className="set-color-popover">
          <div className="set-color-row">
            {COLOR_CHIPS.map(c => (
              <div key={c} className={`set-color-chip ${value === c ? 'active' : ''}`}
                style={{background:c}} onClick={() => { onChange(c); setOpen(false) }} />
            ))}
          </div>
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
        <input type="text" value={value} onChange={e => onChange(e.target.value)} className="set-input" style={{width:'220px'}} placeholder="路径或 URL" />
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

// ── helpers (ZONE_FIELDS / pickZoneFields live in presets.ts) ──

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
  const setGlobalPreset = useStore(s => s.setGlobalPreset)
  const setZoneField = useStore(s => s.setZoneField)
  const applyZonePreset = useStore(s => s.applyZonePreset)
  const activePreset = useStore(s => s.activePreset)
  const dirty = useStore(s => s.dirty)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState('global')

  // 应用全局预设
  const applyGlobalPreset = (name: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === name)
    if (!preset) return
    setGlobalPreset(name, preset.theme as any)
  }

  // 改单个字段 — 标记当前 tab 对应的 zone 为 dirty
  const tabZoneMap: Record<string, string> = {
    global: 'global', sidebar: 'sidebar', terminal: 'chat',
    cc: 'cc', right: 'right',
  }
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = tabZoneMap[activeTab] || 'global'
    setZoneField(zone, partial)
  }

  // 局部预设（zone 级别）
  const applyLocalPreset = (zone: string, presetName: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === presetName)
    if (!preset) return
    const sub = pickZoneFields(preset.theme as any, zone)
    applyZonePreset(zone, presetName, sub)
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
                    <button key={p.name} className={`set-preset-chip ${activePreset.global === p.name ? 'active' : ''}`}
                      onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
                  ))}
                  {activePreset.global && !GLOBAL_PRESETS.some(p => p.name === activePreset.global) && (
                    <button className="set-preset-chip active">{activePreset.global}</button>
                  )}
                </div>
                <div style={{fontSize:11,color:'var(--text-dim)',marginTop:4}}>
                  {dirty.global
                    ? '当前为自定义 — 切换预设可恢复'
                    : '选择预设后修改任意外观参数，自动切换为自定义'}
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
                    <button key={p.name} className={`set-preset-chip ${activePreset.sidebar === p.name && !dirty.sidebar ? 'active' : ''}`}
                      onClick={() => applyLocalPreset('sidebar', p.name)}>{p.label}</button>
                  ))}
                  {dirty.sidebar && <span className="set-preset-chip active">自定义</span>}
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
                    <button key={p.name} className={`set-preset-chip ${activePreset.chat === p.name && !dirty.chat ? 'active' : ''}`}
                      onClick={() => applyLocalPreset('chat', p.name)}>{p.label}</button>
                  ))}
                  {dirty.chat && <span className="set-preset-chip active">自定义</span>}
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
              <Group title="指示器 & Spinner">
                <Row label="形状"><Sel value={t.toolIndicator} onChange={v=>onSettingChange({toolIndicator:v})} options={['●','◆','■','▲','▶']}/></Row>
                <Row label="字符集"><Sel value={t.sparkles} onChange={v=>onSettingChange({sparkles:v})} options={[
                  '✳✴✵✶✷✸✹✺✻✼❃❊','◴◷◶◵','·○◎●◉◎○','←↖↑↗→↘↓↙','▖▗▘▝▗▖▝▘','▁▂▃▄▅▆▇█▇▆▅▄▃','┌┐┘└','⠁⠂⠄⡀⢀⠠⠐⠈'
                ]}/></Row>
                <div className="set-compact-row">
                  <span className="set-compact-label">颜色</span>
                  <ColorPopover value={t.spinnerColor} onChange={v=>onSettingChange({spinnerColor:v})} chips={false}/>
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
                  <ColorPopover value={t.msgTextColor} onChange={v=>onSettingChange({msgTextColor:v})} chips={false}/>
                  <span className="set-compact-label">行间距</span>
                  <Num value={t.msgLineHeight} onChange={v=>onSettingChange({msgLineHeight:v})} min={1.2} max={2.5}/>
                </div>
              </Group>
            </Tabs.Content>

            {/* ═══ 中控区 ═══ */}
            <Tabs.Content value="cc">
              <Group title="局部预设">
                <div className="set-preset-row">
                  {GLOBAL_PRESETS.map(p => (
                    <button key={p.name} className={`set-preset-chip ${activePreset.cc === p.name && !dirty.cc ? 'active' : ''}`}
                      onClick={() => applyLocalPreset('cc', p.name)}>{p.label}</button>
                  ))}
                  {dirty.cc && <span className="set-preset-chip active">自定义</span>}
                </div>
              </Group>

              <Group title="1:1 自定义">
                <Row label="外观风格">
                  <div className="set-preset-row">
                    {(['terminal','glass','pill'] as const).map(v => (
                      <button key={v} className={`set-preset-chip ${t.ccVariant===v?'active':''}`}
                        onClick={()=>onSettingChange({ccVariant:v})}>{v==='terminal'?'终端':v==='glass'?'玻璃':'胶囊'}</button>
                    ))}
                  </div>
                </Row>
                <Row label="高度"><Num value={t.ccHeight} onChange={v=>onSettingChange({ccHeight:v})} min={80} max={400}/><span className="set-val">px</span></Row>
                <Row label="背景色"><ColorPopover value={t.ccBg} onChange={v=>onSettingChange({ccBg:v})}/></Row>
                <BgImageRow label="背景图" value={t.ccBgImage||''} onChange={v=>onSettingChange({ccBgImage:v})}/>
                <div style={{marginTop:8}}>
                  <button className="ps-btn primary"
                    onClick={() => {
                      const cur = useStore.getState().ccEditMode
                      u({ ccEditMode: !cur } as any)
                      if (typeof onClose === 'function') onClose?.()
                    }}>
                    {t.ccEditMode ? '退出自定义编辑器' : '进入自定义编辑器'}
                  </button>
                  <span style={{fontSize:12,color:'var(--text-dim)',marginLeft:8}}>
                    位置/大小/类型/颜色/显隐 全部在编辑器中调整
                  </span>
                </div>
              </Group>
            </Tabs.Content>

            {/* ═══ 右栏 ═══ */}
            <Tabs.Content value="right">
              <h3>右侧栏</h3>
              <Group title="局部预设">
                <div className="set-preset-row">
                  {GLOBAL_PRESETS.map(p => (
                    <button key={p.name} className={`set-preset-chip ${activePreset.right === p.name && !dirty.right ? 'active' : ''}`}
                      onClick={() => applyLocalPreset('right', p.name)}>{p.label}</button>
                  ))}
                  {dirty.right && <span className="set-preset-chip active">自定义</span>}
                </div>
              </Group>
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
            <button className="set-preset-btn" onClick={reset}>Reset</button>
            <span style={{color:'var(--text-dim)',fontSize:12,alignSelf:'center'}}>Export / Import coming soon</span>
          </div>
        </div>
      </div>
    </div>
  )
}
