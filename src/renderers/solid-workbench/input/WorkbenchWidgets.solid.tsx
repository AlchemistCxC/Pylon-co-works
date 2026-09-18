import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import {
  isReasoningOption,
  resolveModeOptionEntries,
  resolveModelOptionEntries,
  resolveReasoningOptionEntries,
  resolveDocumentOptionValue,
  shortControlCenterError,
} from './workbenchOptionCatalog.ts'

function nextValue(values: readonly string[], current: string): string {
  if (values.length === 0) return current
  const index = values.indexOf(current)
  return values[(index + 1 + values.length) % values.length] ?? values[0] ?? current
}

export function SolidModelWidget(props: { draftValue?: () => string; onDraftChange?: (value: string) => void; forceDropdown?: boolean } = {}) {
  const workbench = useSolidWorkbench(); const runtime = () => workbench.runtimeSnapshot(); const appearance = () => workbench.appearanceSnapshot()
  const [open,setOpen]=createSignal(false); const [error,setError]=createSignal(''); const [pending,setPending]=createSignal(false)
  let root: HTMLDivElement|undefined; let trigger: HTMLButtonElement|undefined; const menuId=`cc-model-menu-${createUniqueId()}`
  // 会话切换时关闭菜单（2026-09-14）：控件常态显示后，若残留 open 状态会带着
  // 上一次会话的菜单进入新会话。与 SolidModeWidget 的会话切换处理保持一致。
  let previousSessionId = workbench.input().sessionId
  const entries=()=>resolveModelOptionEntries(runtime(),props.draftValue?.(),props.draftValue?workbench.input().agentAdvertisedModels:undefined); const models=()=>entries().map(x=>x.id)
  const model=()=>props.draftValue?.()||runtime().activeModel||entries()[0]?.id||'unconfigured-model'; const mode=()=>props.forceDropdown?'menu':(appearance().modelSwitchMode??'menu')
  // 可选项（排除当前值）。为空时菜单只能是一片空白 —— 那是"点了没反应"的观感，
  // 所以下面渲染一条不可点的占位，而不是留个空盒子。
  const selectable=()=>entries().filter(x=>x.id!==model())
  // #51：「不可切换」≠「切换失败」——无草稿绑定的真实会话里，候选为空意味着
  // 该 agent 没有宣告任何模型面（restart 后未恢复/agent 不支持），控件置禁用并
  // 说明原因，而不是让用户反复点出一串长报错。草稿态（空态选型）不受限。
  const unsurfaced=()=>!props.onDraftChange&&entries().length===0
  const width=()=>appearance().modelWidth??120, height=()=>appearance().modelHeight??28, radius=()=>appearance().modelRadius??0, fontSize=()=>appearance().modelFontSize??12
  const bg=()=>appearance().modelBgColor==='black'?'#000':'#fff', fg=()=>appearance().modelTextColor==='white'?'#fff':'#000'; const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const choose=async(target:string)=>{ if(pending()) return; if(props.onDraftChange){props.onDraftChange(target);close(true);return}; const sid=workbench.input().sessionId;if(!sid||target===model()){close(true);return}; setPending(true);setError(''); try {const r=await workbench.commands.setModel(sid,target);if(!r.ok)setError(shortControlCenterError(r.error,'模型切换失败'))} finally {setPending(false);close(true)} }
  createEffect(()=>{const currentSessionId=workbench.input().sessionId;if(currentSessionId!==previousSessionId)close();previousSessionId=currentSessionId})
  onMount(()=>{const pd=(e:PointerEvent)=>{if(open()&&!root?.contains(e.target as Node))close()};document.addEventListener('pointerdown',pd);onCleanup(()=>document.removeEventListener('pointerdown',pd))})
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,background:bg(),color:fg()})
  return <div ref={el=>root=el} class="solid-model-widget"><Show when={error()}>{m=><span class="cc-widget-error" role="alert" aria-live="assertive" title={m()}>{m()}</span>}</Show><div class="cc-model-root"><button ref={el=>trigger=el} type="button" class="cc-model-trigger" style={triggerStyle()} disabled={unsurfaced()} title={unsurfaced()?'该 agent 未宣告可切换模型':undefined} aria-haspopup={mode()==='menu'?'listbox':undefined} aria-expanded={mode()==='menu'?open():undefined} aria-controls={mode()==='menu'?menuId:undefined} onClick={()=>mode()==='menu'?setOpen(v=>!v):void choose(nextValue(models(),model()))}>{pending()?'......':model()}</button><Show when={mode()==='menu'&&open()}><div id={menuId} class="cc-model-menu" style={{width:`${width()}px`}} role="listbox" aria-label="模型列表" data-popover="control-center" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close(true)}}}><Show when={selectable().length>0} fallback={<div class="cc-model-empty" role="presentation">当前 Agent 未上报可选模型</div>}><For each={selectable()}>{item=><button type="button" role="option" aria-selected={false} class="cc-model-item" onClick={()=>void choose(item.id)}>{item.label||item.id}</button>}</For></Show></div></Show></div></div>
}

