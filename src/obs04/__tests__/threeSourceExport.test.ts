/**
 * OBS-04：三源导出取证工具单元测试。
 *
 * 覆盖：脱敏（镜像 Rust sanitize.rs Strip 语义）；localStorage v1 envelope / 旧裸数组 /
 * 损坏快照；SQLite 游标分页全量镜像 + seq 排序 + 截断守卫；ACP replay 归一摘要 + 失败态；
 * 三源工件组装与缺口登记；身份解析；编排（单源失败不拖垮整体）。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  collectLocalStorageSection,
  collectReplaySection,
  collectSqliteSection,
  exportThreeSourcesForSession,
  resolveSessionIdentity,
  buildThreeSourceArtifact,
  containsSensitiveValue,
  isSensitiveExportKey,
  sanitizeExportValue,
  sanitizeIdentityExport,
  redactAbsolutePath,
  type Obs04Transport,
} from '../threeSourceExport'
import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository'

function memoryStorage(entries: Record<string, string>): Pick<Storage, 'getItem'> {
  return {
    getItem: (key: string) => entries[key] ?? null,
  }
}

function recordingTransport(handler: (cmd: string, args: Record<string, unknown>) => Promise<unknown>): Obs04Transport & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    invoke: async (cmd, args) => {
      calls.push(`${cmd}(${JSON.stringify(args ?? {})})`)
      return handler(cmd, args ?? {})
    },
  }
}

/** canonical_events 行 fixture（evt_list 回读形状）。 */
function canonicalEvent(sequence: number, sessionId = 'local:sabc1'): CanonicalEventRow {
  const ownerKey = JSON.stringify(['p', 'a', sessionId])
  return {
    eventId: `${ownerKey}#${sequence}`,
    owner: { profileId: 'p', agentId: 'a', localSessionId: sessionId },
    clientGeneration: 1,
    sequence,
    occurredAt: `2026-01-01T00:00:00.${String(sequence).padStart(3, '0')}Z`,
    receivedAt: `2026-01-01T00:00:00.${String(sequence).padStart(3, '0')}Z`,
    eventType: 'user.message',
    payloadVersion: 1,
    identity: { messageId: `m${sequence}` },
    typedPayload: { text: sequence === 1 ? 'a' : 'b' },
    rawPayload: { text: sequence === 1 ? 'a' : 'b' },
    createdAt: sequence,
  }
}

// ── 脱敏（镜像 Rust sanitize.rs） ──────────────────────────────────────────

describe('isSensitiveExportKey', () => {
  it('命中 Rust 清单（含大小写变体与后缀）', () => {
    expect(isSensitiveExportKey('rawInput')).toBe(true)
    expect(isSensitiveExportKey('rawOutput')).toBe(true)
    expect(isSensitiveExportKey('prompt')).toBe(true)
    expect(isSensitiveExportKey('persona')).toBe(true)
    expect(isSensitiveExportKey('headers')).toBe(true)
    expect(isSensitiveExportKey('authorization')).toBe(true)
    expect(isSensitiveExportKey('apiKey')).toBe(true)
    expect(isSensitiveExportKey('API_KEY')).toBe(true)
    expect(isSensitiveExportKey('access_token')).toBe(true)
    expect(isSensitiveExportKey('clientSecret')).toBe(true)
  })
  it('不误伤普通键（工具身份证据保留）', () => {
    expect(isSensitiveExportKey('toolCallId')).toBe(false)
    expect(isSensitiveExportKey('title')).toBe(false)
    expect(isSensitiveExportKey('kind')).toBe(false)
    expect(isSensitiveExportKey('status')).toBe(false)
    expect(isSensitiveExportKey('content')).toBe(false)
    expect(isSensitiveExportKey('messageId')).toBe(false)
    expect(isSensitiveExportKey('sessionId')).toBe(false)
  })
})

