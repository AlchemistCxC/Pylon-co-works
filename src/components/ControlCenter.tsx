import { useRef, useState, useCallback, useEffect, useId } from 'react'
import { useStore } from '../store'
import { useRuntimeStore } from '../runtimeStore'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import InputBar from './chat/InputBar'
import SendWidget from './chat/SendWidget'
import AttachWidget from './chat/AttachWidget'
import ColorPopover from './ColorPopover'
import { toCssBackgroundImage } from '../backgroundImage'
import { resolveCcMinHeight, resolveVisibleStatusWidgetCount } from '../ccHeightState'
import { isWidgetVisible } from '../domains/cc/widgetDefinitions'
import { CC_WIDGET_REGISTRY as WIDGET_REGISTRY } from './cc/widgetRegistry'
import './ControlCenter.css'
import './chat/StatusBar.css'  // model/mode/send/attach widget 样式

interface Props {
  sessionId: string | null
}

// Widget registry 位于 cc/widgetRegistry.tsx，供中控画布、工具栏和后续 Preview 共用。
export default function ControlCenter({ sessionId }: Props) {
  const ccHeight = useStore(s => s.ccHeight) || 120
  const ccBgHeight = useStore(s => s.ccBgHeight ?? ccHeight)
  const inputMode = useStore(s => s.inputMode)
  const submitButtonMode = useStore(s => s.inputSubmitButtonMode || 'inline')
  const hidden = useStore(s => s.ccHidden || [])
  const ccStyle = useStore(s => s.ccStyle)
  const layout = useStore(s => s.ccLayout)
  const editMode = useStore(s => s.ccEditMode)
  const ccVariant = useStore(s => s.ccVariant) || 'terminal'
  const cliHintMode = useStore(s => s.cliHintMode || 'full')
  const footerLayout = useStore(s => s.footerLayout || 'free')
  const cliOverflowMode = useStore(s => s.cliOverflowMode || 'fixed-scroll')
  const ccBg = useStore(s => s.ccBg) || 'transparent'
  const ccBgImage = useStore(s => s.ccBgImage) || ''
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const setCcHeight = useStore(s => s.setCcHeight)
  const hintId = useId()
  const inputHintId = inputMode === 'cli' && cliHintMode !== 'hidden' ? hintId : undefined

  const inputRef = useRef<{ send: () => void; attachFile: () => void; cancel: () => void }>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 把 inputRef 转给 SendWidget / AttachWidget
  const renderWidget = (id: string) => {
    const def = WIDGET_REGISTRY.find(w => w.id === id)
    if (!def) return null
    // C2：可见性判定与 ccHeightState 计数消费同一谓词（isWidgetVisible，含 send/attach 的
    // externalBtnMode 判定），修此前"计数把不渲染的 send/attach 算入最小高"的失真。
    if (!isWidgetVisible(id, { hidden, inputMode, submitButtonMode, ccStyle, editMode })) return null

    // externalSend/externalAttach 逐按钮决定 InputBar 是否隐藏自带按钮，避免重复或丢失
    const externalBtnMode = inputMode !== 'cli' && submitButtonMode === 'external'
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

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''} ${editMode ? 'cc-editing' : ''} cc-variant-${ccVariant}`}
      style={{
        '--cc-height': `${ccHeight}px`,
        '--cc-min-height': `${minHeight}px`,
        // 背景高度不得小于容器最小高：预设 ccBgHeight(76) 与 clamp 后的 ccHeight(84)
        // 不一致时，背景短于容器会露出底部无背景条
        '--cc-bg-height': `${Math.max(ccBgHeight, minHeight)}px`,
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
              <div className="cc-footer-status-row">
                <div className="cc-status-secondary">{renderSlot('status-secondary')}</div>
                <div className="cc-status-primary">{renderSlot('status-primary')}</div>
                <div className="cc-actions">{renderSlot('actions')}</div>
              </div>
              {inputMode === 'cli' && cliHintMode !== 'hidden' && (
                <div className="cc-command-hint" id={hintId} aria-label="输入快捷键提示">
                  <span className="cc-command-hint-key">/: 命令</span>
                  <span className="cc-hint-secondary"><i>|</i> Shift+Enter: 换行</span>
                  {cliHintMode === 'full' && <span className="cc-hint-tertiary"><i>|</i> Shift+Tab: 模式</span>}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="cc-input-slot">{renderWidget('input')}</div>
            <div className="cc-status-row">
              <div className="cc-status-secondary">{renderSlot('status-secondary')}</div>
              <div className="cc-status-primary">{renderSlot('status-primary')}</div>
              <div className="cc-actions">{renderSlot('actions')}</div>
              {inputMode === 'cli' && cliHintMode !== 'hidden' && (
                <div className="cc-command-hint" id={hintId} aria-label="输入快捷键提示">
                  <span className="cc-command-hint-key">/: 命令</span>
                  <span className="cc-hint-secondary"><i>|</i> Shift+Enter: 换行</span>
                  {cliHintMode === 'full' && <span className="cc-hint-tertiary"><i>|</i> Shift+Tab: 模式</span>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {editMode && selected && <PropertyPanel id={selected} onClose={() => setSelected(null)} onExit={() => { setCcEditMode(false); setSelected(null) }} />}
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
    const currentLayout = useStore.getState().ccLayout
    const start = currentLayout.placements[id as keyof typeof currentLayout.placements] || placement
    const onMove = (ev: PointerEvent) => {
      useStore.getState().updateCcPlacement(id, {
        offsetX: start.offsetX + ev.clientX - startX,
        offsetY: start.offsetY + ev.clientY - startY,
      })
    }
    const onUp = () => {
      pointerCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    pointerCleanupRef.current = onUp
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
  const hidden = useStore(s => s.ccHidden || [])
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

function PropertyPanel({ id, onClose, onExit }: { id: string; onClose: () => void; onExit: () => void }) {
  const placement = useStore(s => s.ccLayout.placements[id as keyof typeof s.ccLayout.placements])
  const u = useStore(s => s.setZoneField)
  const updateCcPlacement = useStore(s => s.updateCcPlacement)
  const setCcScale = useStore(s => s.setCcScale)
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
  // liveMode 是运行时状态（runtimeStore 域）
  const liveMode = useRuntimeStore(s => s.liveMode)
  const labels: Record<string, string> = {
    input: '输入栏', ekg: '用量条', pct: '百分比', tokens: 'Token数',
    model: '模型', mode: '权限模式', send: '发送按钮', attach: '附件按钮',
  }

  const up = (k: string, v: any) => u('cc', { [k]: v } as Partial<ThemeSettings>)
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
          <select className="set-select" value={placement?.slot || 'status-primary'} onChange={event => updateCcPlacement(id, { slot: event.target.value as any })}>
            <option value="input">输入栏</option>
            <option value="status-primary">状态左</option>
            <option value="status-secondary">状态右</option>
            <option value="actions">操作区</option>
          </select>
        </div>
        <div className="cc-prop-field"><label>顺序</label><input type="number" value={placement?.order ?? 0} onChange={event => updateCcPlacement(id, { order: +event.target.value })} step={1} className="set-num" min={0} max={99} /></div>
        <div className="cc-prop-field"><label>水平微调</label><input type="number" value={placement?.offsetX ?? 0} onChange={event => upOffset('offsetX', +event.target.value)} step={1} className="set-num" min={-48} max={48} /><span>px</span></div>
        <div className="cc-prop-field"><label>垂直微调</label><input type="number" value={placement?.offsetY ?? 0} onChange={event => upOffset('offsetY', +event.target.value)} step={1} className="set-num" min={-16} max={16} /><span>px</span></div>
        {id !== 'input' && (
          <div className="cc-prop-field"><label>缩放</label>
            <input type="number" value={(theme.ccScale || {})[id] ?? 100}
              onChange={v => setCcScale(id, +v.target.value)}
              step={5} className="set-num" min={50} max={200} /><span>%</span>
          </div>
        )}

        {id === 'input' && <>
          <div className="cc-prop-sec">输入栏设置</div>
          <div className="cc-prop-field"><label>背景色</label><ColorPopover value={theme.inputBg || ''} onChange={v => up('inputBg', v)} /></div>
          <div className="cc-prop-field"><label>文字色</label><ColorPopover value={theme.inputTextColor || ''} onChange={v => up('inputTextColor', v)} /></div>
          <div className="cc-prop-field"><label>字号</label><input type="number" value={theme.inputFontSize} onChange={v => up('inputFontSize', +v.target.value)} step={0.1} className="set-num" min={12} max={22} /></div>
          <div className="cc-prop-field"><label>最小高</label><input type="number" value={theme.inputMinHeight} onChange={v => up('inputMinHeight', +v.target.value)} step={0.1} className="set-num" min={36} max={120} /></div>
          <div className="cc-prop-field"><label>模式</label>
            <div className="set-preset-row">
              {/* 与 Settings 双写保持一致：inputMode 与 inputVariant 必须同步，否则
                  ControlCenter（读 inputMode）与 InputBar（读 inputVariant）会分叉 */}
              <button className={`set-preset-chip ${theme.inputMode === 'default' ? 'active' : ''}`} onClick={() => u('cc', { inputMode: 'default', inputVariant: 'composer' })}>默认</button>
              <button className={`set-preset-chip ${theme.inputMode === 'cli' ? 'active' : ''}`} onClick={() => u('cc', { inputMode: 'cli', inputVariant: 'cli' })}>CLI</button>
            </div>
          </div>
          {theme.inputMode === 'cli' && <>
            <div className="cc-prop-field"><label>线宽</label><input type="number" value={theme.cliLineWidth} onChange={v => up('cliLineWidth', +v.target.value)} step={0.1} className="set-num" min={1} max={6} /></div>
            <div className="cc-prop-field"><label>线色</label><ColorPopover value={theme.cliLineColor || ''} onChange={v => up('cliLineColor', v)} /></div>
            <div className="cc-prop-field"><label>行距</label><input type="number" value={theme.cliLinePadding ?? 6} onChange={v => up('cliLinePadding', +v.target.value)} step={0.1} className="set-num" min={0} max={24} /></div>
          </>}
        </>}

        {id === 'ekg' && <>
          <div className="cc-prop-sec">用量条显示</div>
          <div className="cc-prop-field"><label>仪表类型</label>
            <div className="set-preset-row">
              {(['wave', 'bar', 'ring', 'numeric'] as const).map(s => (
                <button key={s} className={`set-preset-chip ${theme.ccStyle === s ? 'active' : ''}`} onClick={() => up('ccStyle', s)}>
                  {s === 'wave' ? '心电图' : s === 'bar' ? '柱状' : s === 'ring' ? '环形' : '数值'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-prop-field"><label>宽度</label><input type="number" value={theme.ekgWidth} onChange={v => up('ekgWidth', +v.target.value)} step={0.1} className="set-num" min={80} max={400} /></div>
          {theme.ccStyle === 'wave' && <>
            <div className="cc-prop-field"><label>绿色</label><ColorPopover value={theme.ekgGreen || ''} onChange={v => up('ekgGreen', v)} /></div>
            <div className="cc-prop-field"><label>黄色</label><ColorPopover value={theme.ekgYellow || ''} onChange={v => up('ekgYellow', v)} /></div>
            <div className="cc-prop-field"><label>红色</label><ColorPopover value={theme.ekgRed || ''} onChange={v => up('ekgRed', v)} /></div>
          </>}
          {theme.ccStyle === 'bar' && <>
            <div className="cc-prop-field"><label>外壳背景</label><ColorPopover value={theme.barTrackColor || ''} onChange={v => up('barTrackColor', v)} /></div>
            <div className="cc-prop-field"><label>高度</label><input type="number" value={theme.barHeight ?? 10} onChange={v => up('barHeight', +v.target.value)} step={0.1} className="set-num" min={4} max={40} /></div>
            <div className="cc-prop-field"><label>柱子跟随用量</label>
              <div className="set-preset-row">
                <button className={`set-preset-chip ${theme.barFillFollow !== false ? 'active' : ''}`} onClick={() => up('barFillFollow', true)}>三段色</button>
                <button className={`set-preset-chip ${theme.barFillFollow === false ? 'active' : ''}`} onClick={() => up('barFillFollow', false)}>固定色</button>
              </div>
            </div>
            {theme.barFillFollow === false && (
              <div className="cc-prop-field"><label>柱子颜色</label><ColorPopover value={theme.barFillColor || ''} onChange={v => up('barFillColor', v)} /></div>
            )}
          </>}
        </>}

        {id === 'model' && <>
          <div className="cc-prop-sec">模型控件外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['dropdown', 'minimal', 'badge'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.modelVariant === v ? 'active' : ''}`} onClick={() => up('modelVariant', v)}>
                  {v === 'dropdown' ? '下拉' : v === 'minimal' ? '简洁' : '徽章'}
                </button>
              ))}
            </div>
          </div>
        </>}

        {id === 'mode' && <>
          <div className="cc-prop-sec">模式控件外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['pill', 'badge', 'minimal'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.modeVariant === v ? 'active' : ''}`} onClick={() => up('modeVariant', v)}>
                  {v === 'pill' ? '胶囊' : v === 'badge' ? '方括号' : '极简'}
                </button>
              ))}
            </div>
          </div>
          <div className="cc-prop-field"><label>当前</label><span style={{ fontSize: 13, color: liveMode === 'bypass' ? '#FF6B80' : liveMode === 'auto' ? '#FFC107' : liveMode === 'edit' ? '#A2A9E4' : '#999' }}>{liveMode || 'default'}</span></div>
        </>}

        {id === 'send' && <>
          <div className="cc-prop-sec">发送按钮外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['icon', 'square', 'minimal'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.sendVariant === v ? 'active' : ''}`} onClick={() => up('sendVariant', v)}>
                  {v === 'icon' ? '圆形' : v === 'square' ? '方形' : '极简'}
                </button>
              ))}
            </div>
          </div>
        </>}

        {id === 'attach' && <>
          <div className="cc-prop-sec">附件按钮外观</div>
          <div className="cc-prop-field"><label>外观风格</label>
            <div className="set-preset-row">
              {(['icon', 'square', 'minimal'] as const).map(v => (
                <button key={v} className={`set-preset-chip ${theme.attachVariant === v ? 'active' : ''}`} onClick={() => up('attachVariant', v)}>
                  {v === 'icon' ? '圆形' : v === 'square' ? '方形' : '极简'}
                </button>
              ))}
            </div>
          </div>
        </>}
      </div>
      <div className="cc-prop-footer">
        <button className="ps-btn sm" onClick={onExit}>退出自定义</button>
      </div>
    </div>
  )
}