/** 权限模式控件：本体只显示后端机器值（不翻译），外观与交互跟模型／思考强度控件同一套语言。
 *  颜色：permissionTextColor='mode' 时不写 inline color，交给 CSS 的 [data-mode] 语义色
 *  （auto 黄 / bypass 红 / edit 紫 / default 灰）—— 危险模式一眼可见。 */
const PERMISSION_GAP_PX = 12
export function SolidModeWidget(props: {
  draftValue?: () => string
  onDraftChange?: (value: string) => void
  forceDropdown?: boolean
} = {}) {
  const workbench = useSolidWorkbench(); const runtime = () => workbench.runtimeSnapshot(); const appearance = () => workbench.appearanceSnapshot()
  const [open,setOpen]=createSignal(false); const [error,setError]=createSignal(''); const [pending,setPending]=createSignal(false)
  let root: HTMLDivElement|undefined; let trigger: HTMLButtonElement|undefined; let previousSessionId = workbench.input().sessionId
  const menuId=`cc-mode-menu-${createUniqueId()}`
  const entries=()=>resolveModeOptionEntries(runtime(), props.draftValue?.())
  const mode=()=>props.draftValue?.()||runtime().activeMode||entries()[0]?.id||'default'
  const switchMode=()=>props.forceDropdown?'menu':(appearance().permissionSwitchMode??'menu')
  const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const choose=async(target:string)=>{ if(pending()) return; if(props.onDraftChange){props.onDraftChange(target);close(true);return}; const sid=workbench.input().sessionId;if(!sid||target===mode()){close(true);return}; setPending(true);setError(''); try {const r=await workbench.commands.setMode(sid,target);if(!r.ok)setError(shortControlCenterError(r.error,'权限模式切换失败'))} finally {setPending(false);close(true)} }
  createEffect(()=>{const currentSessionId=workbench.input().sessionId;if(currentSessionId!==previousSessionId)close();previousSessionId=currentSessionId})
  onMount(()=>{const pd=(e:PointerEvent)=>{if(open()&&!root?.contains(e.target as Node))close()};document.addEventListener('pointerdown',pd);onCleanup(()=>document.removeEventListener('pointerdown',pd))})
  const cycle=()=>{void choose(nextValue(entries().map(e=>e.id), mode()))}
  const width=()=>appearance().permissionWidth??120, height=()=>appearance().permissionHeight??28, radius=()=>appearance().permissionRadius??0, fontSize=()=>appearance().permissionFontSize??12
  const bg=()=>appearance().permissionBgColor==='black'?'#000':'#fff'
  const color=()=>{const c=appearance().permissionTextColor??'mode';return c==='mode'?undefined:c==='white'?'#fff':'#000'}
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,background:bg(),...(color()?{color:color()}:{})})
  return <div ref={el=>root=el} class="solid-permission-widget" style={{'margin-left':`${PERMISSION_GAP_PX}px`}}><Show when={error()}>{m=><span class="cc-widget-error" role="alert" aria-live="assertive" title={m()}>{m()}</span>}</Show><button ref={el=>trigger=el} type="button" class="cc-permission-trigger" data-mode={mode()} style={{...triggerStyle(),display:'flex','align-items':'center','justify-content':'center'}} aria-haspopup={switchMode()==='menu'?'listbox':undefined} aria-expanded={switchMode()==='menu'?open():undefined} aria-controls={switchMode()==='menu'?menuId:undefined} onClick={()=>switchMode()==='cycle'?cycle():setOpen(v=>!v)}>{pending()?'......':mode()}</button><Show when={switchMode()==='menu'&&open()}><div id={menuId} class="cc-model-menu" role="listbox" aria-label="权限模式选项" data-popover="control-center" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close(true)}}} style={{width:`${width()}px`}}><For each={entries().filter(x=>x.id!==mode())}>{item=><button type="button" role="option" class="cc-model-item" onClick={()=>void choose(item.id)}>{item.id}</button>}</For></div></Show></div>
}