describe('containsSensitiveValue', () => {
  it('识别分隔符变体与裸 secret 前缀，不误伤普通文本', () => {
    expect(containsSensitiveValue('password=abc')).toBe(true)
    expect(containsSensitiveValue('Bearer abcdef')).toBe(true)
    expect(containsSensitiveValue('sk-proj-xxxx')).toBe(true)
    expect(containsSensitiveValue('ghp_abcdef')).toBe(true)
    expect(containsSensitiveValue('检查磁盘使用情况')).toBe(false)
    expect(containsSensitiveValue('task-123 normal text')).toBe(false)
  })
})

describe('sanitizeExportValue', () => {
  it('剔除敏感 key、REDACTED 值、保留工具身份与聊天正文', () => {
    const input = {
      jsonrpc: '2.0',
      params: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'Read',
          kind: 'read',
          status: 'running',
          rawInput: { path: 'src/x.ts', apiKey: 'sk-secret' },
          content: [{ type: 'text', text: '安全内容' }],
        },
      },
    }
    const out = sanitizeExportValue(input) as typeof input
    const update = out.params.update as Record<string, unknown>
    expect(update.toolCallId).toBe('call-1')
    expect(update.title).toBe('Read')
    expect(update.kind).toBe('read')
    expect(update.status).toBe('running')
    expect(update.rawInput).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('sk-')
    expect((update.content as Array<{ text: string }>)[0].text).toBe('安全内容')
  })
})

// ── CR-001：identity 段工件级脱敏 ───────────────────────────────────────────

describe('redactAbsolutePath', () => {
  it('绝对路径（盘符/UNC/根相对）收窄为目录名，相对路径原样保留', () => {
    expect(redactAbsolutePath('G:/Project/ws/prism-desktop')).toBe('…/prism-desktop')
    expect(redactAbsolutePath('C:\\Users\\me\\prism-desktop')).toBe('…/prism-desktop')
    expect(redactAbsolutePath('//server/share/prism-desktop')).toBe('…/prism-desktop')
    expect(redactAbsolutePath('/root/proj')).toBe('…/proj')
    expect(redactAbsolutePath('relative/dir')).toBe('relative/dir')
  })
})

describe('sanitizeIdentityExport', () => {
  it('secret 形态 sessionPrompt 整值 REDACTED；workdir 绝对路径收窄；工具字段保留', () => {
    const out = sanitizeIdentityExport({
      id: 's1',
      name: '会话一',
      agentId: 'peri',
      profileId: 'profile-a',
      source: 'local:s1',
      periId: 'peri-9',
      workdir: 'G:/Project/ws/prism-desktop',
      sessionPrompt: 'system: 使用 API_KEY=sk-proj-leak 完成任务',
      autoName: '',
      platform: 'local',
      createdAt: 1,
      lastActiveAt: 2,
    })
    expect(out.id).toBe('s1')
    expect(out.agentId).toBe('peri')
    expect(out.periId).toBe('peri-9')
    expect(out.workdir).toBe('…/prism-desktop')
    expect(out.sessionPrompt).toBe('[REDACTED]')
    expect(JSON.stringify(out)).not.toContain('G:/Project')
    expect(JSON.stringify(out)).not.toContain('sk-proj')
  })
})

// ── localStorage 证据源 ─────────────────────────────────────────────────────

describe('collectLocalStorageSection', () => {
  it('v1 envelope：messages 解析、envelopeVersion=1、计数正确', () => {
    const storage = memoryStorage({
      'pylon-msgs-sabc1': JSON.stringify({ version: 1, messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'assistant', content: 'ok' }] }),
    })
    const section = collectLocalStorageSection('sabc1', storage)
    expect(section.snapshotPresent).toBe(true)
    expect(section.envelopeVersion).toBe(1)
    expect(section.corrupt).toBe(false)
    expect(section.messageCount).toBe(2)
    expect(section.messages?.[0].content).toBe('hi')
  })

  it('旧裸数组：兼容解析，envelopeVersion=null', () => {
    const storage = memoryStorage({
      'pylon-msgs-sabc2': JSON.stringify([{ id: 'm1', role: 'user', content: 'x' }]),
    })
    const section = collectLocalStorageSection('sabc2', storage)
    expect(section.envelopeVersion).toBeNull()
    expect(section.messageCount).toBe(1)
    expect(section.corrupt).toBe(false)
  })

  it('损坏快照：corrupt=true 且原文保留（不抛）', () => {
    const storage = memoryStorage({ 'pylon-msgs-sabc3': '{broken json' })
    const section = collectLocalStorageSection('sabc3', storage)
    expect(section.corrupt).toBe(true)
    expect(section.parseError).toBeTruthy()
    expect(section.rawSnapshot).toBe('{broken json')
    expect(section.messageCount).toBe(0)
  })

  it('快照缺失：snapshotPresent=false', () => {
    const section = collectLocalStorageSection('sabc-missing', memoryStorage({}))
    expect(section.snapshotPresent).toBe(false)
    expect(section.messageCount).toBe(0)
    expect(section.corrupt).toBe(false)
  })
})

