import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import LogsPanel from './right-panel/LogsPanel'
import ReservedTab from './right-panel/ReservedTab'
import WorkspacePanel from './right-panel/WorkspacePanel'
import { RIGHT_PANEL_TABS } from './right-panel/RightPanelTabs'
import {
  createLogsViewState,
  createWorkspaceViewState,
  resolveSessionSource,
  transitionLogsView,
  transitionWorkspaceView,
} from './right-panel/rightPanelTypes'
import type { LogsViewState, RightPanelTab, WorkspaceViewState } from './right-panel/rightPanelTypes'
import { normalizeRuntimeLogs } from './right-panel/logsApi'
import { mergeWorkspaceEntries, normalizeWorkspaceText, workspaceTreeFromEntries } from './right-panel/workspaceApi'
import { useStore } from '../store'
import './RightPanel.css'

interface RightPanelProps {
  sessionId: string | null
  onClose: () => void
}

export default function RightPanel({ sessionId, onClose }: RightPanelProps) {
  const [tab, setTab] = useState<RightPanelTab>('workspace')
  const sessions = useStore(state => state.sessions)
  const sessionSource = resolveSessionSource(sessionId, sessions)
  const [workspaceState, setWorkspaceState] = useState<WorkspaceViewState>(() => (
    createWorkspaceViewState(sessionSource)
  ))
  const [logsState, setLogsState] = useState<LogsViewState>(() => (
    createLogsViewState(sessionSource ? { sessionId: sessionId as string, source: sessionSource } : null)
  ))
  const [textPreview, setTextPreview] = useState<import('./right-panel/rightPanelTypes').WorkspaceTextPreview | null>(null)
  const requestGeneration = useRef(0)

  useEffect(() => {
    setWorkspaceState(createWorkspaceViewState(sessionSource))
    setTextPreview(null)
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
        setTextPreview(normalized)
      })
      .catch(error => {
        if (generation !== requestGeneration.current) return
        setWorkspaceState(state => transitionWorkspaceView(state, {
          type: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }))
      })
  }
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
            {textPreview && (
              <section className="workspace-text-preview" aria-label="文件内容预览">
                <div className="workspace-text-preview-header">
                  <strong>{textPreview.relativePath}</strong>
                  <span>{textPreview.bytesRead}/{textPreview.totalBytes} bytes{ textPreview.truncated ? ' · 已截断' : '' }</span>
                </div>
                <pre>{textPreview.content}</pre>
              </section>
            )}
          </>
        )}
        {tab === 'logs' && <LogsPanel state={logsState} />}
        {tab === 'reserved-1' && <ReservedTab title="预留页面一" detail="此页面暂未定义功能。" />}
        {tab === 'reserved-2' && <ReservedTab title="预留页面二" detail="此页面暂未定义功能。" />}
      </div>
    </aside>
  )
}
