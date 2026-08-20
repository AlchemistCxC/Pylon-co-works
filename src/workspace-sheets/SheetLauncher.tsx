import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Command } from 'cmdk'
import {
  Activity,
  Bot,
  Boxes,
  FolderTree,
  Globe,
  History,
  LayoutDashboard,
  Search,
  Settings,
  SlidersHorizontal,
  SquareStack,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { useIdentityStore } from '../identityStore'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from './workspaceRegistry'
import { activateAgentSheet } from './activateAgentSheet'
import type { SheetRecord, SheetKind } from './sheetTypes'
import type { WorkspaceLaunchOption } from './workspaceTypes'

interface AgentOption {
  id: string
  name: string
}

interface SheetLauncherProps {
  open: boolean
  agents: AgentOption[]
  sheets: SheetRecord[]
  onOpenChange: (open: boolean) => void
  onFocusSheet: (id: string) => void
  onOpenSheet: (kind: SheetKind | string, title: string, agentId?: string) => void
  onOpenSettings: () => void
  onOpenProfiles: () => void
}

const LAUNCH_ICONS: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  agent: Bot,
  boxes: Boxes,
  'folder-tree': FolderTree,
  globe: Globe,
  history: History,
  'layout-dashboard': LayoutDashboard,
  search: Search,
  settings: Settings,
  sliders: SlidersHorizontal,
  waypoints: Waypoints,
}

function LaunchIcon({ icon }: { icon?: string }) {
  const Icon = (icon && LAUNCH_ICONS[icon]) || SquareStack
  return <span className="sheet-launcher-icon" data-launch-icon={icon || 'workspace'}><Icon size={20} strokeWidth={1.8} aria-hidden="true" /></span>
}

interface LaunchGroup {
  key: string
  label: string
  options: WorkspaceLaunchOption[]
}