/** Session-create reasoning preference. It uses the same compact control language
 * as the mode widget and remains available in the normal control center. */
const REASONING_GAP_PX = 12
export function SolidReasoningWidget(props: { draftValue?: () => string; onDraftChange?: (value: string) => void } = {}) {
  const workbench = useSolidWorkbench(); const runtime = () => workbench.runtimeSnapshot(); const appearance = () => workbench.appearanceSnapshot()
  const [open,setOpen]=createSignal(false); const [error,setError]=createSignal(''); const [pending,setPending]=createSignal(false)
  let root: HTMLDivElement|undefined; let trigger: HTMLButtonElement|undefined; let previousSessionId = workbench.input().sessionId
  const menuId=`cc-reasoning-menu-${createUniqueId()}`
  const entries=()=>resolveReasoningOptionEntries(runtime(), resolveDocumentOptionValue(runtime().document?.session.options, 'reasoning'))
  const current=()=>resolveDocumentOptionValue(runtime().document?.session.options, 'reasoning') || props.draftValue?.() || entries()[0]?.id || ''
    const choose=async(value:string)=>{ if(pending()) return; if(props.onDraftChange){props.onDraftChange(value);close(true);return}; const sid=workbench.input().sessionId;if(!sid||value===current()){close(true);return}; const option=runtime().document?.session.options?.find(isReasoningOption); const previous=current(); setPending(true);setError(''); try {const result=await workbench.commands.setConfigOption(sid,option?.id||'reasoning_effort',value,{expectedValue:previous,...(option?.version==null?{}:{expectedVersion:option.version})});if(!result.ok)setError(shortControlCenterError(result.error,'思考等级切换失败'))} finally {setPending(false);close(true)} }
  createEffect(()=>{const currentSessionId=workbench.input().sessionId;if(currentSessionId!==previousSessionId)close();previousSessionId=currentSessionId})
  onMount(()=>{const pd=(e:PointerEvent)=>{if(open()&&!root?.contains(e.target as Node))close()};document.addEventListener('pointerdown',pd);onCleanup(()=>document.removeEventListener('pointerdown',pd))})
  const mode=()=>appearance().reasoningSwitchMode??'menu'
  const cycle=()=>{const ids=entries().map(e=>e.id);const i=ids.indexOf(current());void choose(ids[(i+1+ids.length)%ids.length]||current())}
  const width=()=>appearance().reasoningWidth??120, height=()=>appearance().reasoningHeight??28, radius=()=>appearance().reasoningRadius??0, fontSize=()=>appearance().reasoningFontSize??12
  const bg=()=>appearance().reasoningBgColor==='black'?'#000':'#fff', fg=()=>appearance().reasoningTextColor==='white'?'#fff':'#000'; const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,background:bg(),color:fg()})
  return <div ref={el=>root=el} class="solid-reasoning-widget" style={{'margin-left':`${REASONING_GAP_PX}px`}}><Show when={error()}>{m=><span class="cc-widget-error" role="alert" aria-live="assertive" title={m()}>{m()}</span>}</Show><button ref={el=>trigger=el} type="button" class="cc-reasoning-trigger" style={{...triggerStyle(),display:'flex','align-items':'center','justify-content':'center'}} aria-haspopup={mode()==='menu'?'listbox':undefined} aria-expanded={mode()==='menu'?open():undefined} aria-controls={mode()==='menu'?menuId:undefined} onClick={()=>mode()==='cycle'?cycle():setOpen(v=>!v)}>{pending()?'......':current()}</button><Show when={mode()==='menu'&&open()}><div id={menuId} class="cc-model-menu" role="listbox" aria-label="思考强度选项" data-popover="control-center" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close(true)}}} style={{width:`${width()}px`}}><For each={entries().filter(x=>x.id!==current())}>{item=><button type="button" role="option" class="cc-model-item" onClick={()=>void choose(item.id)}>{item.id}</button>}</For></div></Show></div>
}

