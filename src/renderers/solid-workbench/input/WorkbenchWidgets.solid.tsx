import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from 'solid-js'
import { useSolidWorkbench } from '../SolidWorkbenchContext.solid.tsx'
import {
  optionLabel,
  resolveModeOptionEntries,
  resolveModelOptionEntries,
  resolveReasoningOptionEntries,
  resolveDocumentOptionValue,
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
  const width=()=>appearance().modelWidth??120, height=()=>appearance().modelHeight??28, radius=()=>appearance().modelRadius??0, fontSize=()=>appearance().modelFontSize??12
  const bg=()=>appearance().modelBgColor==='black'?'#000':'#fff', fg=()=>appearance().modelTextColor==='white'?'#fff':'#000'; const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const choose=async(target:string)=>{ if(pending()) return; if(props.onDraftChange){props.onDraftChange(target);close(true);return}; const sid=workbench.input().sessionId;if(!sid||target===model()){close(true);return}; setPending(true);setError(''); try {const r=await workbench.commands.setModel(sid,target);if(!r.ok)setError(r.error||'未配置模型?')} finally {setPending(false);close(true)} }
  createEffect(()=>{const currentSessionId=workbench.input().sessionId;if(currentSessionId!==previousSessionId)close();previousSessionId=currentSessionId})
  onMount(()=>{const pd=(e:PointerEvent)=>{if(open()&&!root?.contains(e.target as Node))close()};document.addEventListener('pointerdown',pd);onCleanup(()=>document.removeEventListener('pointerdown',pd))})
  const rootStyle=()=>({'margin-top':`${height()/2}px`}); const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,background:bg(),color:fg(),display:'flex','align-items':'center','justify-content':'center'})
  return <div ref={el=>root=el} class="solid-model-widget"><Show when={error()}>{m=><span class="cc-widget-error" role="alert">{m()}</span>}</Show><div class="cc-model-root" style={rootStyle()}><button ref={el=>trigger=el} type="button" class="cc-model-trigger" style={triggerStyle()} aria-haspopup={mode()==='menu'?'listbox':undefined} aria-expanded={mode()==='menu'?open():undefined} aria-controls={mode()==='menu'?menuId:undefined} onClick={()=>mode()==='menu'?setOpen(v=>!v):void choose(nextValue(models(),model()))}>{pending()?'......':model()}</button><Show when={mode()==='menu'&&open()}><div id={menuId} class="cc-model-menu" style={{width:`${width()}px`}} role="listbox" aria-label="模型列表" data-popover="control-center" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close(true)}}}><For each={entries().filter(x=>x.id!==model())}>{item=><button type="button" role="option" aria-selected={false} class="cc-model-item" onClick={()=>void choose(item.id)}>{item.label||item.id}</button>}</For></div></Show></div></div>
}