// 阶段 6：工具项响应式订阅 Workspace Registry snapshot，不维护第二份手写清单。
export default function SheetLauncher({
  open,
  agents,
  sheets,
  onOpenChange,
  onFocusSheet,
  onOpenSheet,
  onOpenSettings,
  onOpenProfiles,
}: SheetLauncherProps) {
  const activeAgent = useIdentityStore(state => state.activeAgent)
  const workspaceSnapshot = useSyncExternalStore(
    subscribeWorkspaceRegistry,
    getWorkspaceRegistrySnapshot,
    getWorkspaceRegistrySnapshot,
  )
  const tools = workspaceSnapshot.launchOptions
  const launchGroups = useMemo(() => {
    const groups = new Map<string, LaunchGroup>()
    for (const tool of tools) {
      const key = tool.category || 'other'
      const group = groups.get(key) ?? { key, label: tool.categoryLabel || '其他', options: [] }
      group.options.push(tool)
      groups.set(key, group)
    }
    return [...groups.values()]
  }, [tools])
  const launchByKind = useMemo(() => new Map(tools.map(tool => [tool.kind, tool])), [tools])
  const openAgentIds = useMemo(() => new Set(sheets.filter(sheet => sheet.kind === 'agent').map(sheet => sheet.agentId)), [sheets])
  const agentsToOpen = agents.filter(agent => !openAgentIds.has(agent.id))
  const switchingAgentRef = useRef(false)
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null)
  const closeThen = (action: () => void) => {
    action()
    onOpenChange(false)
  }
  const focusSheet = async (sheet: SheetRecord) => {
    const targetAgentId = sheet.kind === 'agent' ? sheet.agentId : undefined
    if (!targetAgentId || targetAgentId === activeAgent) {
      onFocusSheet(sheet.id)
      onOpenChange(false)
      return
    }
    if (switchingAgentRef.current) return
    switchingAgentRef.current = true
    setSwitchingAgentId(targetAgentId)
    const agentName = agents.find(agent => agent.id === targetAgentId)?.name || sheet.title || targetAgentId
    await activateAgentSheet(targetAgentId, agentName, () => onFocusSheet(sheet.id))
    switchingAgentRef.current = false
    setSwitchingAgentId(null)
    if (useIdentityStore.getState().activeAgent === targetAgentId) onOpenChange(false)
  }
  const openAgentSheet = async (agent: AgentOption) => {
    if (agent.id === activeAgent) {
      onOpenSheet('agent', agent.name, agent.id)
      onOpenChange(false)
      return
    }
    if (switchingAgentRef.current) return
    switchingAgentRef.current = true
    setSwitchingAgentId(agent.id)
    await activateAgentSheet(agent.id, agent.name, () => onOpenSheet('agent', agent.name, agent.id))
    switchingAgentRef.current = false
    setSwitchingAgentId(null)
    if (useIdentityStore.getState().activeAgent === agent.id) onOpenChange(false)
  }
  const recentSheets = [...sheets].sort((a, b) => b.lastFocusedAt - a.lastFocusedAt).slice(0, 5)

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="打开 Sheet"
      loop
      overlayClassName="sheet-launcher-overlay"
      contentClassName="sheet-launcher-dialog"
    >
      <div className="sheet-launcher-input-row">
        <span aria-hidden="true">›</span>
        <Command.Input autoFocus placeholder="搜索 Sheet、Agent 或管理入口..." />
        <kbd>Esc</kbd>
      </div>
      <Command.List className="sheet-launcher-list">
        <Command.Empty className="sheet-launcher-empty">没有匹配项</Command.Empty>

        {recentSheets.length > 0 && (
          <Command.Group className="sheet-launcher-section sheet-launcher-recent" heading="最近打开">
            {recentSheets.map(sheet => (
              <Command.Item
                key={`recent:${sheet.id}`}
                value={`recent ${sheet.title} ${sheet.kind}`}
                disabled={switchingAgentId !== null}
                onSelect={() => { void focusSheet(sheet) }}
              >
                <LaunchIcon icon={sheet.kind === 'agent' ? 'agent' : launchByKind.get(sheet.kind)?.icon} />
                <span className="sheet-launcher-copy">
                  <span className="sheet-launcher-card-title"><strong>{sheet.title}</strong><em>{sheet.kind}</em></span>
                  <small>切换到已打开的 Sheet</small>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {(agentsToOpen.length > 0 || agents.length === 0) && <Command.Group className="sheet-launcher-section" heading="Agent">
          {agents.length > 0 ? agentsToOpen.map(agent => (
            <Command.Item
              key={agent.id}
              value={`agent ${agent.name} ${agent.id}`}
              disabled={switchingAgentId !== null}
              onSelect={() => { void openAgentSheet(agent) }}
            >
              <LaunchIcon icon="agent" />
              <span className="sheet-launcher-copy">
                <span className="sheet-launcher-card-title"><strong>{agent.name}</strong><em>agent</em></span>
                <small>{agent.id}</small>
              </span>
            </Command.Item>
          )) : (
            <Command.Item value="agent unavailable" disabled>
              <LaunchIcon icon="agent" />
              <span className="sheet-launcher-copy">
                <strong>没有可用 Agent</strong>
                <small>等待 list_agents 返回</small>
              </span>
            </Command.Item>
          )}
        </Command.Group>}

        {launchGroups.map(group => (
          <Command.Group key={group.key} className="sheet-launcher-section" heading={group.label}>
            {group.options.map(tool => (
              <Command.Item
                key={tool.kind}
                value={`tool ${tool.title} ${tool.kind} ${tool.categoryLabel || ''} ${(tool.keywords || []).join(' ')}`}
                disabled={!tool.launchable}
                onSelect={() => closeThen(() => onOpenSheet(tool.kind, tool.title))}
              >
                <LaunchIcon icon={tool.icon} />
                <span className="sheet-launcher-copy">
                  <span className="sheet-launcher-card-title"><strong>{tool.title}</strong><em>{tool.kind}</em></span>
                  <small>{tool.description}</small>
                </span>
                {!tool.launchable && <span className="sheet-launcher-badge">unavailable</span>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}

        <Command.Group className="sheet-launcher-section sheet-launcher-management" heading="应用设置">
          <Command.Item value="management settings theme agent" onSelect={() => closeThen(onOpenSettings)}>
            <LaunchIcon icon="settings" />
            <span className="sheet-launcher-copy"><span className="sheet-launcher-card-title"><strong>Settings</strong><em>manage</em></span><small>主题、Agent 与应用设置</small></span>
          </Command.Item>
          <Command.Item value="management profiles profile" onSelect={() => closeThen(onOpenProfiles)}>
            <LaunchIcon icon="sliders" />
            <span className="sheet-launcher-copy"><span className="sheet-launcher-card-title"><strong>Profiles</strong><em>manage</em></span><small>编辑当前 Profile</small></span>
          </Command.Item>
        </Command.Group>
      </Command.List>
      <div className="sheet-launcher-footer">
        <span><kbd>↑↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span>插件可贡献分类、图标与搜索关键词</span>
      </div>
    </Command.Dialog>
  )
}
