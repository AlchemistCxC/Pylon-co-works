import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useRuntimeStore } from '../../runtimeStore'
import { useIdentityStore } from '../../identityStore'
import { reportRuntimeError } from '../../runtimeError'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { buildDispatchMessage, type DispatchSelection } from '../../domains/fileDispatch/dispatchMessage.ts'
import { lineFromDataNode, normalizeSelectionRange } from './selectionCapture.ts'

/**
 * DispatchBar — 发令指令栏（W2-08，§4.1）。
 *
 * 折叠态（无选中）/展开态（chip + 输入 + 发送）：DOM selectionchange 捕获选区
 * （data-line → 1-based 行号）；发送调 send_message 显式 source + persona:''；
 * 调用发出后（invoke 同步创建成功）清 instruction 保留选区；错误内联。目标会话
 * 生成中仅提示不禁用（send_message 阻塞语义由后端串行化）。
 *
 * OWNER-02（§5.8）：send_message 载荷携带显式 agentId——优先取 context（sheet 绑定
 * Agent，I01-W3）；context 缺失时回退 Session owner（identityStore 中 source 唯一命中）；
 * 仍无法确定则拒绝发送（不串线）。
 */
export default function DispatchBar({
  targetSource,
  context,
  filePath,
  selection,
  content,
  instruction,
  onInstructionChange,
  onSelectionChange,
  onClearSelection,
}: {
  targetSource: string | null
  context?: { agentId: string; source: string } | null
  filePath: string | null
  selection: DispatchSelection | null
  content: string
  instruction: string
  onInstructionChange: (value: string) => void
  onSelectionChange: (selection: DispatchSelection | null) => void
  onClearSelection: () => void
}) {
  const [error, setError] = useState('')
  // selector 内完成 includes → 返回 boolean（稳定）；`|| []` 放 hook 外会返回新引用触发 #185
  const generating = useRuntimeStore(s => (s.liveGeneratingSources ?? []).includes(targetSource || ''))

  // 选区捕获：selectionchange 时若 anchor/focus 落在代码视图 data-line 上 → 更新 selection
  useEffect(() => {
    const capture = () => {
      const domSelection = window.getSelection()
      if (!domSelection || domSelection.rangeCount === 0) return
      const anchorLine = lineFromDataNode(domSelection.anchorNode)
      const focusLine = lineFromDataNode(domSelection.focusNode)
      const range = normalizeSelectionRange(anchorLine, focusLine)
      if (range && filePath) onSelectionChange(range)
    }
    window.addEventListener('selectionchange', capture)
    return () => window.removeEventListener('selectionchange', capture)
  }, [filePath, onSelectionChange])

  const send = async () => {
    setError('')
    if (!targetSource || !filePath || !instruction.trim()) return
    // OWNER-02：owner agentId 从 sheet context 或 Session owner 解析（绝不取 activeAgent）。
    const ownerSession = (() => {
      const matches = useIdentityStore.getState().sessions.filter(s =>
        s.source === targetSource && (!context?.agentId || s.agentId === context.agentId))
      return matches.length === 1 ? matches[0] : undefined
    })()
    if (!ownerSession) {
      setError('无法确定目标会话的完整归属')
      return
    }
    const message = buildDispatchMessage({
      filePath,
      selection,
      instruction,
      content,
      truncated: false,
    })
    try {
      await createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).sendMessage({ agentId: ownerSession.agentId, profileId: ownerSession.profileId, source: targetSource, content: message, persona: '', sessionPrompt: '', attachments: [] })
      // invoke 已发出（同步创建成功即清）——不等 resolve，保留选区
      onInstructionChange('')
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err)
      setError(messageText)
      reportRuntimeError('发送指令', err)
    }
  }

  if (!filePath) {
    return (
      <div className="dispatch-bar dispatch-bar-collapsed">
        <span className="dispatch-target">{targetSource || '未指向会话'}</span>
        <span className="dispatch-hint">先选中文件或框选代码</span>
      </div>
    )
  }

  return (
    <div className="dispatch-bar">
      <span className="dispatch-target">{targetSource || '未指向会话'}</span>
      <span className="dispatch-chip" title={filePath}>
        📄 {filePath}
        {selection && <span className="dispatch-chip-lines"> L{selection.startLine}-L{selection.endLine}</span>}
        {!selection && <span className="dispatch-chip-lines"> 整文件</span>}
        <button type="button" className="dispatch-chip-clear" onClick={onClearSelection} aria-label="清除选中">✕</button>
      </span>
      <input
        className="dispatch-input"
        type="text"
        placeholder="输入指令…"
        value={instruction}
        onChange={event => { onInstructionChange(event.target.value); setError('') }}
        onKeyDown={event => { if (event.key === 'Enter') void send() }}
        aria-label="发令指令"
      />
      <button
        type="button"
        className="dispatch-send"
        onClick={() => void send()}
        disabled={!targetSource || !instruction.trim()}
      >
        发送
      </button>
      {generating && <span className="dispatch-generating">生成中，消息将排队</span>}
      {error && <span className="dispatch-error" role="alert">{error}</span>}
    </div>
  )
}
