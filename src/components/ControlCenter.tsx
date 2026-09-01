import { useRef, useState, useCallback, useEffect, useId } from 'react'
import { useStore } from '../store'
import { useRuntimeStore } from '../runtimeStore'
import { useIdentityStore } from '../identityStore'
import { resolveSession } from './chat/sessionCommandState'
import { toAgentContextKey } from '../agentContext'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import InputBar from './chat/InputBar'
import SendWidget from './chat/SendWidget'
import AttachWidget from './chat/AttachWidget'
import ColorPopover from './ColorPopover'
import { toCssBackgroundImage } from '../backgroundImage'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../ccHeightState'
import { isExternalSubmitMode, isWidgetVisible, WIDGET_PROPERTY_FIELDS, type CcWidgetId } from '../domains/cc/widgetDefinitions'
import { CC_WIDGET_REGISTRY as WIDGET_REGISTRY } from './cc/widgetRegistry'
import type { CcSlot } from '../ccLayoutState'
import Select from './ui/Select.tsx'
import { usePresentationPreferenceStore } from '../domains/presentation/presentationPreferenceStore.ts'

interface Props {
  sessionId: string | null
}

// ccHidden 缺省时的稳定空数组：selector 直接返回 s.ccHidden（undefined → ?? 常量），
// 避免 `|| []` 每次调用创建新引用 → useSyncExternalStore 挂载时 forceStoreRerender 无限循环（#185）
const NO_HIDDEN_IDS: readonly string[] = []