// ── SQLite 证据源 ───────────────────────────────────────────────────────────

describe('collectSqliteSection', () => {
  it('游标分页全量镜像、sequence 升序、evt_revision 采集', async () => {
    const transport = recordingTransport(async (cmd, args) => {
      if (cmd === 'evt_list') {
        const beforeSequence = args.beforeSequence as number | null
        if (beforeSequence === null) return { events: [canonicalEvent(2)], nextBeforeSequence: 1 }
        return { events: [canonicalEvent(1)], nextBeforeSequence: null }
      }
      if (cmd === 'evt_revision') return 2
      throw new Error(`unexpected ${cmd}`)
    })
    const section = await collectSqliteSection({ sessionId: 'sabc1', ownerKey: '["p","a","local:sabc1"]', transport })
    expect(section.rowCount).toBe(2)
    expect(section.pages).toBe(2)
    expect(section.rows.map(row => row.sequence)).toEqual([1, 2])
    expect(section.revision).toBe(2)
    expect(transport.calls).toContain('evt_list({"ownerKey":"[\\"p\\",\\"a\\",\\"local:sabc1\\"]","beforeSequence":null,"limit":500})')
  })

  it('空会话：rowCount=0、revision 正常', async () => {
    const transport = recordingTransport(async (cmd) => (cmd === 'evt_list' ? { events: [], nextBeforeSequence: null } : 0))
    const section = await collectSqliteSection({ sessionId: 'empty', ownerKey: '["p","a","empty"]', transport })
    expect(section.rowCount).toBe(0)
    expect(section.pages).toBe(1)
    expect(section.truncated).toBe(false)
  })

  it('页数到达硬上限：truncated=true', async () => {
    let page = 0
    const transport = recordingTransport(async (cmd) => {
      if (cmd === 'evt_list') {
        page += 1
        return { events: Array.from({ length: 500 }, (_, i) => canonicalEvent((page - 1) * 500 + i + 1)), nextBeforeSequence: page < 300 ? page : null }
      }
      return 0
    })
    const section = await collectSqliteSection({ sessionId: 'huge', ownerKey: '["p","a","huge"]', transport })
    expect(section.truncated).toBe(true)
    expect(section.pages).toBe(200)
  })
})

// ── ACP replay 证据源 ───────────────────────────────────────────────────────

function updateEnvelope(variant: string, overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'peri-1', update: { sessionUpdate: variant, ...overrides } },
  }
}

