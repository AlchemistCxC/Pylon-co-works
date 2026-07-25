import { useRef } from 'react'
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

function Group({ title, children }: { title:string; children:React.ReactNode }) {
  return <div className="set-group">
    <div className="set-group-title">{title}</div>
    {children}
  </div>
}

// ── CC widget drag-to-reorder ──

const WIDGET_LABELS: Record<string, string> = {
  input: '输入栏', context: '上下文仪表', model: '模型选择', mode: '模式切换',
}

function SortableWidget({ id }: { id: string }) {
  const u = useStore(s => s.updateTheme)
  const hidden = (useStore(s => s.ccHidden) || []).includes(id)
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  return (
    <div ref={setNodeRef} style={style} className="set-row">
      <span {...attributes} {...listeners} className="cc-drag-handle" style={{ cursor:'grab', color:'var(--text-dim)', fontSize:14, userSelect:'none' }}>☰</span>
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

// ── main ──

export default function Settings({ onClose }: { onClose?: () => void }) {
  const t = useStore() as ThemeSettings
  const u = useStore(s => s.updateTheme)
  const reset = useStore(s => s.resetTheme)

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

  return (
    <div className="settings">
      {onClose && <button className="settings-close" onClick={onClose}>✕</button>}
      <Tabs.Root defaultValue="global" orientation="vertical" className="settings-tabs-root">
        <Tabs.List className="settings-nav">
          <Tabs.Trigger value="global" className="set-nav-btn">全局</Tabs.Trigger>
          <Tabs.Trigger value="sidebar" className="set-nav-btn">左栏</Tabs.Trigger>
          <Tabs.Trigger value="terminal" className="set-nav-btn">终端</Tabs.Trigger>
          <Tabs.Trigger value="cc" className="set-nav-btn">中控区</Tabs.Trigger>
          <Tabs.Trigger value="right" className="set-nav-btn">右栏</Tabs.Trigger>
          <Tabs.Trigger value="agent" className="set-nav-btn">Agent</Tabs.Trigger>
          <Tabs.Trigger value="session" className="set-nav-btn">会话</Tabs.Trigger>
          <hr className="set-nav-hr"/>
          <button className="set-nav-btn" onClick={reset}>Reset</button>
        </Tabs.List>

      <div className="settings-body">

        {/* ═══ 全局 ═══ */}
        <Tabs.Content value="global">
          <PresetRow area="app" />
          <h3>全局外观</h3>
          <Group title="用户信息">
            <Row label="显示名"><Txt value={t.userName} onChange={v=>u({userName:v})}/></Row>
            <Row label="前缀"><Txt value={t.userPrefix} onChange={v=>u({userPrefix:v})}/></Row>
            <Row label="名字颜色"><Swatch value={t.userColor} onChange={v=>u({userColor:v})}/></Row>
          </Group>
          <Group title="玻璃效果">
            <Row label="背景图"><Txt value={t.globalBgImage||''} onChange={v=>u({globalBgImage:v})}/></Row>
            <Row label="透明度"><Slider value={t.transparency} onChange={v=>u({transparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.transparency*100)}%</span></Row>
            <Row label="模糊"><Slider value={t.bgBlur} onChange={v=>u({bgBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.bgBlur}px</span></Row>
          </Group>
          <Group title="字体">
            <Row label="字体"><Sel value={t.globalFont} onChange={v=>u({globalFont:v})} options={['system','mono']}/></Row>
            <Row label="基础字号"><Num value={t.globalFontSize} onChange={v=>u({globalFontSize:v})} min={12} max={24}/></Row>
          </Group>
        </Tabs.Content>

        {/* ═══ 左栏 ═══ */}
        <Tabs.Content value="sidebar">
          <h3>左侧栏</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.sidebarBg} onChange={v=>u({sidebarBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.sidebarBgImage} onChange={v=>u({sidebarBgImage:v})}/></Row>
            <Row label="栏宽"><Num value={t.sidebarWidth} onChange={v=>u({sidebarWidth:v})} min={160} max={400}/></Row>
          </Group>
          <Group title="玻璃效果">
            <Row label="透明度"><Slider value={t.sidebarTransparency} onChange={v=>u({sidebarTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.sidebarTransparency*100)}%</span></Row>
            <Row label="模糊"><Slider value={t.sidebarBlur} onChange={v=>u({sidebarBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.sidebarBlur}px</span></Row>
          </Group>
          <Group title="文字">
            <Row label="文字颜色"><Swatch value={t.sidebarTextColor} onChange={v=>u({sidebarTextColor:v})}/></Row>
            <Row label="会话名字号"><Num value={t.sidebarNameSize} onChange={v=>u({sidebarNameSize:v})} min={11} max={20}/></Row>
            <Row label="分组标题字号"><Num value={t.sidebarGroupSize} onChange={v=>u({sidebarGroupSize:v})} min={10} max={16}/></Row>
          </Group>
        </Tabs.Content>

        {/* ═══ 终端（合并 chat + tools + message bar） ═══ */}
        <Tabs.Content value="terminal">
          <PresetRow area="terminal" />
          <h3>聊天区</h3>
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
          <Group title="玻璃效果">
            <Row label="透明度"><Slider value={t.chatTransparency} onChange={v=>u({chatTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.chatTransparency*100)}%</span></Row>
            <Row label="模糊"><Slider value={t.chatBlur} onChange={v=>u({chatBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.chatBlur}px</span></Row>
          </Group>

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
          <Group title="指示器形状">
            <Row label="形状"><Sel value={t.toolIndicator} onChange={v=>u({toolIndicator:v})} options={['●','◆','■','▲','▶']}/></Row>
            <Row label="Spinner 字符集"><Sel value={t.sparkles} onChange={v=>u({sparkles:v})} options={[
              '✳✴✵✶✷✸✹✺✻✼❃❊','◴◷◶◵','·○◎●◉◎○','←↖↑↗→↘↓↙','▖▗▘▝▗▖▝▘','▁▂▃▄▅▆▇█▇▆▅▄▃','┌┐┘└','⠁⠂⠄⡀⢀⠠⠐⠈'
            ]}/></Row>
            <Row label="Spinner 颜色"><Swatch value={t.spinnerColor} onChange={v=>u({spinnerColor:v})}/></Row>
            <Row label="Spinner 大小"><Num value={t.spinnerSize} onChange={v=>u({spinnerSize:v})} min={10} max={32}/></Row>
          </Group>

          <h3>消息栏</h3>
          <Group title="风格">
            <Row label="风格"><Sel value={t.msgStyle} onChange={v=>u({msgStyle:v})} options={['terminal','bubble']}/></Row>
            <Row label="字体"><Sel value={t.msgFont} onChange={v=>u({msgFont:v})} options={['mono','system']}/></Row>
            <Row label="文字颜色"><Swatch value={t.msgTextColor} onChange={v=>u({msgTextColor:v})}/></Row>
            <Row label="行间距"><Num value={t.msgLineHeight} onChange={v=>u({msgLineHeight:v})} min={1.2} max={2.5}/></Row>
          </Group>
        </Tabs.Content>

        {/* ═══ 中控区（合并 input + status bar + ECG） ═══ */}
        <Tabs.Content value="cc">
          <PresetRow area="cc" />

          <h3>控件排序</h3>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={t.ccLayout || ['input', 'context', 'model', 'mode']} strategy={verticalListSortingStrategy}>
              {(t.ccLayout || ['input', 'context', 'model', 'mode']).map(id => (
                <SortableWidget key={id} id={id} />
              ))}
            </SortableContext>
          </DndContext>

          <Group title="布局">
            <Row label="高度">
              <Num value={t.ccHeight} onChange={v=>u({ccHeight:v})} min={80} max={400}/>
              <span className="set-val">px</span>
            </Row>
            <Row label="背景色">
              <Swatch value={t.ccBg} onChange={v=>u({ccBg:v})}/>
            </Row>
          </Group>

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
            <Row label="仪表样式"><Sel value={t.ccStyle} onChange={v=>u({ccStyle:v})} options={['wave','bar','numeric']}/></Row>
            <Row label="显示模式"><Sel value={t.tokenDisplay} onChange={v=>u({tokenDisplay:v})} options={['ekg','numeric']}/></Row>
          </Group>
        </Tabs.Content>

        {/* ═══ 右栏 ═══ */}
        <Tabs.Content value="right">
          <h3>右侧栏</h3>
          <Group title="外观">
            <Row label="背景色"><Swatch value={t.rightBg} onChange={v=>u({rightBg:v})}/></Row>
            <Row label="背景图"><Txt value={t.rightBgImage||''} onChange={v=>u({rightBgImage:v})}/></Row>
            <Row label="宽度"><Num value={t.rightWidth} onChange={v=>u({rightWidth:v})} min={200} max={400}/></Row>
          </Group>
          <Group title="玻璃效果">
            <Row label="透明度"><Slider value={t.rightTransparency} onChange={v=>u({rightTransparency:v})} min={0} max={1}/><span className="set-val">{Math.round(t.rightTransparency*100)}%</span></Row>
            <Row label="模糊"><Slider value={t.rightBlur} onChange={v=>u({rightBlur:v})} min={0} max={40} step={2}/><span className="set-val">{t.rightBlur}px</span></Row>
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

        <div className="set-presets">
          <button className="set-preset-btn" onClick={() => u({...defaults})}>Default</button>
          <span style={{color:'var(--text-dim)',fontSize:12,alignSelf:'center'}}>Export / Import coming soon</span>
        </div>
      </div>
      </Tabs.Root>
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
