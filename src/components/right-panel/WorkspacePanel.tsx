import PanelStatus from './PanelStatus'
import type { WorkspaceEntry, WorkspaceTree, WorkspaceViewState } from './rightPanelTypes'
import './WorkspacePanel.css'

export interface WorkspacePanelProps {
  state: WorkspaceViewState
  onSelect?: (path: string | null) => void
  onExpand?: (path: string) => void
  onRead?: (path: string) => void
}

function WorkspaceTreeNode({ entry, selectedPath, onSelect, onExpand, onRead }: {
  entry: WorkspaceEntry
  selectedPath: string | null
  onSelect?: (path: string | null) => void
  onExpand?: (path: string) => void
  onRead?: (path: string) => void
}) {
  const isSelected = entry.path === selectedPath
  const children = entry.entries ?? []

  return (
    <li className={`workspace-tree-item workspace-tree-item-${entry.kind}`}>
      <button
        type="button"
        className={`workspace-tree-node${isSelected ? ' is-selected' : ''}`}
        aria-pressed={isSelected}
        title={entry.path}
        onClick={() => {
          onSelect?.(entry.path)
          if (entry.kind === 'folder' && entry.expandable && children.length === 0) onExpand?.(entry.path)
          if (entry.kind === 'file') onRead?.(entry.path)
        }}
      >
        <span className="workspace-tree-kind" aria-hidden="true">{entry.kind === 'folder' ? '▾' : '·'}</span>
        <span className="workspace-tree-label">{entry.label}</span>
        <span className="workspace-tree-path">{entry.path}</span>
      </button>
      {children.length > 0 && (
        <ul className="workspace-tree-children">
          {children.map((child) => (
            <WorkspaceTreeNode
              key={child.path}
              entry={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function WorkspaceTreeView({ tree, onSelect, onExpand, onRead }: {
  tree: WorkspaceTree
  onSelect?: (path: string | null) => void
  onExpand?: (path: string) => void
  onRead?: (path: string) => void
}) {
  return (
    <div className="workspace-tree" aria-label="Workspace entries">
      {tree.entries.length > 0 ? (
        <ul className="workspace-tree-list">
          {tree.entries.map((entry) => (
            <WorkspaceTreeNode
              key={entry.path}
              entry={entry}
              selectedPath={tree.selectedPath}
              onSelect={onSelect}
              onExpand={onExpand}
              onRead={onRead}
            />
          ))}
        </ul>
      ) : (
        <div className="workspace-tree-empty">暂无工作区内容</div>
      )}
    </div>
  )
}

function stateTree(state: WorkspaceViewState): WorkspaceTree | undefined {
  return 'tree' in state ? state.tree : undefined
}

export default function WorkspacePanel({ state, onSelect, onExpand, onRead }: WorkspacePanelProps) {
  const tree = stateTree(state)

  return (
    <section className="workspace-panel panel-tab" aria-label="Workspace">
      {state.status === 'no-session' && (
        <PanelStatus kind="empty" title="暂无会话" detail="创建或选择会话后即可查看工作区。" />
      )}
      {state.status === 'unwired' && (
        <PanelStatus kind="empty" title="工作区尚未接入" detail="等待工作区数据源连接。" />
      )}
      {state.status === 'loading' && (
        <PanelStatus kind="loading" title="正在加载工作区" detail="工作区内容加载中。" />
      )}
      {state.status === 'empty' && (
        <PanelStatus kind="empty" title="工作区为空" detail="当前工作区没有可展示的条目。" />
      )}
      {state.status === 'error' && (
        <PanelStatus kind="error" title="工作区加载失败" detail={state.message} />
      )}
      {state.status === 'ready' && tree && <WorkspaceTreeView tree={tree} onSelect={onSelect} onExpand={onExpand} onRead={onRead} />}
      {tree && state.status !== 'ready' && <WorkspaceTreeView tree={tree} onSelect={onSelect} onExpand={onExpand} onRead={onRead} />}
    </section>
  )
}
