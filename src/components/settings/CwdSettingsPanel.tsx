/**
 * CwdSettingsPanel — 工作区（cwd）设置面板。
 *
 * 职责：
 * - skills / MCP 选择的编辑与保存；
 * - MCP 选项来自 agent 级暴露列表（get_mcp_servers）；
 */
import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FolderSearch, X } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { createAgentClient } from '../../infrastructure/acp/agentClient'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore'
import { reportRuntimeError } from '../../runtimeError'
import type { Workspace } from '../../workspaceEntities'
import { isAbsolutePath } from '../../workspaceEntities'
import { buildCapabilityOptions } from '../../domains/workspace/capabilityOptions.ts'

interface McpOption { id?: string; name?: string; transport?: string; enabled?: boolean; disabled?: boolean }

function parseList(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function ListPreview({ value, onChange, empty }: { value: string; onChange: (value: string) => void; empty: string }) {
  const items = parseList(value)
  if (items.length === 0) return <span className="cwd-tag-empty">{empty}</span>
  return <div className="cwd-tag-list" role="list">{items.map(item => (
    <button key={item} type="button" role="listitem" className="cwd-tag" title={`移除 ${item}`} onClick={() => onChange(items.filter(candidate => candidate !== item).join(', '))}>
      <span>{item}</span><X size={11} aria-hidden="true" />
    </button>
  ))}</div>
}

function StructuredIdField({ label, value, onChange, placeholder, empty }: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  empty: string
}) {
  const items = parseList(value)
  return <>
    <input className="settings-control" aria-label={`${label}（逗号分隔）`} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} />
    <small>可输入多个 id（逗号分隔），下面的标签可单独移除。</small>
    <ListPreview value={value} onChange={onChange} empty={empty} />
    {items.length > 0 && <span className="set-hint" aria-live="polite">已选择 {items.length} 项</span>}
  </>
}

