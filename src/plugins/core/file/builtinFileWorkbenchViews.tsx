import { MessageSquare } from 'lucide-react'
import type { FileActivityProps } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import FileTree from '../../../sheets/file/FileTree.tsx'
import WorkspaceSearchPanel from '../../../sheets/file/WorkspaceSearchPanel.tsx'
import GitPanel from '../../../sheets/file/GitPanel.tsx'
import ViewsPanel from '../../../sheets/file/ViewsPanel.tsx'

export function SessionsActivity(props: FileActivityProps) {
  return <div className="file-section-panel file-session-panel"><div className="file-panel-heading"><span>WORKSPACES</span><span className="file-panel-count">{props.sessions.length}</span>{props.targetSessionId && <button type="button" className="file-source-clear" onClick={() => props.onSelectTarget(null)}>清除选择</button>}</div>
    {props.sessions.length === 0 ? <p className="file-section-hint">没有可用会话</p> : <ul className="file-source-list">{props.sessions.map(session => <li key={session.id}><button type="button" className={`file-source-item ${props.targetSessionId === session.id ? 'active' : ''}`} onClick={() => props.onSelectTarget(session.id)} title={session.source}><span className="file-source-icon" aria-hidden="true"><MessageSquare size={15} /></span><span className="file-source-copy"><strong>{session.name}</strong><small>{session.source}</small></span></button></li>)}</ul>}
  </div>
}
export function ExplorerActivity(props: FileActivityProps) { return <FileTree target={props.target} provider={props.fileProvider} activeFile={props.activeFile} onOpen={props.onOpenFile} /> }
export function SearchActivity(props: FileActivityProps) { return <WorkspaceSearchPanel target={props.target} provider={props.fileProvider} onOpenResult={props.onOpenFile} /> }
export function ScmActivity(props: FileActivityProps) { return <GitPanel target={props.target} provider={props.gitProvider} onOpenDiff={props.onOpenDiff} /> }
export function ViewsActivity(props: FileActivityProps) { return <ViewsPanel source={props.target?.source ?? null} context={props.context} onOpenFile={props.onOpenFile} /> }
