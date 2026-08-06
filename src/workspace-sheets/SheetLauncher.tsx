import { Command } from 'cmdk'
import type { SheetRecord, SheetKind } from './sheetTypes'

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
  onOpenSheet: (kind: SheetKind, title: string, agentId?: string) => void
  onOpenSettings: () => void
  onOpenProfiles: () => void
}

// 全部 sheet kind 可打开（未接后端的显示占位态，不创建假数据）；agent 由上方 Agent 组承载
const TOOL_OPTIONS: Array<{ kind: SheetKind; title: string; description: string; enabled: boolean }> = [
  { kind: 'file', title: 'File', description: '工作区文件 / SCM / 搜索', enabled: true },
  { kind: 'gateway', title: 'Gateway', description: '网关适配器与路由概览', enabled: true },
  { kind: 'history', title: 'History', description: '存档会话列表与导出', enabled: true },
  { kind: 'search', title: 'Search', description: '跨会话快照搜索', enabled: true },
  { kind: 'runtime', title: 'Runtime', description: '运行日志与启动诊断', enabled: true },
  { kind: 'browser', title: 'Browser', description: '浏览器会话（CDP 待后端）', enabled: true },
  { kind: 'prism', title: 'Prism', description: 'Prism 管理（静态演示）', enabled: true },
]

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
  const closeThen = (action: () => void) => {
    action()
    onOpenChange(false)
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
          <Command.Group heading="最近">
            {recentSheets.map(sheet => (
              <Command.Item
                key={`recent:${sheet.id}`}
                value={`recent ${sheet.title} ${sheet.kind}`}
                onSelect={() => closeThen(() => onFocusSheet(sheet.id))}
              >
                <span className="sheet-launcher-kind">{sheet.kind}</span>
                <span className="sheet-launcher-copy">
                  <strong>{sheet.title}</strong>
                  <small>切换到已打开的 Sheet</small>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Agent">
          {agents.length > 0 ? agents.map(agent => (
            <Command.Item
              key={agent.id}
              value={`agent ${agent.name} ${agent.id}`}
              onSelect={() => closeThen(() => onOpenSheet('agent', agent.name, agent.id))}
            >
              <span className="sheet-launcher-kind">agent</span>
              <span className="sheet-launcher-copy">
                <strong>{agent.name}</strong>
                <small>{agent.id}</small>
              </span>
            </Command.Item>
          )) : (
            <Command.Item value="agent unavailable" disabled>
              <span className="sheet-launcher-kind">agent</span>
              <span className="sheet-launcher-copy">
                <strong>没有可用 Agent</strong>
                <small>等待 list_agents 返回</small>
              </span>
            </Command.Item>
          )}
        </Command.Group>

        <Command.Group heading="工具">
          {TOOL_OPTIONS.map(tool => (
            <Command.Item
              key={tool.kind}
              value={`tool ${tool.title} ${tool.kind}`}
              disabled={!tool.enabled}
              onSelect={() => closeThen(() => onOpenSheet(tool.kind, tool.title))}
            >
              <span className="sheet-launcher-kind">{tool.kind}</span>
              <span className="sheet-launcher-copy">
                <strong>{tool.title}</strong>
                <small>{tool.description}</small>
              </span>
              {!tool.enabled && <span className="sheet-launcher-badge">unavailable</span>}
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading="管理">
          <Command.Item value="management settings theme agent" onSelect={() => closeThen(onOpenSettings)}>
            <span className="sheet-launcher-kind">manage</span>
            <span className="sheet-launcher-copy"><strong>Settings</strong><small>主题、Agent 与应用设置</small></span>
          </Command.Item>
          <Command.Item value="management profiles profile" onSelect={() => closeThen(onOpenProfiles)}>
            <span className="sheet-launcher-kind">manage</span>
            <span className="sheet-launcher-copy"><strong>Profiles</strong><small>编辑当前 Profile</small></span>
          </Command.Item>
        </Command.Group>
      </Command.List>
      <div className="sheet-launcher-footer">
        <span><kbd>↑↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span>全部 Sheet 均可打开，未接后端能力显示占位</span>
      </div>
    </Command.Dialog>
  )
}