describe('collectReplaySection', () => {
  it('无 periId：loadOk=false 且不 invoke', async () => {
    const transport = recordingTransport(async () => { throw new Error('must not be called') })
    const section = await collectReplaySection({ source: 'local:sabc1', periId: null }, transport)
    expect(section.loadOk).toBe(false)
    expect(section.normalized).toBeNull()
    expect(transport.calls).toHaveLength(0)
  })

  it('invoke 返回 envelope：raw 保留 + 归一摘要（kind/malformed/noIdentity）', async () => {
    const replay = [
      updateEnvelope('user_message_chunk', { messageId: 'u1', content: { type: 'text', text: 'hi' } }),
      updateEnvelope('agent_message_chunk', { messageId: 'a1', content: { type: 'text', text: 'ok' } }),
      updateEnvelope('tool_call', { toolCallId: 'call-1', title: 'Read', status: 'running', rawInput: { path: 'x', apiKey: 'sk-secret' } }),
      updateEnvelope('tool_call'), // malformed：无 toolCallId
    ]
    const transport = recordingTransport(async () => ({ response: { status: 'ok' }, replay }))
    const section = await collectReplaySection({ source: 'local:sabc1', periId: 'peri-1' }, transport)
    expect(section.loadOk).toBe(true)
    expect(section.envelopeCount).toBe(4)
    expect(section.normalized).toBeTruthy()
    expect(section.normalized!.total).toBe(4)
    expect(section.normalized!.malformed).toBe(1)
    // 无身份事件 = 1：malformed tool_call 缺 toolCallId（identity 与 malformed 同源）
    expect(section.normalized!.noIdentity).toBe(1)
    expect(section.normalized!.byKind['assistant-text']).toBe(1)
    expect(section.normalized!.byKind['tool-call']).toBe(2)
    expect(section.normalized!.warnings.length).toBe(1)
    // 脱敏：rawInput 剔除，sk- 值消失，工具身份字段保留
    const json = JSON.stringify(section.envelopes)
    expect(json).not.toContain('sk-')
    expect(json).not.toContain('rawInput')
    expect(json).toContain('call-1')
  })

  it('invoke 失败：loadOk=false + loadError，不抛', async () => {
    const transport = recordingTransport(async () => { throw new Error('replay load exploded') })
    const section = await collectReplaySection({ source: 'local:sabc1', periId: 'peri-1' }, transport)
    expect(section.loadOk).toBe(false)
    expect(section.loadError).toContain('replay load exploded')
    expect(section.normalized).toBeNull()
  })
})

// ── 身份解析 ────────────────────────────────────────────────────────────────

describe('resolveSessionIdentity', () => {
  it('pylon-sessions v2 envelope 按 id 定位', () => {
    const storage = memoryStorage({
      'pylon-sessions': JSON.stringify({
        version: 2,
        sessions: [
          { id: 's1', name: '会话一', agentId: 'peri', profileId: 'profile-a', source: 'local:s1', periId: 'peri-9', workdir: 'C:/ws', createdAt: 1, lastActiveAt: 2, platform: 'local', sessionPrompt: '', autoName: '', skills: [], hooks: [] },
          { id: 's2', name: '会话二', agentId: 'hermes', source: 'local:s2', createdAt: 3, lastActiveAt: 4 },
        ],
      }),
    })
    const identity = resolveSessionIdentity('s2', storage)
    expect(identity).not.toBeNull()
    expect(identity!.agentId).toBe('hermes')
    expect(identity!.source).toBe('local:s2')
    expect(resolveSessionIdentity('nope', storage)).toBeNull()
  })

  it('缺失/损坏 → null（不抛）', () => {
    expect(resolveSessionIdentity('s1', memoryStorage({}))).toBeNull()
    expect(resolveSessionIdentity('s1', memoryStorage({ 'pylon-sessions': '{bad' }))).toBeNull()
  })
})

// ── 工件组装与缺口登记 ──────────────────────────────────────────────────────

