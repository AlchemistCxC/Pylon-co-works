import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { open } from '@tauri-apps/plugin-dialog'
import { Archive, ChevronDown, ChevronRight, Download, Folder, FolderOpen, Plus, Settings, Trash2 } from 'lucide-react'
import { formatTime } from '../../utils'
import { isAbsolutePath } from '../../workspaceEntities'
import CwdSettingsPanel from '../settings/CwdSettingsPanel'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

function workspaceNameFromPath(rootPath: string): string {
  const withoutTrailingSeparators = rootPath.replace(/[\\/]+$/, '')
  const finalSegment = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return finalSegment.replace(/:$/, '') || '新工作区'
}

const WORKSPACE_TREE_STATE_KEY = 'pylon-workspace-tree:v1'

function loadCollapsedWorkspaces(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_TREE_STATE_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export default function WorkspacesPanel(props: AgentSidebarContributionProps) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [newCwdName, setNewCwdName] = useState('')
  const [newCwdRoot, setNewCwdRoot] = useState('')
  const [cwdError, setCwdError] = useState<string | null>(null)
  const [showNewCwd, setShowNewCwd] = useState(false)
  const [pickingCwd, setPickingCwd] = useState(false)
  const [collapsedCwd, setCollapsedCwd] = useState<Set<string>>(loadCollapsedWorkspaces)
  const [editingCwdId, setEditingCwdId] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_TREE_STATE_KEY, JSON.stringify([...collapsedCwd]))
    } catch {
      // 展开状态属于易失 UI 偏好，存储不可用时保持当前会话可用。
    }
  }, [collapsedCwd])

  const pickWorkspaceDirectory = async () => {
    setPickingCwd(true)
    setCwdError(null)
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择工作区文件夹',
      })
      if (typeof selected !== 'string') return
      setNewCwdRoot(selected)
      setNewCwdName(workspaceNameFromPath(selected))
      setShowNewCwd(true)
    } catch {
      setShowNewCwd(true)
      setCwdError('无法打开文件夹选择器，请重试')
    } finally {
      setPickingCwd(false)
    }
  }

  const createWorkspace = async () => {
    const name = newCwdName.trim()
    const root = newCwdRoot.trim()
    if (!name) { setCwdError('请输入工作区名称'); return }
    if (!root || !isAbsolutePath(root)) { setCwdError('工作目录必须是绝对路径'); return }
    setCwdError(null)
    try {
      await props.onCreateWorkspace(name, root)
      setNewCwdName('')
      setNewCwdRoot('')
      setShowNewCwd(false)
    } catch (error) {
      setCwdError(error instanceof Error ? error.message : '创建工作区失败')
    }
  }

  const cancelCreateWorkspace = () => {
    setShowNewCwd(false)
    setNewCwdName('')
    setNewCwdRoot('')
    setCwdError(null)
  }

  const toggleCwd = (workspaceId: string) => setCollapsedCwd(previous => {
    const next = new Set(previous)
    if (next.has(workspaceId)) next.delete(workspaceId)
    else next.add(workspaceId)
    return next
  })

  const editingWorkspace = props.workspaces.find(workspace => workspace.id === editingCwdId)

  return (
    <>
    <section className="sidebar-section sidebar-mode-panel" aria-label="工作会话">
      <div className="sidebar-section-head">
        <div className="sidebar-section-title"><span>工作</span><span className="sidebar-section-count">{props.sessions.length}</span></div>
        <button className="sidebar-section-action sidebar-section-action-wide" disabled={pickingCwd} onClick={() => void pickWorkspaceDirectory()} title="新建工作区" aria-label="新建工作区">
          <Plus size={14} aria-hidden="true" />
          <span>{pickingCwd ? '选择中…' : '工作区'}</span>
        </button>
      </div>
      <div className="work-list" role="tree" aria-label="工作区与会话">
        {showNewCwd && (
          <div className="cwd-new">
            <input className="cwd-new-input" aria-label="工作区名称" placeholder="工作区名称" value={newCwdName} onChange={event => setNewCwdName(event.target.value)} />
            <div className="cwd-new-directory">
              <span className="cwd-new-directory-path" title={newCwdRoot}>{newCwdRoot || '尚未选择文件夹'}</span>
              <button className="settings-action" type="button" disabled={pickingCwd} onClick={() => void pickWorkspaceDirectory()} aria-label="重新选择工作区文件夹">更换…</button>
            </div>
            {cwdError && <div className="set-hint" role="alert">{cwdError}</div>}
            <div className="cwd-new-actions">
              <button className="settings-action primary" type="button" onClick={() => void createWorkspace()}>创建</button>
              <button className="settings-action" type="button" onClick={cancelCreateWorkspace}>取消</button>
            </div>
          </div>
        )}
        {props.workspaces.map(workspace => {
          const normalizedQuery = props.query.trim().toLowerCase()
          const workspaceMatches = normalizedQuery.length > 0 && `${workspace.name} ${workspace.rootPath}`.toLowerCase().includes(normalizedQuery)
          const allBound = props.sessions.filter(session => session.workspaceId === workspace.id)
          const bound = allBound.filter(session => !normalizedQuery || workspaceMatches || session.name.toLowerCase().includes(normalizedQuery))
          if (normalizedQuery && bound.length === 0 && !workspaceMatches) return null
          const folded = normalizedQuery ? false : collapsedCwd.has(workspace.id)
          return (
            <div className="cwd-group" key={workspace.id} role="treeitem" aria-expanded={!folded}>
              <div className="cwd-group-head">
                <button className="cwd-group-toggle" type="button" onClick={() => toggleCwd(workspace.id)} aria-label={`${folded ? '展开' : '折叠'} ${workspace.name}`}>
                  <span className="cwd-group-arrow" aria-hidden="true">{folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</span>
                  <span className="cwd-group-folder" aria-hidden="true">{folded ? <Folder size={16} /> : <FolderOpen size={16} />}</span>
                  <span className="cwd-group-identity"><span className="cwd-group-name">{workspace.name}</span><span className="cwd-group-root" title={workspace.rootPath}>{workspace.rootPath}</span></span>
                </button>
                <span className="cwd-group-count" aria-label={`${allBound.length} 个会话`}>{allBound.length}</span>
                <div className="cwd-group-actions">
                  <button className="cwd-group-add" onClick={event => { event.stopPropagation(); props.onCreateWorkspaceSession(workspace.id) }} title={`在 ${workspace.name} 中新建会话`} aria-label={`在 ${workspace.name} 中新建会话`}><Plus size={14} aria-hidden="true" /></button>
                  <button className="cwd-group-add cwd-group-settings" onClick={event => { event.stopPropagation(); setEditingCwdId(workspace.id) }} title={`${workspace.name} 工作区设置`} aria-label={`${workspace.name} 工作区设置`}><Settings size={14} aria-hidden="true" /></button>
                </div>
              </div>
              <div className={`cwd-group-sessions${folded ? ' is-collapsed' : ''}`} role="group" aria-hidden={folded}>
                <div className="cwd-group-sessions-inner">
                {bound.map(session => (
                  <div key={session.id} role="treeitem" tabIndex={0} className={`session-item cwd-session-item ${props.activeSessionId === session.id ? 'active' : ''}`}
                    onClick={() => props.onSelectSession(session.id)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelectSession(session.id) }
                      if (event.key === 'F2') { event.preventDefault(); setRenaming(session.id); setRenameValue(session.name) }
                    }}
                    onDoubleClick={event => { event.stopPropagation(); setRenaming(session.id); setRenameValue(session.name) }}>
                    <span className="session-dot" data-running={props.liveGeneratingSources.includes(session.source) ? 'true' : undefined} />
                    <div className="session-info">
                      {renaming === session.id ? (
                        <input className="session-rename-input" value={renameValue} autoFocus
                          onChange={event => setRenameValue(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' && renameValue.trim()) { props.onRenameSession(session.id, renameValue.trim()); setRenaming(null) }
                            if (event.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={() => setRenaming(null)} onClick={event => event.stopPropagation()} />
                      ) : <div className="session-name">{session.name}</div>}
                      <div className="session-meta">{formatTime(session.lastReplyAt || session.lastActiveAt || session.createdAt)}</div>
                    </div>

                    <button className="session-action" onClick={event => { event.stopPropagation(); props.onOpenSessionSettings(session.id) }} title="会话设置" aria-label={session.name + " 会话设置"}><Settings size={13} aria-hidden="true" /></button>
                    <button className="session-action" onClick={event => { event.stopPropagation(); void props.onExportSession?.(session.id) }} title="导出会话" aria-label={session.name + " 导出"}><Download size={13} aria-hidden="true" /></button>
                    <button className="session-action" onClick={event => { event.stopPropagation(); void props.onArchiveSession?.(session.id) }} title="归档会话" aria-label={session.name + " 归档"}><Archive size={13} aria-hidden="true" /></button>
                    <button className="session-action danger" onClick={event => { event.stopPropagation(); void props.onDeleteSession(session.id) }} title="删除会话" aria-label={"删除 " + session.name}><Trash2 size={13} aria-hidden="true" /></button>
                  </div>
                ))}
                {bound.length === 0 && <div className="session-empty cwd-session-empty">暂无会话，点击上方＋开始</div>}
                </div>
              </div>
            </div>
          )
        })}
        {props.workspaces.length === 0 && (
          <div className="workspace-empty">
            <Folder size={24} aria-hidden="true" />
            <strong>从一个文件夹开始</strong>
            <span>工作区会把项目与它的 Agent 会话放在一起。</span>
            <button type="button" className="settings-action primary" disabled={pickingCwd} onClick={() => void pickWorkspaceDirectory()}>选择文件夹</button>
          </div>
        )}
      </div>
    </section>
    <Dialog.Root open={Boolean(editingWorkspace)} onOpenChange={open => { if (!open) setEditingCwdId(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        {editingWorkspace && <Dialog.Content className="dialog-content settings-surface cwd-settings-dialog" aria-describedby="cwd-settings-description">
          <Dialog.Title asChild>
            <header className="session-settings-header settings-dialog-header">
              <div>
                <h3 className="settings-dialog-title">工作区设置</h3>
                <p id="cwd-settings-description" className="settings-dialog-description">管理工作区目录、能力与默认上下文。</p>
              </div>
              <Dialog.Close className="modal-close settings-dialog-close" aria-label="关闭工作区设置">✕</Dialog.Close>
            </header>
          </Dialog.Title>
          <div className="cwd-settings-dialog-identity">
            <FolderOpen size={16} aria-hidden="true" />
            <strong>{editingWorkspace.name}</strong>
            <span title={editingWorkspace.rootPath}>{editingWorkspace.rootPath}</span>
          </div>
          <CwdSettingsPanel workspace={editingWorkspace} onClose={() => setEditingCwdId(null)} showHeader={false} />
        </Dialog.Content>}
      </Dialog.Portal>
    </Dialog.Root>
    </>
  )
}