export default function CwdSettingsPanel({ workspace, onClose, showHeader = true }: { workspace: Workspace; onClose: () => void; showHeader?: boolean }) {
  const updateWorkspace = useWorkspaceEntityStore(s => s.updateWorkspace)
  const [name, setName] = useState(workspace.name)
  const [rootPath, setRootPath] = useState(workspace.rootPath)
  const [skills, setSkills] = useState(workspace.skills.join(', '))
  const [hookPluginIds, setHookPluginIds] = useState(workspace.hookPluginIds.join(', '))
  const [mcpIds, setMcpIds] = useState<Set<string>>(new Set(workspace.mcpServerIds))
  const [mcpOptions, setMcpOptions] = useState<McpOption[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setName(workspace.name)
    setRootPath(workspace.rootPath)
    setSkills(workspace.skills.join(', '))
    setHookPluginIds(workspace.hookPluginIds.join(', '))
    setMcpIds(new Set(workspace.mcpServerIds))
    setSaveError(null)
  }, [workspace.id, workspace.name, workspace.rootPath, workspace.skills, workspace.hookPluginIds, workspace.mcpServerIds])

  useEffect(() => {
    let disposed = false
    createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      .getMcpServers()
      .then(list => { if (!disposed) setMcpOptions(list as McpOption[]) })
      .catch(error => reportRuntimeError('读取 MCP 配置', error))
    return () => { disposed = true }
  }, [])

  const dirty = useMemo(() => (
    name.trim() !== workspace.name
    || rootPath.trim() !== workspace.rootPath
    || parseList(skills).join('\u0000') !== workspace.skills.join('\u0000')
    || parseList(hookPluginIds).join('\u0000') !== workspace.hookPluginIds.join('\u0000')
    || [...mcpIds].sort().join('\u0000') !== [...workspace.mcpServerIds].sort().join('\u0000')
  ), [hookPluginIds, mcpIds, name, rootPath, skills, workspace])

  const mcpCapabilities = useMemo(() => buildCapabilityOptions(
    'mcp',
    mcpOptions.flatMap(option => {
      const id = option.id ?? option.name ?? ''
      return id ? [{ id, label: option.name ?? id, source: 'agent' }] : []
    }),
    [...mcpIds],
  ), [mcpIds, mcpOptions])

  const pickRootPath = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '更换工作区文件夹' })
      if (typeof selected === 'string') setRootPath(selected)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '无法打开文件夹选择器')
    }
  }

  const cancel = () => {
    if (dirty && typeof window.confirm === 'function' && !window.confirm('放弃未保存的工作区设置？')) return
    onClose()
  }

  const save = async () => {
    if (!name.trim()) { setSaveError('工作区名称不能为空'); return }
    if (!isAbsolutePath(rootPath.trim())) { setSaveError('工作目录必须是绝对路径'); return }
    setSaving(true)
    setSaveError(null)
    try {
      await updateWorkspace(workspace.id, {
        name: name.trim(),
        rootPath: rootPath.trim(),
        skills: parseList(skills),
        mcpServerIds: [...mcpIds],
        hookPluginIds: parseList(hookPluginIds),
      })
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSaveError(message)
      reportRuntimeError('保存工作区设置', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="cwd-settings settings-surface">
      {showHeader && (
        <div className="cwd-settings-head">
          <span className="cwd-group-name">{workspace.name}</span>
          <button className="cwd-settings-close" onClick={cancel} title="关闭工作区设置" aria-label="关闭工作区设置"><X size={14} aria-hidden="true" /></button>
        </div>
      )}

      <section className="cwd-settings-section" aria-labelledby="cwd-basic-title">
        <div className="cwd-settings-section-head">
          <div><h3 id="cwd-basic-title">基本信息</h3><p>名称用于识别；目录决定新会话的默认工作位置。</p></div>
        </div>
        <label className="sess-field">
          <span>工作区名称</span>
          <input aria-label="工作区名称" className="settings-control" value={name} onChange={event => setName(event.target.value)} />
        </label>

        <label className="sess-field">
          <span>工作目录</span>
          <div className="cwd-path-control">
            <input aria-label="工作目录" className="settings-control cwd-root-input" value={rootPath} onChange={event => setRootPath(event.target.value)} />
            <button type="button" className="settings-action cwd-path-picker" onClick={() => void pickRootPath()} aria-label="重新选择工作目录"><FolderSearch size={14} aria-hidden="true" /><span>选择</span></button>
          </div>
          <small>更改后仅影响新建会话；已有会话保留自己的目录快照。</small>
        </label>
      </section>

      <section className="cwd-settings-section" aria-labelledby="cwd-capabilities-title">
        <div className="cwd-settings-section-head">
          <div><h3 id="cwd-capabilities-title">新会话能力</h3><p>由插件系统在创建会话时注入 Tool、MCP、Skill 等能力提示。</p><p><strong>仅在新建会话时生效；已有会话保持不变。</strong></p></div>
        </div>
        <label className="sess-field">
          <span>Skills（逗号分隔）</span>
          <StructuredIdField label="Skills" value={skills} onChange={setSkills} placeholder="code-review, trpg-master" empty="尚未指定 Skill" />
        </label>

        <label className="sess-field">
          <span>Hook 插件（逗号分隔）</span>
          <StructuredIdField label="Hook 插件" value={hookPluginIds} onChange={setHookPluginIds} placeholder="plugin.workspace-hooks" empty="尚未指定 Hook" />
        </label>

        <div className="sess-field">
        <span>MCP 服务</span>
        {mcpOptions.length === 0 && (
          <div className="set-hint">
            当前 Agent 未提供可选 MCP 服务。
            <button
              type="button"
              className="settings-action"
              style={{ marginLeft: 8 }}
              onClick={() => window.dispatchEvent(new CustomEvent('pylon:open-settings', {
                detail: { domain: 'agents-connections', section: 'agent' },
              }))}
            >
              配置 Agent
            </button>
          </div>
        )}
        {mcpCapabilities.map(option => {
          const key = option.id
          const checked = option.enabled
          return (
            <label key={key} className="cwd-check">
              <input type="checkbox" checked={checked} onChange={e => {
                const next = new Set(mcpIds)
                if (e.target.checked) next.add(key)
                else next.delete(key)
                setMcpIds(next)
              }} />
              <span>{option.label}（{mcpOptions.find(candidate => (candidate.id ?? candidate.name) === key)?.transport ?? '不可用'}）{option.available ? '' : ` · ${option.diagnostic}`}</span>
            </label>
          )
        })}
      </div>
      </section>

      {saveError && <div className="set-hint cwd-settings-error" role="alert">{saveError}</div>}
      <div className="cwd-settings-footer">
        <span className={`cwd-settings-dirty ${dirty ? 'active' : ''}`} role="status">{dirty ? '有未保存的更改' : '所有更改已保存'}</span>
        <div className="sess-field-actions">
          <button className="settings-action" onClick={cancel}>取消</button>
          <button className="settings-action primary" disabled={saving || !dirty} onClick={() => void save()}>{saving ? '保存中…' : '保存更改'}</button>
        </div>
      </div>
    </div>
  )
}