describe('buildThreeSourceArtifact', () => {
  it('组装三源 + 排序键对照 + 计数摘要', () => {
    const localStorage = collectLocalStorageSection('sabc1', memoryStorage({
      'pylon-msgs-sabc1': JSON.stringify({ version: 1, messages: [{ id: 'm1', role: 'user', content: 'hi' }] }),
    }))
    const sqlite = {
      sessionId: 'sabc1', revision: 1,
      rows: [canonicalEvent(1)],
      rowCount: 1, pages: 1, truncated: false,
    }
    const replay = {
      source: 'local:sabc1', periId: 'peri-1', loadOk: true, loadError: null, response: null,
      envelopeCount: 3, envelopes: [], likelyTruncated: false,
      normalized: { total: 3, malformed: 0, noIdentity: 0, byKind: { 'user': 1 }, warnings: [] },
    }
    const artifact = buildThreeSourceArtifact({ sessionId: 'sabc1', identity: { id: 'sabc1', profileId: 'p', agentId: 'a', source: 'local:sabc1' }, localStorage, sqlite, replay })
    expect(artifact.tool).toBe('obs04-three-source-export')
    expect(artifact.ordering).toEqual({ localStorage: 'array-index', sqlite: 'sequence', replay: 'arrivalSeq' })
    expect(artifact.summary.messageCounts).toEqual({ localStorage: 1, sqlite: 1, replay: 3 })
    expect(artifact.summary.gaps).toEqual([])
  })

  it('登记缺口：replay 无 periId / sqlite 截断；localStorage absent 不再登记（A1-c legacy）', () => {
    const localStorage = collectLocalStorageSection('sabc2', memoryStorage({}))
    const sqlite = { sessionId: 'sabc2', revision: 0, rows: [], rowCount: 0, pages: 1, truncated: true }
    const replay = { source: 'local:sabc2', periId: null, loadOk: false, loadError: 'no periId — ACP replay 需 periId（会话未建立远端 session）', response: null, envelopeCount: 0, envelopes: [], likelyTruncated: false, normalized: null }
    const artifact = buildThreeSourceArtifact({ sessionId: 'sabc2', identity: { id: 'sabc2', profileId: 'p', agentId: 'a', source: 'local:sabc2', periId: null }, localStorage, sqlite, replay })
    expect(artifact.summary.gaps.length).toBe(2)
    expect(artifact.summary.gaps).toContain('sqlite: 分页到达硬上限，镜像可能截断')
    expect(artifact.summary.gaps).toContain('replay: 会话无 periId，无法重拉 ACP replay')
    expect(artifact.summary.truncated.sqlite).toBe(true)
  })
})

// ── 编排 ────────────────────────────────────────────────────────────────────

