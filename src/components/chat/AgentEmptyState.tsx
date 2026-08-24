import PylonMark from '../PylonMark.tsx'
import { selectAgentEmptyState } from '../../domains/workbench/agentEmptyState.ts'

interface AgentEmptyStateProps {
  workspaceMode: 'work' | 'chat'
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
}

export default function AgentEmptyState({ workspaceMode, sidebarCollapsed = false, onExpandSidebar }: AgentEmptyStateProps) {
  const model = selectAgentEmptyState(workspaceMode)
  return (
    <div className="chat-empty agent-empty-state" data-workspace-mode={workspaceMode} role="region" aria-label="Agent 工作台空态">
      <div className="agent-empty-brand" aria-hidden="true"><PylonMark size={52} title="" /></div>
      <div className="agent-empty-eyebrow">{model.eyebrow}</div>
      <h2 className="agent-empty-title">{model.title}</h2>
      <p className="agent-empty-description">{model.description}</p>
      <ol className="agent-empty-steps" aria-label="开始步骤">
        {model.steps.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span>{step}</li>)}
      </ol>
      {sidebarCollapsed && onExpandSidebar && (
        <button type="button" className="agent-empty-sidebar-action" onClick={onExpandSidebar}>展开左栏</button>
      )}
    </div>
  )
}
