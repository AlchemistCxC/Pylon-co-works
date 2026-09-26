import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { open } from '@tauri-apps/plugin-dialog'
import { Folder, FolderOpen, Inbox, Pin, PinOff, Plus, Settings, X } from 'lucide-react'
import { formatTime } from '../../utils/relativeTime'
import { isAbsolutePath } from '../../domains/workspace/workspaceEntities'
import CwdSettingsPanel from '../settings/CwdSettingsPanel'
import { useModalOverlayVeil } from '../../app/modalOverlayStore'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'
import { useBlockActionHandler } from './useBlockActionHandler.ts'

function workspaceNameFromPath(rootPath: string): string {
  const withoutTrailingSeparators = rootPath.replace(/[\\/]+$/, '')
  const finalSegment = withoutTrailingSeparators.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return finalSegment.replace(/:$/, '') || '新工作区'
}

const WORKSPACE_TREE_STATE_KEY = 'pylon-workspace-tree:v1'

/** 无 cwd 会话分组的伪 id，与真实工作区 id 共用一个折叠集合。 */
const LOOSE_GROUP_ID = '__loose__'
const LOOSE_GROUP_LABEL = '无工作区'

function loadCollapsedWorkspaces(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_TREE_STATE_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * 会话区块。一个区块同时承载两个族群，按 cwd 分组：
 * 挂在工作区上的会话归各自工作区组，没有工作区的（旧模型的「聊天」）落在**最底部的
 * 无 cwd 组**。
 *
 * 排版按「一行一条」收敛：组头是单行的 `文件夹 + 名称`（目录路径降级为 tooltip，
 * 不再占一行 9.5px 的不可读小字）；会话行也是单行 `名称 + 右对齐时间`，不再两行堆叠。
 * 组内不再渲染「暂无会话」提示——空组本身已经说明了这件事，逐组提示只贡献高度。
 *
 * 本组件**不画区块头**——标题、折叠钮、头部动作都由宿主渲染（见 `Sidebar.tsx`）。
 */
export default function SessionsPanel(props: AgentSidebarContributionProps) {
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

  // 区块头的「工作区」按钮由宿主渲染，语义在这里——只有本组件知道要弹目录选择器。
  useBlockActionHandler(props, actionId => {
    if (actionId === 'new-workspace') void pickWorkspaceDirectory()
  })

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

  const toggleCwd = (groupId: string) => setCollapsedCwd(previous => {
    const next = new Set(previous)
    if (next.has(groupId)) next.delete(groupId)
    else next.add(groupId)
    return next
  })

  const editingWorkspace = props.workspaces.find(workspace => workspace.id === editingCwdId)
  // #309：工作区设置弹窗是覆盖主区的模态层——打开期间让原生子视图暂时隐藏。
  useModalOverlayVeil('workspace-settings', Boolean(editingWorkspace))
  // 会话列表**不再被搜索过滤**：搜索已是独立模块、自己呈现结果（一个查询驱动两处呈现
  // 会让人分不清哪边是「结果」）。这里只负责分组与选择。
  // (#260-C10) 一次遍历完成「按工作区分组 + 无工作区组」，组内保持 props.sessions
  // 原序——与旧的 loose filter + 每工作区一次全量 filter 逐条等价，O(会话+工作区)。
  const sessionsByWorkspace = new Map<string, (typeof props.sessions)[number][]>()
  const looseSessions: (typeof props.sessions)[number][] = []
  for (const session of props.sessions) {
    if (session.workspaceId) {
      const group = sessionsByWorkspace.get(session.workspaceId)
      if (group) group.push(session)
      else sessionsByWorkspace.set(session.workspaceId, [session])
    } else {
      looseSessions.push(session)
    }
  }
  const liveGenerating = new Set(props.liveGeneratingSources)

  /**
   * 会话行：`[置顶] 名称 … ● 时间 / 设置`。
   *
   * 两个按钮**平时不可见**，悬停/聚焦才显形（与组头动作同一手法：opacity + visibility
   * 同步门控，未显形时不参与命中测试）。用户点名过「四个按钮常驻会把名字挤成 sessio…」，
   * 也点名过现在这两个按钮「完全不见了」——所以除了显形门控，还给了足够的对比度
   * （旧写法叠了 `opacity:.62` 与 `--text-dim`，等于两层压暗）。
   *
   * 置顶图标占的是**工作区图标那一列**（15px 槽），会话名因此与工作区名同列——见 CSS。
   */
  const renderSession = (session: (typeof props.sessions)[number]) => {
    const pinned = session.pinned === true
    return (
      <div key={session.id} role="treeitem" tabIndex={0} className={`session-item ${props.activeSessionId === session.id ? 'active' : ''}`}
        data-pinned={pinned ? 'true' : undefined}
        onClick={() => props.onSelectSession(session.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelectSession(session.id) }
          if (event.key === 'F2') { event.preventDefault(); setRenaming(session.id); setRenameValue(session.name) }
        }}
        onDoubleClick={event => { event.stopPropagation(); setRenaming(session.id); setRenameValue(session.name) }}>
        <button
          type="button"
          className="session-pin"
          aria-pressed={pinned}
          title={pinned ? '取消置顶' : '置顶会话（移到本工作区最前）'}
          aria-label={pinned ? `取消置顶 ${session.name}` : `置顶 ${session.name}`}
          onClick={event => { event.stopPropagation(); props.onToggleSessionPin?.(session.id) }}
        >
          {pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
        </button>
        {renaming === session.id ? (
          <input className="session-rename-input" value={renameValue} autoFocus
            onChange={event => setRenameValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && renameValue.trim()) { props.onRenameSession(session.id, renameValue.trim()); setRenaming(null) }
              if (event.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => setRenaming(null)} onClick={event => event.stopPropagation()} />
        ) : <span className="session-name">{session.name}</span>}
        {/* 运行指示点跟着时间走（不再占名字左边的列）：那一列让位给置顶图标，
            名字才能与工作区名对齐。 */}
        <span className="session-dot" data-running={liveGenerating.has(session.source) ? 'true' : undefined} />
        {/* 时间与设置钮共用一个流内格子：默认只显示时间，悬停/聚焦时按钮淡入顶替。 */}
        <span className="session-tail">
          <span className="session-meta">{formatTime(session.lastReplyAt || session.lastActiveAt || session.createdAt)}</span>
          <span className="session-actions">
            <button className="session-action" onClick={event => { event.stopPropagation(); props.onOpenSessionSettings(session.id) }} title="会话设置（重命名 / 归档 / 导出）" aria-label={session.name + " 会话设置"}><Settings size={13} aria-hidden="true" /></button>
          </span>
        </span>
      </div>
    )
  }

  const renderGroupHead = (
    groupId: string,
    label: string,
    rootPath: string,
    icon: 'folder' | 'inbox',
    onAdd: () => void,
    onSettings?: () => void,
  ) => {
    const folded = collapsedCwd.has(groupId)
    const GroupIcon = icon === 'inbox' ? Inbox : (folded ? Folder : FolderOpen)
    return (
      <div className="cwd-group-head">
        {/* 折叠**没有**独立按钮：整个组头就是开关（用户要求去掉最左侧那个 `>`）。
            目录路径保留为 tooltip。 */}
        <button className="cwd-group-toggle" type="button" onClick={() => toggleCwd(groupId)} title={rootPath} aria-label={`${folded ? '展开' : '折叠'} ${label}`} aria-expanded={!folded}>
          <span className="cwd-group-folder" aria-hidden="true"><GroupIcon size={15} /></span>
          <span className="cwd-group-name">{label}</span>
        </button>
        <div className="cwd-group-meta">
          <span className="cwd-group-actions">
            <button className="cwd-group-add" onClick={event => { event.stopPropagation(); onAdd() }} title={`在 ${label} 中新建会话`} aria-label={`在 ${label} 中新建会话`}><Plus size={13} aria-hidden="true" /></button>
            {onSettings && <button className="cwd-group-add cwd-group-settings" onClick={event => { event.stopPropagation(); onSettings() }} title={`${label} 工作区设置`} aria-label={`${label} 工作区设置`}><Settings size={13} aria-hidden="true" /></button>}
          </span>
        </div>
      </div>
    )
  }

  const renderGroup = (groupId: string, sessions: readonly (typeof props.sessions)[number][], head: React.ReactNode) => {
    const folded = collapsedCwd.has(groupId)
    return (
      <div className="cwd-group" key={groupId} role="treeitem" aria-expanded={!folded}>
        {head}
        {/* 空组不渲染会话容器：它自带 1px/2px 内边距，展开态比折叠态高几像素，
            于是「点空工作区的折叠/展开」会引起一次细微跳动（用户实机报的）。 */}
        {sessions.length > 0 && (
          <div className={`cwd-group-sessions${folded ? ' is-collapsed' : ''}`} role="group" aria-hidden={folded}>
            <div className="cwd-group-sessions-inner">{sessions.map(renderSession)}</div>
          </div>
        )}
      </div>
    )
  }

  const hasAnything = props.workspaces.length > 0 || looseSessions.length > 0

  return (
    <>
      <div className="session-list" role="tree" aria-label="工作区与会话">
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

        {props.workspaces.map(workspace => renderGroup(
          workspace.id,
          sessionsByWorkspace.get(workspace.id) ?? [],
          renderGroupHead(
            workspace.id, workspace.name, workspace.rootPath, 'folder',
            () => props.onCreateWorkspaceSession(workspace.id),
            () => setEditingCwdId(workspace.id),
          ),
        ))}

        {hasAnything && renderGroup(
          LOOSE_GROUP_ID,
          looseSessions,
          renderGroupHead(
            LOOSE_GROUP_ID, LOOSE_GROUP_LABEL, '未绑定目录的会话', 'inbox',
            () => props.onCreateLooseSession(),
          ),
        )}

        {!hasAnything && (
          <div className="workspace-empty">
            <Folder size={24} aria-hidden="true" />
            <strong>从一个文件夹开始</strong>
            <span>工作区会把项目与它的 Agent 会话放在一起。</span>
            <button type="button" className="settings-action primary" disabled={pickingCwd} onClick={() => void pickWorkspaceDirectory()}>选择文件夹</button>
          </div>
        )}
      </div>
      <Dialog.Root open={Boolean(editingWorkspace)} onOpenChange={open => { if (!open) setEditingCwdId(null) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          {editingWorkspace && <Dialog.Content className="dialog-content settings-surface agent-settings-dialog cwd-settings-dialog" aria-describedby="cwd-settings-description">
            <Dialog.Title asChild>
              <header className="session-settings-header settings-dialog-header">
                <div>
                  <h3 className="settings-dialog-title">工作区设置</h3>
                  <p id="cwd-settings-description" className="settings-dialog-description">管理工作区目录、能力与默认上下文。</p>
                </div>
                <Dialog.Close className="modal-close settings-dialog-close" aria-label="关闭工作区设置"><X size={16} aria-hidden="true" /></Dialog.Close>
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