export function SolidModeWidget(props: {
  draftValue?: () => string
  onDraftChange?: (value: string) => void
  forceDropdown?: boolean
} = {}) {
  const workbench = useSolidWorkbench()
  const runtime = () => workbench.runtimeSnapshot()
  const appearance = () => workbench.appearanceSnapshot()
  const [error, setError] = createSignal('')
  const [open, setOpen] = createSignal(false)
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let previousSessionId = workbench.input().sessionId
  const menuId = `cc-mode-menu-${createUniqueId()}`
  const modeEntries = () => resolveModeOptionEntries(runtime(), props.draftValue?.())
  const modes = () => modeEntries().map(item => item.id)
  const mode = () => props.draftValue?.() || runtime().activeMode || modeEntries()[0]?.id || 'default'
  const scale = () => appearance().ccScale.mode ?? 100
  const dropdown = () => props.forceDropdown === true
  const displayMode = () => dropdown() ? optionLabel('mode', mode()) : mode()
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => trigger?.focus())
  }
  createEffect(() => {
    const currentSessionId = workbench.input().sessionId
    if (currentSessionId !== previousSessionId || !dropdown()) close()
    previousSessionId = currentSessionId
  })
  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!open() || root?.contains(event.target as Node)) return
      close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!open() || event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    })
  })
  let menu: HTMLDivElement | undefined
  createEffect(() => {
    if (!open()) return
    queueMicrotask(() => menu?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus())
  })
  const chooseMode = async (target: string) => {
    const sessionId = workbench.input().sessionId
    if (props.onDraftChange) {
      props.onDraftChange(target)
      close(true)
      return
    }
    if (!sessionId) { close(true); return }
    const result = await workbench.commands.setMode(sessionId, target)
    if (!result.ok) setError(result.error || '权限模式切换失败')
    else setError('')
    close(true)
  }
  const cycle = async () => {
    const sessionId = workbench.input().sessionId
    if (props.onDraftChange) { props.onDraftChange(nextValue(modes(), mode())); return }
    if (!sessionId) return
    const result = await workbench.commands.setMode(sessionId, nextValue(modes(), mode()))
    if (!result.ok) setError(result.error || '权限模式切换失败')
    else setError('')
  }

  return (
    <div class="solid-mode-widget">
      <Show when={error()}>{message => <span class="cc-widget-error" role="alert">{message()}</span>}</Show>
      <Show when={dropdown()} fallback={
        <Show when={appearance().modeVariant === 'badge'} fallback={
          <Show when={appearance().modeVariant === 'minimal'} fallback={
            <button type="button" class="cc-mode-widget" title="点击切换" style={{ 'font-size': `${scale()}%` }} onClick={() => void cycle()}>
              <span class="mode-pill" data-mode={mode()}>{mode()}</span>
            </button>
          }>
            <button type="button" class="cc-mode-minimal" data-mode={mode()} style={{ 'font-size': `${scale()}%` }} onClick={() => void cycle()}>{mode()}</button>
          </Show>
        }>
          <button type="button" class="cc-mode-badge" data-mode={mode()} title="点击切换" style={{ 'font-size': `${scale()}%` }} onClick={() => void cycle()}>
            [{mode()}]
          </button>
        </Show>
      }>
        <div ref={node => { root = node }} class="cc-mode-dropdown">
          <button
            ref={node => { trigger = node }}
            type="button"
            class="cc-mode-widget cc-mode-select"
            title="选择权限模式"
            style={{ 'font-size': `${scale()}%` }}
            aria-haspopup="listbox"
            aria-expanded={open()}
            aria-controls={menuId}
            onClick={() => setOpen(value => !value)}
          ><span class="mode-pill" data-mode={mode()}>{displayMode()}</span> ?</button>
          <Show when={open()}>
            <div
              ref={node => { menu = node }}
              id={menuId}
              class="mode-menu cc-model-menu"
              data-popover="control-center"
              role="listbox"
              aria-label="模式列表"
              tabIndex="-1"
              onKeyDown={event => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                close(true)
              }}
            >
              <For each={modeEntries()}>{item => <button
                type="button"
                role="option"
                aria-selected={item.id === mode()}
                class={`cc-model-item${item.id === mode() ? ' active' : ''}`}
                tabIndex={-1}
                onClick={() => { void chooseMode(item.id) }}
              >{optionLabel('mode', item.id, item.label)}</button>}</For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
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
    const choose=async(value:string)=>{ if(pending()) return; if(props.onDraftChange){props.onDraftChange(value);close(true);return}; const sid=workbench.input().sessionId;if(!sid||value===current()){close(true);return}; const option=runtime().document?.session.options?.find(o=>o.id==='reasoning_effort'||o.id==='reasoning'); const previous=current(); setPending(true);setError(''); try {const result=await workbench.commands.setConfigOption(sid,option?.id||'reasoning_effort',value,{expectedValue:previous,...(option?.version==null?{}:{expectedVersion:option.version})});if(!result.ok)setError(result.error||'切换失败')} finally {setPending(false);close(true)} }
  createEffect(()=>{const currentSessionId=workbench.input().sessionId;if(currentSessionId!==previousSessionId)close();previousSessionId=currentSessionId})
  onMount(()=>{const pd=(e:PointerEvent)=>{if(open()&&!root?.contains(e.target as Node))close()};document.addEventListener('pointerdown',pd);onCleanup(()=>document.removeEventListener('pointerdown',pd))})
  const mode=()=>appearance().reasoningSwitchMode??'menu'
  const cycle=()=>{const ids=entries().map(e=>e.id);const i=ids.indexOf(current());void choose(ids[(i+1+ids.length)%ids.length]||current())}
  const width=()=>appearance().reasoningWidth??120, height=()=>appearance().reasoningHeight??28, radius=()=>appearance().reasoningRadius??0, fontSize=()=>appearance().reasoningFontSize??12
  const bg=()=>appearance().reasoningBgColor==='black'?'#000':'#fff', fg=()=>appearance().reasoningTextColor==='white'?'#fff':'#000'; const close=(focus=false)=>{setOpen(false);if(focus)queueMicrotask(()=>trigger?.focus())}
  const triggerStyle=()=>({width:`${width()}px`,height:`${height()}px`,'border-radius':`${radius()}px`,'font-size':`${fontSize()}px`,background:bg(),color:fg()})
  return <div ref={el=>root=el} class="solid-reasoning-widget" style={{'margin-left':`${REASONING_GAP_PX}px`,'margin-top':`${height()/2}px`}}><Show when={error()}>{m=><span class="cc-widget-error" role="alert">{m()}</span>}</Show><button ref={el=>trigger=el} type="button" class="cc-reasoning-trigger" style={{...triggerStyle(),display:'flex','align-items':'center','justify-content':'center'}} aria-haspopup={mode()==='menu'?'listbox':undefined} aria-expanded={mode()==='menu'?open():undefined} aria-controls={mode()==='menu'?menuId:undefined} onClick={()=>mode()==='cycle'?cycle():setOpen(v=>!v)}>{pending()?'......':current()}</button><Show when={mode()==='menu'&&open()}><div id={menuId} class="cc-model-menu" role="listbox" aria-label="思考强度选项" data-popover="control-center" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();close(true)}}} style={{width:`${width()}px`}}><For each={entries().filter(x=>x.id!==current())}>{item=><button type="button" role="option" class="cc-model-item" onClick={()=>void choose(item.id)}>{item.id}</button>}</For></div></Show></div>
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



