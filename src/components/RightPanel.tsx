import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import LogsPanel from './right-panel/LogsPanel'
import PanelStatus from './right-panel/PanelStatus'
import WorkspacePanel from './right-panel/WorkspacePanel'
import { RIGHT_PANEL_TABS } from './right-panel/RightPanelTabs'
import {
  createLogsViewState,
  createWorkspaceViewState,
  transitionLogsView,
  transitionWorkspaceView,
} from './right-panel/rightPanelTypes'
import type { LogsViewState, RightPanelTab, WorkspaceViewState } from './right-panel/rightPanelTypes'
import { normalizeRuntimeLogs } from './right-panel/logsApi'
import { mergeWorkspaceEntries, normalizeWorkspaceText, workspaceTreeFromEntries } from './right-panel/workspaceApi'
import { useIdentityStore } from '../identityStore'
import './RightPanel.css'

interface RightPanelProps {
  sessionId: string | null
  onClose: () => void
}

export default function RightPanel({ sessionId, onClose }: RightPanelProps) {
  const [tab, setTab] = useState<RightPanelTab>('workspace')
  // 只订阅目标会话对象：其他会话的更新不再重渲染右栏
  const sessionSource = useIdentityStore(state => sessionId ? state.sessions.find(item => item.id === sessionId)?.source ?? null : null)
  const [workspaceState, setWorkspaceState] = useState<WorkspaceViewState>(() => (
    createWorkspaceViewState(sessionSource)
  ))
  const [logsState, setLogsState] = useState<LogsViewState>(() => (
    createLogsViewState(sessionSource ? { sessionId: sessionId as string, source: sessionSource } : null)
  ))
  const requestGeneration = useRef(0)

  useEffect(() => {
    setWorkspaceState(createWorkspaceViewState(sessionSource))
    requestGeneration.current += 1
  }, [sessionSource])

  useEffect(() => {
    setLogsState(createLogsViewState(
      sessionSource ? { sessionId: sessionId as string, source: sessionSource } : null,
    ))
  }, [sessionId, sessionSource])

  useEffect(() => {
    if (!sessionSource) return
    let disposed = false
    setWorkspaceState(state => transitionWorkspaceView(state, { type: 'begin-loading' }))
    invoke<unknown>('list_workspace_entries', { source: sessionSource })
      .then(entries => {
        if (disposed) return
        const tree = workspaceTreeFromEntries(entries)
        setWorkspaceState(state => transitionWorkspaceView(state, { type: 'loaded', tree }))
      })
      .catch(error => {
        if (disposed) return
        setWorkspaceState(state => transitionWorkspaceView(state, {
          type: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }))
      })
    return () => { disposed = true }
  }, [sessionSource])

  useEffect(() => {
    if (!sessionSource) return
    let disposed = false
    setLogsState(state => transitionLogsView(state, { type: 'begin-loading' }))
    invoke<unknown>('list_runtime_logs', { query: { session: sessionSource } })
      .then(payload => {
        if (disposed) return
        setLogsState(state => transitionLogsView(state, { type: 'loaded', entries: normalizeRuntimeLogs(payload) }))
      })
      .catch(error => {
        if (disposed) return
        setLogsState(state => transitionLogsView(state, {
          type: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }))
      })
    return () => { disposed = true }
  }, [sessionSource])

  const expandWorkspace = (path: string) => {
    if (!sessionSource) return
    const generation = ++requestGeneration.current
    invoke<unknown>('list_workspace_entries', { source: sessionSource, relativePath: path })
      .then(entries => {
        if (generation !== requestGeneration.current) return
        const children = workspaceTreeFromEntries(entries).entries
        setWorkspaceState(state => {
          if (!('tree' in state) || !state.tree) return state
          const tree = { ...state.tree, entries: mergeWorkspaceEntries(state.tree.entries, path, children) }
          return transitionWorkspaceView(state, { type: 'loaded', tree })
        })
      })
      .catch(error => {
        if (generation !== requestGeneration.current) return
        setWorkspaceState(state => transitionWorkspaceView(state, {
          type: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }))
      })
  }

  const readWorkspaceText = (path: string) => {
    if (!sessionSource) return
    const generation = ++requestGeneration.current
    invoke<unknown>('read_workspace_text', { source: sessionSource, relativePath: path })
      .then(payload => {
        if (generation !== requestGeneration.current) return
        const normalized = normalizeWorkspaceText(payload)
        if (!normalized) throw new Error('工作区文本响应格式无效')
        setWorkspaceState(state => transitionWorkspaceView(state, { type: 'loaded-text', text: normalized }))
      })
      .catch(error => {
        if (generation !== requestGeneration.current) return
        setWorkspaceState(state => transitionWorkspaceView(state, {
          type: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }))
      })
  }
  // 文本预览真值唯一来源：视图状态机的 selectedText（loaded-text 事件写入），
  // 不再与本地 state 双份维护
  const selectedText = workspaceState.status === 'ready' || workspaceState.status === 'error'
    ? workspaceState.selectedText
    : undefined

  return (
    <aside className="right-panel">
      <div className="right-header">
        <div className="right-tabs">
          {RIGHT_PANEL_TABS.map(item => (
            <button key={item.id} className={`right-tab ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}>{item.label}</button>
          ))}
        </div>
        <button className="right-close" onClick={onClose} aria-label="关闭右栏">✕</button>
      </div>

      <div className="right-body">
        {tab === 'workspace' && (
          <>
            <WorkspacePanel
              state={workspaceState}
              onSelect={path => setWorkspaceState(state => transitionWorkspaceView(state, { type: 'select', path }))}
              onExpand={expandWorkspace}
              onRead={readWorkspaceText}
            />
            {selectedText && (
              <section className="workspace-text-preview" aria-label="文件内容预览">
                <div className="workspace-text-preview-header">
                  <strong>{selectedText.relativePath}</strong>
                  <span>{selectedText.bytesRead}/{selectedText.totalBytes} bytes{ selectedText.truncated ? ' · 已截断' : '' }</span>
                </div>
                <pre>{selectedText.content}</pre>
              </section>
            )}
          </>
        )}
        {tab === 'logs' && <LogsPanel state={logsState} />}
        {tab === 'activity' && (
          <div className="panel-tab">
            <PanelStatus kind="empty" title="活动能力尚未接入" detail="活动面板将在后端接口就绪后开启" />
          </div>
        )}
        {tab === 'changes' && (
          <div className="panel-tab">
            <PanelStatus kind="empty" title="变更能力尚未接入" detail="Git 只读能力暂未接入，完成后将在此显示变更摘要" />
          </div>
        )}
      </div>
    </aside>
  )
}