// Widget registry 位于 cc/widgetRegistry.tsx，供中控画布、工具栏和后续 Preview 共用。
export default function ControlCenter({ sessionId }: Props) {
  const {
    rawCcHeight,
    rawCcBgHeight,
    inputMode,
    rawSubmitButtonMode,
    rawHidden,
    ccStyle,
    layout,
    editMode,
    rawCcVariant,
    rawCliHintMode,
    rawFooterLayout,
    rawCliOverflowMode,
    rawCcBg,
    rawCcBgImage,
    setCcEditMode,
    setCcHeight,
  } = useStore(useShallow(s => ({
    rawCcHeight: s.ccHeight,
    rawCcBgHeight: s.ccBgHeight,
    inputMode: s.inputMode,
    rawSubmitButtonMode: s.inputSubmitButtonMode,
    rawHidden: s.ccHidden,
    ccStyle: s.ccStyle,
    layout: s.ccLayout,
    editMode: s.ccEditMode,
    rawCcVariant: s.ccVariant,
    rawCliHintMode: s.cliHintMode,
    rawFooterLayout: s.footerLayout,
    rawCliOverflowMode: s.cliOverflowMode,
    rawCcBg: s.ccBg,
    rawCcBgImage: s.ccBgImage,
    setCcEditMode: s.setCcEditMode,
    setCcHeight: s.setCcHeight,
  })))
  const ccHeight = rawCcHeight || 120
  const ccBgHeight = rawCcBgHeight ?? ccHeight
  const submitButtonMode = rawSubmitButtonMode || 'inline'
  const hidden = rawHidden ?? NO_HIDDEN_IDS
  const ccVariant = rawCcVariant || 'terminal'
  const cliHintMode = rawCliHintMode || 'full'
  const footerLayout = rawFooterLayout || 'free'
  const cliOverflowMode = rawCliOverflowMode || 'fixed-scroll'
  const ccBg = rawCcBg || 'transparent'
  const ccBgImage = rawCcBgImage || ''
  const hintId = useId()
  const presentationProfileId = usePresentationPreferenceStore(state => state.activeProfileId)
  const inputHintId = inputMode === 'cli' && cliHintMode !== 'hidden' ? hintId : undefined

  const inputRef = useRef<{ send: () => void; attachFile: () => void; cancel: () => void }>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 把 inputRef 转给 SendWidget / AttachWidget
  const renderWidget = (id: string) => {
    const def = WIDGET_REGISTRY.find(w => w.id === id)
    if (!def) return null
    // C2：可见性判定与 ccHeightState 计数消费同一谓词（isWidgetVisible，含 send/attach 的
    // externalBtnMode 判定），修此前"计数把不渲染的 send/attach 算入最小高"的失真。
    if (!isWidgetVisible(id, { hidden, inputMode, submitButtonMode, ccStyle, editMode, presentationProfileId })) return null

    // externalSend/externalAttach 逐按钮决定 InputBar 是否隐藏自带按钮，避免重复或丢失；
    // 外部按钮模式判定消费域单一真值（isExternalSubmitMode，与 isWidgetVisible 同源）
    const externalBtnMode = isExternalSubmitMode({ inputMode, submitButtonMode })
    const externalSend = externalBtnMode && !hidden.includes('send')
    const externalAttach = externalBtnMode && !hidden.includes('attach')

    let body: React.ReactNode
    switch (id) {
      case 'input':
        body = <InputBar ref={inputRef} sessionId={sessionId} split={editMode ? (externalSend || externalAttach) : false} externalSend={externalSend} externalAttach={externalAttach} ariaDescribedBy={inputHintId} />
        break
      case 'send':
        body = <SendWidget onClick={() => inputRef.current?.send()} />
        break
      case 'attach':
        body = <AttachWidget onClick={() => inputRef.current?.attachFile()} />
        break
      default:
        body = def.render?.({ sessionId })
    }

    const placement = layout.placements[id as keyof typeof layout.placements]
    if (!placement) return null
    // 小控件用 naturalSize（宽高由内容决定，盒子紧贴）— 仅 input 占满槽位
    const isNatural = def.naturalSize
    return (
      <EditableWidget
        key={id} id={id} placement={placement} editMode={editMode}
        naturalSize={isNatural}
        isHidden={hidden.includes(id)}
        bodyRef={ccBodyRef}
        selected={selected === id}
        onSelect={() => setSelected(id)}
      >
        {body}
      </EditableWidget>
    )
  }

  const renderSlot = (slot: 'status-primary' | 'status-secondary' | 'actions') => WIDGET_REGISTRY
    .filter(widget => widget.id !== 'input' && layout.placements[widget.id as keyof typeof layout.placements]?.slot === slot)
    .sort((a, b) => (layout.placements[a.id as keyof typeof layout.placements]?.order ?? 0) - (layout.placements[b.id as keyof typeof layout.placements]?.order ?? 0))
    .map(widget => renderWidget(widget.id))

  const ccBodyRef = useRef<HTMLDivElement>(null)
  const visibleStatusWidgets = resolveVisibleStatusWidgetCount({
    hiddenIds: hidden,
    inputMode,
    ccStyle,
    submitButtonMode,
    presentationProfileId,
  })
  const minHeight = resolveCcMinHeight({
    inputMode,
    footerLayout,
    hintMode: cliHintMode,
    visibleStatusWidgets,
    cliOverflowMode,
  })

  // 整体高度拖拽
  const heightDragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { heightDragCleanupRef.current?.() }, [])
  const onHeightDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = ccHeight
    const onMove = (ev: MouseEvent) => {
      setCcHeight(startH + startY - ev.clientY)
    }
    const onUp = () => {
      heightDragCleanupRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    heightDragCleanupRef.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [ccHeight, setCcHeight])

  // Escape 退出编辑模式
  useEffect(() => {
    if (!editMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else setCcEditMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editMode, selected, setCcEditMode])

  // C3：peri/free 两分支共享的三槽位与命令提示，抽为片段；仅外层结构（hint 位置）保留差异
  const statusSlots = (
    <>
      <div className="cc-status-secondary">{renderSlot('status-secondary')}</div>
      <div className="cc-status-primary">{renderSlot('status-primary')}</div>
      <div className="cc-actions">{renderSlot('actions')}</div>
    </>
  )
  const commandHint = inputMode === 'cli' && cliHintMode !== 'hidden' ? (
    <div className="cc-command-hint" id={hintId} aria-label="输入快捷键提示">
      <span className="cc-command-hint-key">/: 命令</span>
      <span className="cc-hint-secondary"><i>|</i> Shift+Enter: 换行</span>
      {cliHintMode === 'full' && <span className="cc-hint-tertiary"><i>|</i> Shift+Tab: 模式</span>}
    </div>
  ) : null

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''} ${editMode ? 'cc-editing' : ''} cc-variant-${ccVariant}`}
      style={{
        '--cc-height': `${ccHeight}px`,
        '--cc-min-height': `${minHeight}px`,
        // 背景高度不得小于容器最小高：预设 ccBgHeight(76) 与 clamp 后的 ccHeight(84)
        // 不一致时，背景短于容器会露出底部无背景条
        // D2：漏斗/setCcHeight/migrate 已保证 ccBgHeight ≥ ccHeight ≥ minHeight，渲染期补丁移除
        '--cc-bg-height': `${ccBgHeight}px`,
        '--cc-bg': ccBg,
        '--cc-bg-image': toCssBackgroundImage(ccBgImage),
      } as React.CSSProperties}>
      {editMode && (
        <div className="cc-edit-hdr" onMouseDown={onHeightDrag}>
          <div className="cc-edit-hdr-bar" />
          <span className="cc-edit-hdr-label">{ccHeight}px</span>
        </div>
      )}
      <div className="cc-bg" />
      <div className="cc-body" ref={ccBodyRef}>
        {footerLayout === 'peri' ? (
          <div className="cc-footer cc-footer-peri">
            <div className="cc-input-slot">{renderWidget('input')}</div>
            <div className="cc-footer-status">
              <div className="cc-footer-status-row">{statusSlots}</div>
              {commandHint}
            </div>
          </div>
        ) : (
          <>
            <div className="cc-input-slot">{renderWidget('input')}</div>
            <div className="cc-status-row">
              {statusSlots}
              {commandHint}
            </div>
          </>
        )}
      </div>
      {editMode && selected && <PropertyPanel id={selected} sessionId={sessionId} onClose={() => setSelected(null)} onExit={() => { setCcEditMode(false); setSelected(null) }} />}
      {editMode && (
        <WidgetToolbar
          selected={selected}
          onSelect={(id) => setSelected(id)}
        />
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// EditableWidget：单一职责，干净指针事件
// ───────────────────────────────────────────────────────────────

function EditableWidget({ id, placement, editMode, isHidden, children, bodyRef, selected, onSelect, naturalSize }: {
  id: string
  placement: { slot: 'input' | 'status-primary' | 'status-secondary' | 'actions'; order: number; offsetX: number; offsetY: number }
  editMode: boolean
  isHidden: boolean
  children: React.ReactNode
  bodyRef: React.RefObject<HTMLDivElement | null>
  selected: boolean
  onSelect: () => void
  // 文字型控件(model/mode/send/attach)用 naturalSize=true — 宽高随内容自适应
  naturalSize?: boolean
}) {
  // 拖拽 / 缩放 — 使用 Pointer Events（统一鼠标+触屏）
  // 直接读 store.getState() 拿最新 pos，避免闭包过期
  const pointerCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { pointerCleanupRef.current?.() }, [])

  const handleWidgetPointerDown = (e: React.PointerEvent) => {
    if (!editMode) return
    e.stopPropagation()
    e.preventDefault()
    onSelect()
    const body = bodyRef.current; if (!body) return
    const startX = e.clientX, startY = e.clientY
    const pointerId = e.pointerId
    const currentLayout = useStore.getState().ccLayout
    const start = currentLayout.placements[id as keyof typeof currentLayout.placements] || placement
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      useStore.getState().updateCcPlacement(id, {
        offsetX: start.offsetX + ev.clientX - startX,
        offsetY: start.offsetY + ev.clientY - startY,
      })
    }
    const onUp = (ev?: PointerEvent) => {
      if (ev && ev.pointerId !== pointerId) return
      pointerCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    pointerCleanupRef.current = onUp
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      data-widget-id={id}
      className={`cc-widget ${editMode ? 'cc-edit' : ''} ${editMode && isHidden ? 'cc-hidden' : ''} ${selected ? 'cc-selected' : ''} ${naturalSize ? 'cc-natural' : ''}`}
      style={{ transform: `translate(${placement.offsetX}px, ${placement.offsetY}px)` }}
      onPointerDown={editMode ? handleWidgetPointerDown : undefined}
    >
      {children}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// WidgetToolbar：编辑模式下浮在画布底部，显示「增删控件」+ 重置
// ───────────────────────────────────────────────────────────────

function WidgetToolbar({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const hidden = useStore(s => s.ccHidden ?? NO_HIDDEN_IDS)
  const resetCcLayout = useStore(s => s.resetCcLayout)
  const setCcHidden = useStore(s => s.setCcHidden)
  const setCcEditMode = useStore(s => s.setCcEditMode)

  const reset = () => resetCcLayout()

  const toggleHide = (id: string) => {
    setCcHidden(id, !hidden.includes(id))
  }

  return (
    <div className="cc-edit-toolbar">
      <span className="cc-edit-toolbar-label">控件</span>
      {WIDGET_REGISTRY.map(w => {
        const isHidden = hidden.includes(w.id)
        const isSelected = selected === w.id
        return (
          <span key={w.id}
            className={`cc-edit-toolbar-chip-wrap ${isSelected ? 'active' : ''} ${isHidden ? 'dim' : ''}`}>
            <button type="button" className="cc-edit-toolbar-chip"
              onClick={() => onSelect(w.id)}
              title="选中控件（打开属性面板）">
              {isHidden ? '＋' : '●'} {w.label}
            </button>
            <button type="button" className="cc-chip-toggle"
              onClick={() => toggleHide(w.id)}
              title={isHidden ? '已隐藏 — 点击恢复' : '显示中 — 点击隐藏'}>
              {isHidden ? '显示' : '隐藏'}
            </button>
          </span>
        )
      })}
      <button className="cc-edit-toolbar-btn" onClick={reset} title="重置所有控件位置到默认">↺ 重置位置</button>
      <button className="cc-edit-toolbar-btn danger" onClick={() => { setCcEditMode(false); onSelect(null) }}>退出编辑</button>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────
// PropertyPanel — 选中控件的属性编辑面板
// ───────────────────────────────────────────────────────────────

function PropertyPanel({ id, sessionId, onClose, onExit }: { id: string; sessionId: string | null; onClose: () => void; onExit: () => void }) {
  const placement = useStore(s => s.ccLayout.placements[id as keyof typeof s.ccLayout.placements])
  const u = useStore(s => s.setZoneField)
  const updateCcPlacement = useStore(s => s.updateCcPlacement)
  const setCcScale = useStore(s => s.setCcScale)
  // EG：模式读数走 session 作用域（顶层 liveMode 死镜像已删）；sessionModes 由 config_option_update 写入
  const sessions = useIdentityStore(s => s.sessions)
  const currentMode = useRuntimeStore(s => {
    const session = resolveSession(sessionId, sessions)
    if (!session) return 'default'
    return s.sessionModes[toAgentContextKey({ agentId: session.agentId, source: session.source })] || 'default'
  })
  // 只订阅属性面板实际读取的字段：拖拽/生成期间的 live 状态变化不再重渲染面板。
  const theme = useStore(useShallow(s => ({
    ccScale: s.ccScale,
    inputBg: s.inputBg,
    inputTextColor: s.inputTextColor,
    inputFontSize: s.inputFontSize,
    inputMinHeight: s.inputMinHeight,
    inputMode: s.inputMode,
    cliLineWidth: s.cliLineWidth,
    cliLineColor: s.cliLineColor,
    cliLinePadding: s.cliLinePadding,
    ccStyle: s.ccStyle,
    ekgWidth: s.ekgWidth,
    ekgGreen: s.ekgGreen,
    ekgYellow: s.ekgYellow,
    ekgRed: s.ekgRed,
    barTrackColor: s.barTrackColor,
    barHeight: s.barHeight,
    barFillFollow: s.barFillFollow,
    barFillColor: s.barFillColor,
    modelVariant: s.modelVariant,
    modeVariant: s.modeVariant,
    sendVariant: s.sendVariant,
    attachVariant: s.attachVariant,
  })))
  const labels: Record<string, string> = {
    input: '输入栏', ekg: '用量条', pct: '百分比', tokens: 'Token数',
    model: '模型', mode: '权限模式', send: '发送按钮', attach: '附件按钮',
  }

  // D2：key 收窄为 keyof ThemeSettings（C4 schema 提供），值收窄为标量联合——消灭 `v: any`
  const up = (k: keyof ThemeSettings, v: string | number | boolean) => u('cc', { [k]: v } as Partial<ThemeSettings>)
  const upOffset = (key: 'offsetX' | 'offsetY', value: number) => updateCcPlacement(id, { [key]: value })

  return (
    <div className="cc-prop-panel">
      <div className="cc-prop-header">
        <span>{labels[id] || id}</span>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="cc-prop-body">
        <div className="cc-prop-sec">布局</div>
        <div className="cc-prop-field"><label>槽位</label>
          <Select ariaLabel="槽位" className="set-select" value={placement?.slot || 'status-primary'} onChange={value => updateCcPlacement(id, { slot: value as CcSlot })} options={[
            { value: 'input', label: '输入栏' },
            { value: 'status-primary', label: '状态左' },
            { value: 'status-secondary', label: '状态右' },
            { value: 'actions', label: '操作区' },
          ]} />
        </div>
        <div className="cc-prop-field"><label>顺序</label><input type="number" value={placement?.order ?? 0} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) updateCcPlacement(id, { order: value }) }} step={1} className="set-num" min={0} max={99} /></div>
        <div className="cc-prop-field"><label>水平微调</label><input type="number" value={placement?.offsetX ?? 0} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) upOffset('offsetX', value) }} step={1} className="set-num" min={-48} max={48} /><span>px</span></div>
        <div className="cc-prop-field"><label>垂直微调</label><input type="number" value={placement?.offsetY ?? 0} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) upOffset('offsetY', value) }} step={1} className="set-num" min={-16} max={16} /><span>px</span></div>
        {id !== 'input' && (
          <div className="cc-prop-field"><label>缩放</label>
            <input type="number" value={(theme.ccScale || {})[id] ?? 100}
              onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) setCcScale(id, value) }}
              step={5} className="set-num" min={50} max={200} /><span>%</span>
          </div>
        )}

        {/* C4：属性表单由 WIDGET_PROPERTY_FIELDS schema 驱动（ColorPopover/数字/chips），
            inputMode↔inputVariant 双写经 chips.sync 表达，与 Settings 双写一致 */}
        {(WIDGET_PROPERTY_FIELDS[id as CcWidgetId] || []).filter(field => !field.showIf || field.showIf(theme as unknown as ThemeSettings)).map((field, index) => {
          if (field.kind === 'section') return <div key={index} className="cc-prop-sec">{field.title}</div>
          const key = field.key as keyof ThemeSettings
          const val = (theme as Record<string, unknown>)[key]
          switch (field.kind) {
            case 'color':
              return <div key={index} className="cc-prop-field"><label>{field.label}</label><ColorPopover value={String(val ?? '')} onChange={v => up(key, v)} /></div>
            case 'number':
              return <div key={index} className="cc-prop-field"><label>{field.label}</label><input type="number" value={Number(val) || 0} onChange={event => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) up(key, value) }} step={field.step ?? 1} className="set-num" min={field.min} max={field.max} />{field.suffix && <span>{field.suffix}</span>}</div>
            case 'chips':
              return (
                <div key={index} className="cc-prop-field"><label>{field.label}</label>
                  <div className="set-preset-row">
                    {field.options.map(opt => (
                      <button key={opt.value} className={`set-preset-chip ${val === opt.value ? 'active' : ''}`}
                        onClick={() => { up(key, opt.value); if (opt.sync) up(opt.sync.key as keyof ThemeSettings, opt.sync.value) }}>{opt.label}</button>
                    ))}
                  </div>
                </div>
              )
            case 'chipsBool':
              return (
                <div key={index} className="cc-prop-field"><label>{field.label}</label>
                  <div className="set-preset-row">
                    <button className={`set-preset-chip ${val !== false ? 'active' : ''}`} onClick={() => up(key, true)}>{field.trueLabel}</button>
                    <button className={`set-preset-chip ${val === false ? 'active' : ''}`} onClick={() => up(key, false)}>{field.falseLabel}</button>
                  </div>
                </div>
              )
            default:
              return null
          }
        })}
        {/* mode widget 的运行时只读读数（非主题属性，保留特判） */}
        {id === 'mode' && (
          <div className="cc-prop-field"><label>当前</label><span style={{ fontSize: 13, color: currentMode === 'bypass' ? '#FF6B80' : currentMode === 'auto' ? '#FFC107' : currentMode === 'edit' ? '#A2A9E4' : '#999' }}>{currentMode}</span></div>
        )}
      </div>
      <div className="cc-prop-footer">
        <button className="ps-btn sm" onClick={onExit}>退出自定义</button>
      </div>
    </div>
  )
}
