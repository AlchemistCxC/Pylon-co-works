import { strict as assert } from 'node:assert'
import { mockInvokeCommand } from '../src/demo/mockTauri.ts'

// 浏览器模式假 Tauri 后端（静态演示全景）：mockInvokeCommand 纯命令路由——
// 已知命令返回兼容 normalize 的形状；未知命令/browser_start（CDP 组）reject 走「待后端」。

// 1. 数据类命令形状
{
  const agents = await mockInvokeCommand('list_agents')
  assert.ok(Array.isArray(agents) && agents.length >= 2, 'list_agents 必须返回 agent 数组')
  for (const agent of agents as Array<{ id: string; name: string }>) {
    assert.equal(typeof agent.id, 'string')
    assert.equal(typeof agent.name, 'string')
  }

  const entries = await mockInvokeCommand('list_workspace_entries', { relativePath: '' }) as Array<{ name: string; relativePath: string; kind: string }>
  assert.ok(entries.some(e => e.kind === 'directory' && e.relativePath === 'src'), '根目录必须含 src 目录')
  const srcEntries = await mockInvokeCommand('list_workspace_entries', { relativePath: 'src' }) as Array<{ kind: string }>
  assert.ok(srcEntries.length > 0, 'src 必须有子项')
  assert.deepEqual(await mockInvokeCommand('list_workspace_entries', { relativePath: 'no-such-dir' }), [], '未知目录返回空（FileTree 空目录态）')

  const text = await mockInvokeCommand('read_workspace_text', { relativePath: 'src/sheets/AgentSheetView.tsx' }) as { bytesRead: number; totalBytes: number; truncated: boolean; encoding?: string; content: string }
  assert.equal(typeof text.bytesRead, 'number', 'read_workspace_text 必须带 bytesRead')
  assert.equal(typeof text.totalBytes, 'number')
  assert.equal(typeof text.truncated, 'boolean')
  assert.ok(text.content.length > 0)

  const git = await mockInvokeCommand('git_status') as Array<{ path: string; status: string; staged: boolean }>
  assert.ok(git.length > 0, 'git_status 必须有条目')
  for (const entry of git) {
    assert.ok(['M', 'A', 'D', 'R', '??'].includes(entry.status), `porcelain 码原样保留（${entry.status}）`)
    assert.equal(typeof entry.staged, 'boolean')
  }
  const history = await mockInvokeCommand('git_history') as Array<{ hash: string; subject: string }>
  assert.ok(history[0]?.hash && history[0]?.subject, 'git_history 条目必须含 hash/subject')
  assert.equal(typeof await mockInvokeCommand('git_diff'), 'string')

  const gateway = await mockInvokeCommand('gateway_status') as { adapters: string[]; routes: unknown[]; qq: unknown; inject: unknown }
  assert.ok(Array.isArray(gateway.adapters), 'gateway adapters 必须为数组')
  assert.ok(Array.isArray(gateway.routes) && gateway.routes.length > 0, 'gateway routes 必须有路由')
  assert.ok('inject' in gateway, 'gateway 必须含 inject')
  const platformSessions = await mockInvokeCommand('gateway_sessions') as Array<{ agentId: string; source: string; periId: string }>
  assert.ok(platformSessions.length >= 2, 'gateway_sessions 必须有平台会话行')
  for (const row of platformSessions) {
    assert.equal(typeof row.agentId, 'string')
    assert.equal(typeof row.source, 'string')
    assert.equal(typeof row.periId, 'string')
  }

  const sessions = await mockInvokeCommand('list_persisted_sessions') as Array<{ id: string; updatedAt: number }>
  assert.ok(sessions.length >= 4, '存档列表必须≥4 条')
  for (const s of sessions) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0)
    assert.equal(typeof s.updatedAt, 'number')
  }

  const logs = await mockInvokeCommand('list_runtime_logs') as Array<{ id: number; level: string; source: string; message: string }>
  assert.ok(logs.length > 0, '运行日志必须有条目')
  for (const entry of logs) {
    assert.equal(typeof entry.id, 'number')
    assert.ok(['trace', 'debug', 'info', 'warn', 'error'].includes(entry.level), `level 必须合法（${entry.level}）`)
    assert.ok(entry.message.length > 0)
  }

  const diag = await mockInvokeCommand('startup_diagnostics') as { agentConfig: { status: string }; gatewayConfig: { status: string }; prism: { status: string } }
  assert.equal(typeof diag.agentConfig.status, 'string')
  assert.equal(typeof diag.prism.status, 'string')

  const search = await mockInvokeCommand('workspace_search', { query: 'AgentSheetView' }) as Array<{ path: string; line: number; lineText: string }>
  assert.ok(search.length > 0 && search[0]?.path, 'workspace_search 必须返回 path 命中')
}

// 2. 会话类命令：SessionResponse 兼容（configOptions 含 model/mode）
{
  const res = await mockInvokeCommand('load_persisted_session', { periId: 'peri-demo-1' }) as { sessionId: string; configOptions: Array<{ id: string; currentValue: unknown }> }
  assert.equal(typeof res.sessionId, 'string')
  const ids = res.configOptions.map(option => option.id)
  assert.ok(ids.includes('model') && ids.includes('mode'), 'configOptions 必须含 model/mode')
  const fresh = await mockInvokeCommand('new_session', {}) as { sessionId: string; configOptions: Array<{ id: string }> }
  assert.equal(typeof fresh.sessionId, 'string')
  assert.deepEqual(fresh.configOptions.map(option => option.id), ids, 'new_session 走同一 configOptions 形状')
}

// 3. ack 类命令不 reject（防错误噪音）
for (const cmd of ['send_message', 'switch_agent', 'set_approval_mode', 'close_session', 'export_session', 'clear_runtime_logs']) {
  await mockInvokeCommand(cmd, {}).catch(() => assert.fail(`${cmd} 不应 reject`))
}
await mockInvokeCommand('update_agents_config', { expectedRevision: 'demo-config-1', config: {} })

// 4. 诚实保留：browser_start（CDP 组）与未知命令 reject，message 含 not found
const browserStart = await mockInvokeCommand('browser_start', { lazy: true }) as { phase?: string }
assert.equal(typeof browserStart.phase, 'string', 'browser_start 在演示后端返回可观察状态')
await assert.rejects(mockInvokeCommand('totally_unknown_cmd'), /not found/i, '未知命令必须 reject')

// 5. plugin:dialog|save 返回绝对路径（HistorySheet 导出预检可过）
{
  const savePath = await mockInvokeCommand('plugin:dialog|save', { defaultPath: 'session-peri-demo-1.md' })
  assert.equal(typeof savePath, 'string')
  assert.match(String(savePath), /^[A-Za-z]:[\\/]/, '导出路径必须为绝对路径')
}

console.log('demo mock backend 守卫通过')
