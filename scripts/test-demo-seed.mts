/**
 * STRUCTURE GUARD（结构守卫）：本文件含源码 token/正则断言，不单独构成行为证据；
 * 新业务完成度须配行为级测试（审计报告阶段 0："新业务完成度不得只靠源码 token"）。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { buildDemoAgents, buildDemoMessages, buildDemoPermissionRequest, buildDemoSessions, buildGitStatus, buildSessionSummaries } from '../src/demo/demoData.ts'
import { persistMessageSnapshot, parseMessageSnapshot } from '../src/components/chat/messagePersistence.ts'

// 浏览器模式演示种入：纯 builder 形状 + seed 顺序（App effect 接线）守卫。

// 1. 会话 builder：4 条 Session 形状完整（含 source/periId/profileId）
{
  const sessions = buildDemoSessions()
  assert.equal(sessions.length, 4, '必须 4 条演示会话')
  for (const session of sessions) {
    assert.equal(typeof session.id, 'string')
    assert.ok(session.id.length > 0)
    assert.ok(session.source.startsWith('local:demo-'), `source 必须 local:demo-*（${session.source}）`)
    assert.ok(session.periId, '演示会话必须带 periId（load_persisted_session 走恢复路径）')
    assert.ok(['riccati', 'serina'].includes(session.profileId))
    assert.equal(typeof session.workdir, 'string')
  }
}

// 2. 每会话消息：id 以 -<seq> 结尾（chatEventController seq 正则兼容），tool 以 tool- 开头
{
  const sessions = buildDemoSessions()
  for (const session of sessions) {
    const messages = buildDemoMessages(session.id)
    assert.ok(messages.length >= 5, `${session.id} 必须有富对话（≥5 条）`)
    for (const message of messages) {
      assert.match(message.id, /-\d+$/, `${session.id} 消息 id 必须以 -<seq> 结尾（${message.id}）`)
      if (message.role === 'tool') {
        assert.ok(message.id.startsWith('tool-'), `tool 消息 id 必须以 tool- 开头（${message.id}）`)
        assert.equal(typeof message.toolKind, 'string', 'tool 消息必须带 toolKind（ToolCard 按 kind 渲染）')
        assert.ok(['completed', 'failed', 'in_progress', 'waiting', 'queued', 'cancelled'].includes(String(message.toolStatus)), `toolStatus 合法（${message.toolStatus}）`)
      }
    }
    assert.ok(messages.some(m => m.role === 'reasoning'), `${session.id} 必须含 reasoning`)
    assert.ok(messages.some(m => m.role === 'assistant'), `${session.id} 必须含 assistant`)
  }
  // 会话间对话不同（各自叙事）
  assert.notDeepEqual(buildDemoMessages('demo-fe'), buildDemoMessages('demo-hermes'))
}

// 3. 消息缓存信封：persistMessageSnapshot 产物可被 parseMessageSnapshot 往返解析（ChatView 恢复 + search 可查）
{
  const storage = new Map<string, string>()
  const storageLike = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } }
  const messages = buildDemoMessages('demo-fe')
  persistMessageSnapshot('demo-fe', messages, storageLike)
  const raw = storage.get('pylon-msgs-demo-fe')
  assert.ok(raw, '必须写入 pylon-msgs-<id> 键')
  const envelope = JSON.parse(raw) as { version: number; messages: unknown[] }
  assert.equal(envelope.version, 1, '信封必须带 version 1')
  const restored = parseMessageSnapshot<typeof messages>(raw)
  assert.deepEqual(restored, messages, '快照往返解析必须还原原消息')
  const key = [...storage.keys()][0]
  assert.ok(key?.startsWith('pylon-msgs-'), '键必须命中 isMessageSnapshotKey（search 可扫）')
}

// 4. 存档列表（list_persisted_sessions）≥4 条且 id/updatedAt 齐
{
  const summaries = buildSessionSummaries()
  assert.ok(summaries.length >= 4)
  for (const item of summaries) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.updatedAt, 'number')
  }
}

// 5. git status porcelain 码合法
for (const entry of buildGitStatus()) {
  assert.ok(['M', 'A', 'D', 'R', '??'].includes(entry.status), `porcelain 码（${entry.status}）`)
}

// 6. 权限请求形状（PermissionRequest 必需键）
{
  const request = buildDemoPermissionRequest()
  assert.equal(typeof request.requestId, 'number')
  assert.equal(typeof request.title, 'string')
  assert.ok(Array.isArray(request.options) && request.options.length >= 2)
  for (const option of request.options) {
    assert.equal(typeof option.optionId, 'string')
  }
}

// 7. seed 接线（App effect 顺序守卫）：App.tsx 末尾 effect + 顺序约束
{
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /import \{ seedDemo \} from '\.\/demo\/seed'/, 'App 必须接 seedDemo')
  assert.match(app, /if \(IS_TAURI\) return/, 'seed effect 必须 Tauri 守卫')
  assert.match(app, /demoSeededRef\.current/, 'seed 必须幂等 ref')
  assert.match(app, /seedDemo\(setActiveSession/, 'seed 必须传 setActiveSession（写回持久化）')
  const seedEffect = app.slice(app.indexOf('demoSeededRef'))
  const hydrateIdx = app.indexOf('hydrateWorkspaceSheets()')
  assert.ok(seedEffect.includes('useEffect') && app.indexOf('demoSeededRef') > hydrateIdx, 'seed effect 必须声明在 hydrate 之后')
  const seed = readFileSync(new URL('../src/demo/seed.ts', import.meta.url), 'utf8')
  assert.match(seed, /setAgents\(buildDemoAgents\(\)\)/, 'setAgents 必须最先（内部 replaceSheets 清 sheets）')
  assert.match(seed, /identity\.sessions\.length === 0/, '会话种入必须二次启动跳过（agents/状态灯每次补——非持久化）')
  assert.match(seed, /persistSessions\(localStorage, sessions\)/, '会话必须持久化（幂等）')
  assert.match(seed, /persistMessageSnapshot\(session\.id/, '每会话必须种消息缓存')
  assert.match(seed, /openSheet\(\{ kind: 'agent'/, '必须先开 agent sheet')
  assert.match(seed, /singletonKey: `file:\$\{sessions\[0\]\.source\}`/, 'file sheet 必须绑演示会话 source（打开即见文件树/git/搜索）')
  assert.match(seed, /focusSheet\(agentSheetId\)/, '必须聚焦 agent sheet')
  assert.match(seed, /setActiveSession\(sessions\[0\]\.id\)/, 'setActiveSession 必须随会话种入（写回 effect 持久化）')
  assert.match(seed, /runtime\.setAgentStatus\('peri'/, '状态灯必须每次补（非持久化）')
}

console.log('demo seed 守卫通过')