describe('exportThreeSourcesForSession', () => {
  it('全链路：三源齐全、缺省 storage 注入、单源失败不影响其他', async () => {
    const storage = memoryStorage({
      'pylon-msgs-sabc9': JSON.stringify({ version: 1, messages: [{ id: 'm1', role: 'user', content: 'hi' }] }),
      'pylon-sessions': JSON.stringify({ version: 2, sessions: [{ id: 'sabc9', agentId: 'peri', profileId: 'p', source: 'local:sabc9', periId: 'peri-9', createdAt: 1, lastActiveAt: 2 }] }),
    })
    const transport = recordingTransport(async (cmd) => {
      if (cmd === 'evt_list') return { events: [canonicalEvent(1, 'local:sabc9')], nextBeforeSequence: null }
      if (cmd === 'evt_revision') return 1
      if (cmd === 'load_persisted_session') return { response: { status: 'ok' }, replay: [updateEnvelope('done')] }
      throw new Error(`unexpected ${cmd}`)
    })
    const artifact = await exportThreeSourcesForSession({ sessionId: 'sabc9', transport, storage })
    expect(artifact.identity?.periId).toBe('peri-9')
    expect(artifact.sources.localStorage.messageCount).toBe(1)
    expect(artifact.sources.sqlite.rowCount).toBe(1)
    expect(artifact.sources.replay.envelopeCount).toBe(1)
    expect(artifact.sources.replay.normalized?.byKind['done']).toBe(1)
    expect(transport.calls.some(call => call.startsWith('load_persisted_session({"periId":"peri-9","owner":{"profileId":"p","agentId":"peri","localSessionId":"local:sabc9"}'))).toBe(true)
    expect(transport.calls.some(call => call.startsWith('evt_list({"ownerKey":"[\\"p\\",\\"peri\\",\\"local:sabc9\\"]"'))).toBe(true)
    expect(artifact.summary.gaps.length).toBe(0)
  })

  it('身份缺失：replay/sqlite 带缺口登记，localStorage 仍导出', async () => {
    const storage = memoryStorage({ 'pylon-msgs-sabc0': JSON.stringify({ version: 1, messages: [] }) })
    const transport = recordingTransport(async () => { throw new Error('identity 缺失时不得调用 sqlite/evt 命令') })
    const artifact = await exportThreeSourcesForSession({ sessionId: 'sabc0', transport, storage })
    expect(artifact.identity).toBeNull()
    expect(artifact.sources.sqlite.revision).toBe(-1)
    expect(artifact.sources.sqlite.rowCount).toBe(0)
    expect(artifact.sources.replay.periId).toBeNull()
    expect(artifact.sources.replay.loadOk).toBe(false)
    expect(artifact.sources.localStorage.snapshotPresent).toBe(true)
    expect(artifact.summary.gaps).toContain('sqlite: evt_revision 读取失败')
    expect(artifact.summary.gaps).toContain('replay: 会话无 periId，无法重拉 ACP replay')
    expect(transport.calls).toHaveLength(0)
  })

  it('transport.invoke 以 camelCase 参数调用（Tauri wire 契约）', async () => {
    const calls: string[] = []
    const transport: Obs04Transport = {
      invoke: async (cmd, args) => {
        calls.push(`${cmd} ${JSON.stringify(args)}`)
        if (cmd === 'evt_list') return { events: [], nextBeforeSequence: null }
        if (cmd === 'evt_revision') return 0
        return { response: null, replay: [] }
      },
    }
    await exportThreeSourcesForSession({
      sessionId: 'wire-check',
      transport,
      storage: memoryStorage({}),
      identity: { id: 'wire-check', profileId: 'p', agentId: 'a', source: 'local:wire-check', periId: 'peri-w' },
    })
    expect(calls).toContain('evt_list {"ownerKey":"[\\"p\\",\\"a\\",\\"local:wire-check\\"]","beforeSequence":null,"limit":500}')
    expect(calls).toContain('evt_revision {"ownerKey":"[\\"p\\",\\"a\\",\\"local:wire-check\\"]"}')
    expect(calls.some(call => call.startsWith('load_persisted_session {"periId":"peri-w","owner":{"profileId":"p","agentId":"a","localSessionId":"local:wire-check"}'))).toBe(true)
  })

  it('并发采集失败各带独立错误态（replay 抛错）', async () => {
    const storage = memoryStorage({ 'pylon-msgs-sabc7': JSON.stringify({ version: 1, messages: [] }) })
    const transport = recordingTransport(async (cmd) => {
      if (cmd === 'evt_list') return { events: [], nextBeforeSequence: null }
      if (cmd === 'evt_revision') return 0
      throw new Error('backend down')
    })
    const artifact = await exportThreeSourcesForSession({
      sessionId: 'sabc7',
      transport,
      storage,
      identity: { id: 'sabc7', profileId: 'p', agentId: 'a', source: 'local:sabc7', periId: 'peri-7' },
    })
    expect(artifact.sources.replay.loadOk).toBe(false)
    expect(artifact.sources.replay.loadError).toContain('backend down')
    expect(artifact.sources.sqlite.revision).toBe(0)
    expect(artifact.summary.gaps.some(gap => gap.startsWith('replay: load_persisted_session 失败'))).toBe(true)
  })
})

// ── download 辅助（非浏览器 no-op，不抛） ───────────────────────────────────

describe('downloadThreeSourceArtifact', () => {
  it('非浏览器环境 no-op（不抛）', async () => {
    const { downloadThreeSourceArtifact } = await import('../threeSourceExport')
    const artifact = buildThreeSourceArtifact({
      sessionId: 'sabc1',
      identity: null,
      localStorage: collectLocalStorageSection('sabc1', memoryStorage({})),
      sqlite: { sessionId: 'sabc1', revision: 0, rows: [], rowCount: 0, pages: 0, truncated: false },
      replay: { source: null, periId: null, loadOk: false, loadError: null, response: null, envelopeCount: 0, envelopes: [], likelyTruncated: false, normalized: null },
    })
    expect(() => downloadThreeSourceArtifact(artifact)).not.toThrow()
    expect(vi.isMockFunction(downloadThreeSourceArtifact)).toBe(false)
  })
})
