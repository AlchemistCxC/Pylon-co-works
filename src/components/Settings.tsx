import { useState, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import type { ThemeSettings } from '../store'
import './Settings.css'

type Section = 'global'|'sidebar'|'chat'|'tools'|'input'|'status'|'right'|'agent'

const NAV: { key: Section; label: string }[] = [
  { key:'global', label:'全局' },
  { key:'sidebar', label:'左栏' },
  { key:'chat', label:'终端' },
  { key:'tools', label:'工具颜色' },
  { key:'input', label:'输入栏' },
  { key:'status', label:'状态栏' },
  { key:'right', label:'右栏' },
  { key:'agent', label:'Agent' },
]

// ── helpers ──

function Swatch({ value, onChange }: { value:string; onChange:(v:string)=>void }) {
  const ref = useRef<HTMLInputElement>(null)
  return <>
    <div className="set-swatch" style={{background:value}} onClick={() => ref.current?.click()}/>
    <input ref={ref} type="color" value={value} onChange={e => onChange(e.target.value)} className="set-swatch-input"/>
  </>
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

function PresetBtns({ value, onChange, options }: { value:number; onChange:(v:number)=>void; options:number[] }) {
  return <div className="set-preset-row">
    {options.map(o => (
      <button key={o} className={`set-preset-chip ${value === o ? 'active' : ''}`}
        onClick={() => onChange(o)}>{Math.round(o*100)}%</button>
    ))}
  </div>
}

function Group({ title, children }: { title:string; children:React.ReactNode }) {
  return <div className="set-group">
    <div className="set-group-title">{title}</div>
    {children}
  </div>
}

// ── main ──

export default function Settings() {
  const t = useStore() as ThemeSettings
  const u = useStore(s => s.updateTheme)
  const reset = useStore(s => s.resetTheme)
  const [sec, setSec] = useState<Section>('global')

  return (
    <div className="settings">
      <nav className="settings-nav">
        <input className="set-search" placeholder="Search..."/>
        {NAV.map(n => (
          <button key={n.key} className={`set-nav-btn ${sec===n.key?'active':''}`}
            onClick={() => setSec(n.key)}>{n.label}</button>
        ))}
        <hr className="set-nav-hr"/>
        <button className="set-nav-btn" onClick={reset}>Reset</button>
      </nav>

      <div className="settings-body">
        {sec === 'global' && <>
          <h3>全局外观</h3>
          <Group title="玻璃效果">
            <Row label="背景图"><Txt value={t.globalBgImage||''} onChange={v=>u({globalBgImage:v})}/></Row>
            <Row label="透明度"><Slider value={t.transparency} onChange={v=>u({transparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.transparency*100)}%</span></Row>
            <Row label="模糊"><Slider value={t.bgBlur} onChange={v=>u({bgBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.bgBlur}px</span></Row>
          </Group>
          <Group title="字体">
            <Row label="字体"><Sel value={t.globalFont} onChange={v=>u({globalFont:v})} options={['system','mono']}/></Row>
            <Row label="基础字号"><Num value={t.globalFontSize} onChange={v=>u({globalFontSize:v})} min={12} max={24}/></Row>
          </Group>
        </>}

        {sec === 'sidebar' && <>
          <h3>左侧栏</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.sidebarBg} onChange={v=>u({sidebarBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.sidebarBgImage} onChange={v=>u({sidebarBgImage:v})}/></Row>
            <Row label="栏宽"><Num value={t.sidebarWidth} onChange={v=>u({sidebarWidth:v})} min={160} max={400}/></Row>
          </Group>
          <Group title="文字">
            <Row label="文字颜色"><Swatch value={t.sidebarTextColor} onChange={v=>u({sidebarTextColor:v})}/></Row>
            <Row label="会话名字号"><Num value={t.sidebarNameSize} onChange={v=>u({sidebarNameSize:v})} min={11} max={20}/></Row>
            <Row label="分组标题字号"><Num value={t.sidebarGroupSize} onChange={v=>u({sidebarGroupSize:v})} min={10} max={16}/></Row>
          </Group>
        </>}

        {sec === 'chat' && <>
          <h3>终端（聊天区）</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.chatBg} onChange={v=>u({chatBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.chatBgImage} onChange={v=>u({chatBgImage:v})}/></Row>
          </Group>
          <Group title="字体">
            <Row label="字体"><Sel value={t.chatFont} onChange={v=>u({chatFont:v})} options={['mono','system']}/></Row>
            <Row label="字号"><Num value={t.chatFontSize} onChange={v=>u({chatFontSize:v})} min={12} max={22}/></Row>
            <Row label="行高"><Num value={t.chatLineHeight} onChange={v=>u({chatLineHeight:v})} min={1.2} max={2.5}/></Row>
          </Group>
          <Group title="颜色">
            <Row label="文字颜色"><Swatch value={t.chatTextColor} onChange={v=>u({chatTextColor:v})}/></Row>
            <Row label="内联代码"><Swatch value={t.chatCodeColor} onChange={v=>u({chatCodeColor:v})}/></Row>
            <Row label="代码块背景"><Swatch value={t.chatCodeBg} onChange={v=>u({chatCodeBg:v})}/></Row>
          </Group>
        </>}

        {sec === 'tools' && <>
          <h3>工具调用 & 用户标签</h3>
          <Group title="工具指示器">
            <Row label="完成 ●"><Swatch value={t.toolOk} onChange={v=>u({toolOk:v})}/></Row>
            <Row label="运行中 ●"><Swatch value={t.toolRun} onChange={v=>u({toolRun:v})}/></Row>
            <Row label="错误 ●"><Swatch value={t.toolErr} onChange={v=>u({toolErr:v})}/></Row>
          </Group>
          <Group title="工具文字">
            <Row label="工具名颜色"><Swatch value={t.toolNameColor} onChange={v=>u({toolNameColor:v})}/></Row>
            <Row label="摘要颜色"><Swatch value={t.toolSummaryColor} onChange={v=>u({toolSummaryColor:v})}/></Row>
          </Group>
          <Group title="用户标签">
            <Row label="标签背景"><Swatch value={t.userTagBg} onChange={v=>u({userTagBg:v})}/></Row>
            <Row label="标签文字"><Swatch value={t.userTagText} onChange={v=>u({userTagText:v})}/></Row>
          </Group>
        </>}

        {sec === 'input' && <>
          <h3>输入栏</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.inputBg} onChange={v=>u({inputBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.inputBgImage||''} onChange={v=>u({inputBgImage:v})}/></Row>
            <Row label="文字颜色"><Swatch value={t.inputTextColor} onChange={v=>u({inputTextColor:v})}/></Row>
            <Row label="占位符颜色"><Swatch value={t.inputPlaceholder} onChange={v=>u({inputPlaceholder:v})}/></Row>
            <Row label="发送按钮色"><Swatch value={t.inputSendBg} onChange={v=>u({inputSendBg:v})}/></Row>
            <Row label="聚焦边框"><Swatch value={t.inputFocusBorder} onChange={v=>u({inputFocusBorder:v})}/></Row>
          </Group>
          <Group title="尺寸">
            <Row label="字号"><Num value={t.inputFontSize} onChange={v=>u({inputFontSize:v})} min={12} max={22}/></Row>
            <Row label="最小高度"><Num value={t.inputMinHeight} onChange={v=>u({inputMinHeight:v})} min={36} max={120}/></Row>
          </Group>
          <Group title="CLI 风格">
            <Row label="模式"><Sel value={t.inputMode} onChange={v=>u({inputMode:v})} options={['default','cli']}/></Row>
            <Row label="横线宽度"><Num value={t.cliLineWidth} onChange={v=>u({cliLineWidth:v})} min={1} max={6}/></Row>
            <Row label="横线颜色"><Swatch value={t.cliLineColor} onChange={v=>u({cliLineColor:v})}/></Row>
            <Row label="文字颜色"><Swatch value={t.cliTextColor} onChange={v=>u({cliTextColor:v})}/></Row>
          </Group>
        </>}

        {sec === 'status' && <>
          <h3>状态栏 & 心电图</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.statusBg} onChange={v=>u({statusBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.statusBgImage||''} onChange={v=>u({statusBgImage:v})}/></Row>
            <Row label="心电图宽度"><Num value={t.ekgWidth} onChange={v=>u({ekgWidth:v})} min={120} max={400}/></Row>
            <Row label="心电图字号"><Num value={t.ekgFontSize} onChange={v=>u({ekgFontSize:v})} min={12} max={22}/></Row>
          </Group>
          <Group title="心电图颜色">
            <Row label="绿色"><Swatch value={t.ekgGreen} onChange={v=>u({ekgGreen:v})}/></Row>
            <Row label="黄色"><Swatch value={t.ekgYellow} onChange={v=>u({ekgYellow:v})}/></Row>
            <Row label="红色"><Swatch value={t.ekgRed} onChange={v=>u({ekgRed:v})}/></Row>
          </Group>
          <Group title="胶囊">
            <Row label="背景"><Swatch value={t.pillBg} onChange={v=>u({pillBg:v})}/></Row>
            <Row label="文字"><Swatch value={t.pillText} onChange={v=>u({pillText:v})}/></Row>
          </Group>
          <Group title="其他">
            <Row label="Prism ON 色"><Swatch value={t.prismOnColor} onChange={v=>u({prismOnColor:v})}/></Row>
          </Group>
          <Group title="心电图样式">
            <Row label="基线宽度"><Num value={t.ekgLineWidth} onChange={v=>u({ekgLineWidth:v})} min={2} max={20}/></Row>
            <Row label="最大振幅"><Num value={t.ekgAmplitudeMax} onChange={v=>u({ekgAmplitudeMax:v})} min={5} max={30}/></Row>
            <Row label="基础波速"><Num value={t.ekgSpeedBase} onChange={v=>u({ekgSpeedBase:v})} min={0} max={3}/></Row>
            <Row label="最大波速"><Num value={t.ekgSpeedMax} onChange={v=>u({ekgSpeedMax:v})} min={0} max={5}/></Row>
            <Row label="定端点颜色"><Swatch value={t.ekgLeftColor} onChange={v=>u({ekgLeftColor:v})}/></Row>
            <Row label="动端点颜色"><Swatch value={t.ekgMovingColor} onChange={v=>u({ekgMovingColor:v})}/></Row>
            <Row label="消耗区颜色"><Swatch value={t.ekgConsumedColor} onChange={v=>u({ekgConsumedColor:v})}/></Row>
          </Group>
          <Group title="上下文显示">
            <Row label="显示模式"><Sel value={t.tokenDisplay} onChange={v=>u({tokenDisplay:v})} options={['ekg','numeric']}/></Row>
          </Group>
        </>}

        {sec === 'right' && <>
          <h3>右侧栏</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.rightBg} onChange={v=>u({rightBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.rightBgImage||''} onChange={v=>u({rightBgImage:v})}/></Row>
            <Row label="宽度"><Num value={t.rightWidth} onChange={v=>u({rightWidth:v})} min={200} max={400}/></Row>
          </Group>
        </>}

        {sec === 'agent' && <>
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
        </>}

        <div className="set-presets">
          <button className="set-preset-btn" onClick={() => u({...defaults})}>Default</button>
          <span style={{color:'var(--text-dim)',fontSize:12,alignSelf:'center'}}>Export / Import coming soon</span>
        </div>
      </div>
    </div>
  )
}

const defaults: Partial<ThemeSettings> = {
  transparency:0.55, bgBlur:16, globalFont:'system', globalFontSize:18,
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