/** First-batch host renderer: the registered send block includes its icon layer;
 * the effect layer (highlight/shadow) is still pending. */
export function SolidCcSendButton(props: { disabled?: boolean; mode: 'inline' | 'external' }) {
  const workbench = useSolidWorkbench()
  const appearance = () => workbench.appearanceSnapshot()
  const runtime = () => workbench.runtimeSnapshot()
  const send = () => window.dispatchEvent(new CustomEvent('pylon:solid-input-send'))
  const cancel = () => {
    const sessionId = workbench.input().sessionId
    if (sessionId) void workbench.commands.cancel(sessionId)
  }
  const icon = () => runtime().generating ? appearance().sendButtonIconGenerating : appearance().sendButtonIcon
  const round = () => appearance().sendButtonIconRound === 'on'
  const iconClass = () => {
    const value = icon()
    const solid = value === 'triangle' || value === 'square'
    return `cc-send-icon ${solid ? 'cc-send-icon--solid' : 'cc-send-icon--stroke'}${round() && !solid ? ' cc-send-icon--round' : ''}${value === 'triangle' ? ' cc-send-icon--lg' : ''}${value === 'double-arrow' ? ' cc-send-icon--double' : ''}`
  }
  const path = () => {
    const value = icon()
    if (value === 'arrow') return 'M12 20 V4.5 M5.3 11.2 L12 4.5 L18.7 11.2'
    if (value === 'double-arrow') return 'M6.5 11 L12 6.5 L17.5 11 M6.5 17.5 L12 13 L17.5 17.5'
    if (value === 'cross') return 'M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5'
    if (value === 'triangle') return round() ? 'M10.94 9.31 A1.5 1.5 0 0 1 13.06 9.31 L16.94 13.19 A1.5 1.5 0 0 1 15.88 15.75 L8.12 15.75 A1.5 1.5 0 0 1 7.06 13.19 Z' : 'M12 8.25 L19.5 15.75 H4.5 Z'
    return round() ? 'M7.5 6 H16.5 A1.5 1.5 0 0 1 18 7.5 V16.5 A1.5 1.5 0 0 1 16.5 18 H7.5 A1.5 1.5 0 0 1 6 16.5 V7.5 A1.5 1.5 0 0 1 7.5 6 Z' : 'M6 6 H18 V18 H6 Z'
  }
  return <button
    type="button"
    class="cc-send-button"
    data-mode={props.mode}
    disabled={props.disabled}
    title={runtime().generating ? '停止生成' : '发送'}
    aria-label={runtime().generating ? '停止生成' : '发送消息'}
    onClick={() => runtime().generating ? cancel() : send()}
  ><svg viewBox="0 0 24 24" class={iconClass()} aria-hidden="true"><path d={path()} /></svg></button>
}



