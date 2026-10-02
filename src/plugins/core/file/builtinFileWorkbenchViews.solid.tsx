/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import { LucideIcon } from '../../../components/LucideIcon.solid.tsx'
import type { FileActivityProps } from '../../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import FileTree from '../../../sheets/file/FileTree.solid.tsx'
import WorkspaceSearchPanel from '../../../sheets/file/WorkspaceSearchPanel.solid.tsx'
import GitPanel from '../../../sheets/file/GitPanel.solid.tsx'
import ViewsPanel from '../../../sheets/file/ViewsPanel.solid.tsx'

/**
 * builtinFileWorkbenchViews — file activity 五件套的 Solid 实体（#515 贡献面翻转：
 * 原 React 版 builtinFileWorkbenchViews.tsx 同批退役；DOM class/文案逐项保持）。
 */

export function SessionsActivity(props: FileActivityProps) {
  return <div class="file-section-panel file-session-panel"><div class="file-panel-heading"><span>WORKSPACES</span><span class="file-panel-count">{props.sessions.length}</span><Show when={props.targetSessionId}><button type="button" class="file-source-clear" onClick={() => props.onSelectTarget(null)}>清除选择</button></Show></div>
    <Show when={props.sessions.length > 0} fallback={<p class="file-section-hint">没有可用会话</p>}>
      <ul class="file-source-list"><For each={props.sessions}>{session => (
        <li><button type="button" class={`file-source-item ${props.targetSessionId === session.id ? 'active' : ''}`} onClick={() => props.onSelectTarget(session.id)} title={session.source}><span class="file-source-icon" aria-hidden="true"><LucideIcon name="MessageSquare" size={15} /></span><span class="file-source-copy"><strong>{session.name}</strong><small>{session.source}</small></span></button></li>
      )}</For></ul>
    </Show>
  </div>
}
export function ExplorerActivity(props: FileActivityProps) { return <FileTree target={props.target} provider={props.fileProvider} activeFile={props.activeFile} onOpen={props.onOpenFile} /> }
export function SearchActivity(props: FileActivityProps) { return <WorkspaceSearchPanel target={props.target} provider={props.fileProvider} onOpenResult={props.onOpenFile} /> }
export function ScmActivity(props: FileActivityProps) { return <GitPanel target={props.target} provider={props.gitProvider} onOpenDiff={props.onOpenDiff} /> }
export function ViewsActivity(props: FileActivityProps) { return <ViewsPanel source={props.target?.source ?? null} context={props.context} onOpenFile={props.onOpenFile} /> }
